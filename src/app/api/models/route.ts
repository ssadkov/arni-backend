import { NextResponse } from 'next/server';

// OpenRouter отклоняет запросы из РФ («Access denied by security policy»),
// поэтому клиент берёт список моделей здесь, а не напрямую с openrouter.ai.
// Список публичный и нужен до входа, так что авторизация не требуется.
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models?supported_parameters=tools';

// В первой версии платные модели доступны только в тарифе Pro, а его ещё нет:
// в выбор попадают только бесплатные варианты OpenRouter (`:free`).
function isFreeModel(model: { id?: unknown }): boolean {
  return typeof model.id === 'string' && model.id.endsWith(':free');
}

export async function GET() {
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: {
        'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL || 'https://arni-code.com',
        'X-Title': 'Arni Code IDE',
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      console.error('OpenRouter models error:', response.status, await response.text());
      return NextResponse.json({ error: 'Failed to load models' }, { status: 502 });
    }

    const catalog = await response.json();
    const models = Array.isArray(catalog?.data) ? catalog.data.filter(isFreeModel) : [];
    return new NextResponse(JSON.stringify({ ...catalog, data: models }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Кэш CDN Vercel: свежий список раз в 15 минут, старый можно отдавать сутки,
        // пока OpenRouter недоступен.
        'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=86400',
      },
    });
  } catch (error) {
    console.error('OpenRouter models fetch failed:', error);
    return NextResponse.json({ error: 'Failed to load models' }, { status: 502 });
  }
}
