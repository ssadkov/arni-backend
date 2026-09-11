import { NextRequest, NextResponse } from 'next/server';
import { decryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';

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

    if (user.tokenBalance <= 0 && user.plan === 'FREE') {
      return NextResponse.json({ error: 'Insufficient tokens' }, { status: 402 });
    }

    // 3. Подготовка запроса для OpenRouter
    const body = await req.json();
    
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
                  if (data.usage && data.usage.total_tokens) {
                    const promptTokens = data.usage.prompt_tokens || 0;
                    const completionTokens = data.usage.completion_tokens || 0;
                    
                    // Асинхронно списываем токены в БД
                    prisma.user.update({
                      where: { id: user.id },
                      data: { tokenBalance: { decrement: promptTokens + completionTokens } },
                    }).catch(console.error);

                    prisma.usageLog.create({
                      data: {
                        userId: user.id,
                        model: body.model || 'unknown',
                        promptTokens,
                        completionTokens,
                      }
                    }).catch(console.error);
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
      
      await prisma.user.update({
        where: { id: user.id },
        data: { tokenBalance: { decrement: promptTokens + completionTokens } },
      });

      await prisma.usageLog.create({
        data: {
          userId: user.id,
          model: body.model || 'unknown',
          promptTokens,
          completionTokens,
        }
      });
    }

    return NextResponse.json(json);

  } catch (error) {
    console.error('Chat completions error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
