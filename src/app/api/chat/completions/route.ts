import { NextRequest, NextResponse } from 'next/server';
import { decryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import {
  FREE_DAILY_STEP_LIMIT,
  freeStepHeaders,
  freeStepSnapshot,
  releaseFreeStep,
  reserveFreeStep,
  type FreeStepSnapshot,
} from '@/lib/freeSteps';

function freeLimitResponse(snapshot: FreeStepSnapshot) {
  return NextResponse.json({
    error: {
      code: 'free_daily_limit',
      message: `Дневной лимит бесплатных запросов исчерпан (${FREE_DAILY_STEP_LIMIT} шагов агента). Он обновится в ${snapshot.resetsAt.slice(11, 16)} UTC.`,
      freeSteps: snapshot,
    },
  }, {
    status: 429,
    headers: {
      ...freeStepHeaders(snapshot),
      'Retry-After': String(Math.max(1, Math.ceil((Date.parse(snapshot.resetsAt) - Date.now()) / 1000))),
    },
  });
}

export async function POST(req: NextRequest) {
  let reservedUserId: string | null = null;
  try {
    // 1. Авторизация
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = authHeader.split(' ')[1];
    let jwtPayload;
    try {
      jwtPayload = await decryptJWT(token);
    } catch (e) {
      return NextResponse.json({ error: 'Invalid Token' }, { status: 401 });
    }

    // 2. Получение пользователя и проверка баланса
    const user = await prisma.user.findUnique({
      where: { id: jwtPayload.userId },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (user.isBanned) {
      return NextResponse.json({ error: 'Account is blocked' }, { status: 403 });
    }

    // OpenRouter's :free variants do not spend Arni's paid-model allowance.
    const body = await req.json();
    const isFreeModel = typeof body.model === 'string' && body.model.endsWith(':free');

    // Платные модели — только в тарифе Pro. Пока его нет, клиент предлагает
    // записаться в лист ожидания (POST /api/waitlist).
    if (!isFreeModel && user.plan !== 'PRO') {
      return NextResponse.json({
        error: {
          code: 'pro_required',
          message: 'Эта модель будет доступна в тарифе Pro. Выберите бесплатную модель или нажмите «Сообщить о запуске», чтобы узнать, когда Pro откроется.',
        },
      }, { status: 402 });
    }

    if (!isFreeModel && user.tokenBalance <= 0) {
      return NextResponse.json({
        error: { code: 'insufficient_tokens', message: 'На балансе закончились токены для платных моделей.' },
      }, { status: 402 });
    }

    let freeSteps: FreeStepSnapshot | null = null;
    if (isFreeModel) {
      freeSteps = await reserveFreeStep(user.id);
      if (!freeSteps) {
        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        return freeLimitResponse(freeStepSnapshot(fresh ?? user));
      }
      reservedUserId = user.id;
    }

    // 3. Подготовка запроса для OpenRouter
    
    // Включаем встроенный подсчет токенов для стриминга (OpenAI совместимый параметр)
    if (body.stream && !body.stream_options) {
      body.stream_options = { include_usage: true };
    }

    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterApiKey) {
      if (reservedUserId) {
        await releaseFreeStep(reservedUserId);
        reservedUserId = null;
      }
      return NextResponse.json({ error: 'OpenRouter API Key not configured' }, { status: 500 });
    }

    // 4. Проксирование запроса
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openRouterApiKey}`,
        'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL || 'https://arni-code.com',
        'X-Title': 'Arni Code IDE',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (reservedUserId) {
        freeSteps = await releaseFreeStep(reservedUserId);
        reservedUserId = null;
      }
      return new NextResponse(errorText, {
        status: response.status,
        headers: freeSteps ? freeStepHeaders(freeSteps) : undefined,
      });
    }

    // Шаг уже зарезервирован: ответ OpenRouter принят, даже если поток оборвётся.
    reservedUserId = null;

    // 5. Обработка стриминга и перехват использования токенов
    if (body.stream) {
      let usageRecorded = false;
      const transformStream = new TransformStream({
        async transform(chunk, controller) {
          const text = new TextDecoder().decode(chunk);
          
          // Пытаемся найти блок usage, который OpenRouter пришлет в конце благодаря stream_options
          if (text.includes('"usage":')) {
            try {
              // text может содержать несколько SSE сообщений (data: {...}\n\ndata: {...})
              const lines = text.split('\n');
              for (const line of lines) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  const data = JSON.parse(line.slice(6));
                  if (!usageRecorded && data.usage && data.usage.total_tokens) {
                    const promptTokens = data.usage.prompt_tokens || 0;
                    const completionTokens = data.usage.completion_tokens || 0;

                    // Записываем списание и историю вместе до завершения потока.
                    if (!isFreeModel) {
                      await prisma.$transaction([
                        prisma.user.update({
                          where: { id: user.id },
                          data: { tokenBalance: { decrement: promptTokens + completionTokens } },
                        }),
                        prisma.usageLog.create({
                          data: { userId: user.id, model: body.model || 'unknown', promptTokens, completionTokens },
                        }),
                      ]);
                    } else {
                      await prisma.usageLog.create({
                        data: { userId: user.id, model: body.model || 'unknown', promptTokens, completionTokens },
                      });
                    }
                    usageRecorded = true;
                  }
                }
              }
            } catch (e) {
              console.error('Failed to parse usage chunk:', e);
            }
          }
          
          // Пропускаем чанк дальше к клиенту
          controller.enqueue(chunk);
        }
      });

      return new NextResponse(response.body?.pipeThrough(transformStream), {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...(freeSteps ? freeStepHeaders(freeSteps) : {}),
        },
      });
    }

    // 6. Обработка обычного (не потокового) запроса
    const json = await response.json();
    if (json.usage) {
      const promptTokens = json.usage.prompt_tokens || 0;
      const completionTokens = json.usage.completion_tokens || 0;
      
      const usageData = { userId: user.id, model: body.model || 'unknown', promptTokens, completionTokens };
      if (isFreeModel) {
        await prisma.usageLog.create({ data: usageData });
      } else {
        await prisma.$transaction([
          prisma.user.update({
            where: { id: user.id },
            data: { tokenBalance: { decrement: promptTokens + completionTokens } },
          }),
          prisma.usageLog.create({ data: usageData }),
        ]);
      }
    }

    return NextResponse.json(json, {
      headers: freeSteps ? freeStepHeaders(freeSteps) : undefined,
    });

  } catch (error) {
    if (reservedUserId) {
      try {
        await releaseFreeStep(reservedUserId);
      } catch (releaseError) {
        console.error('Failed to release free step:', releaseError);
      }
    }
    console.error('Chat completions error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
