import { NextRequest, NextResponse } from 'next/server';
import { decryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';

// Шаги агента на бесплатных моделях в сутки на пользователя. Один шаг —
// один запрос модели; задача вроде «Змейки» занимает 10–30 шагов. Лимит
// бережёт общую дневную квоту OpenRouter на :free-модели от одного человека.
const FREE_DAILY_STEP_LIMIT = 150;

/** Начало текущих суток UTC: в это время обнуляется и квота OpenRouter на :free. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function POST(req: NextRequest) {
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

    if (!isFreeModel && user.tokenBalance <= 0 && user.plan === 'FREE') {
      return NextResponse.json({ error: 'Insufficient tokens' }, { status: 402 });
    }

    if (isFreeModel) {
      const now = new Date();
      const dayStart = startOfUtcDay(now);
      const stepsToday = await prisma.usageLog.count({
        where: { userId: user.id, model: { endsWith: ':free' }, createdAt: { gte: dayStart } },
      });
      if (stepsToday >= FREE_DAILY_STEP_LIMIT) {
        const resetAt = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
        return NextResponse.json({
          error: {
            code: 'free_daily_limit',
            message: `Дневной лимит бесплатных запросов исчерпан (${FREE_DAILY_STEP_LIMIT} шагов агента). Он обновится в ${resetAt.toISOString().slice(11, 16)} UTC.`,
          },
        }, {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil((resetAt.getTime() - now.getTime()) / 1000)) },
        });
      }
    }

    // 3. Подготовка запроса для OpenRouter
    
    // Включаем встроенный подсчет токенов для стриминга (OpenAI совместимый параметр)
    if (body.stream && !body.stream_options) {
      body.stream_options = { include_usage: true };
    }

    const openRouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterApiKey) {
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
      return new NextResponse(errorText, { status: response.status });
    }

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

    return NextResponse.json(json);

  } catch (error) {
    console.error('Chat completions error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
