import { NextRequest, NextResponse } from 'next/server';
import { trafficByModel, WATCHED_FREE_MODELS } from '@/lib/openRouterStatus';
import { decryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import { modelIdForUser, modelsAllowedForUser } from '@/lib/llm/bedrockAccess';
import { resolveLlmProvider } from '@/lib/llm/provider';
import { supportsScreenshots } from '@/lib/llm/vision';

// OpenRouter отклоняет запросы из РФ («Access denied by security policy»),
// поэтому клиент берёт список моделей здесь, а не напрямую с openrouter.ai.
// Список публичный и нужен до входа, так что авторизация не требуется.
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models?supported_parameters=tools';

// В первой версии платные модели доступны только в тарифе Pro, а его ещё нет:
// в выбор попадают только бесплатные варианты OpenRouter (`:free`).
function isFreeModel(model: { id?: unknown }): boolean {
  return typeof model.id === 'string' && model.id.endsWith(':free');
}

export async function GET(req: NextRequest) {
  try {
    let managed = false;
    const auth = req.headers.get('authorization');
    if (auth?.startsWith('Bearer ')) {
      let userId: string;
      try { userId = (await decryptJWT(auth.slice(7))).userId; }
      catch { return NextResponse.json({ error: 'Invalid Token' }, { status: 401 }); }
      const user = await prisma.user.findUnique({ where: { id: userId }, include: { budget: true } });
      if (!user || user.isBanned) { return NextResponse.json({ error: 'Account is blocked' }, { status: 403 }); }
      managed = Boolean(user.budget);
      if (managed && resolveLlmProvider(user.llmProvider) === 'bedrock') {
        const allowed = await modelsAllowedForUser(userId);
        const selected = await modelIdForUser(userId, user.bedrockModelId);
        // The account's model is server-controlled; don't advertise a different model.
        return NextResponse.json({ arni_managed: true, data: allowed.filter(model => model.id === selected).map(model => ({
          id: model.id, name: model.name, supported_parameters: ['tools'], context_length: 32768,
          top_provider: { context_length: 32768, max_completion_tokens: 4096 }, architecture: { input_modalities: supportsScreenshots(model.id) ? ['text', 'image'] : ['text'] },
        })) }, { headers: { 'Cache-Control': 'private, no-store' } });
      }
    }
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
    const models = Array.isArray(catalog?.data) ? catalog.data.filter((model: { id?: unknown; architecture?: { input_modalities?: string[] } }) =>
      managed ? model.architecture?.input_modalities?.includes('text') : isFreeModel(model)) : [];
    const lights = await trafficByModel(WATCHED_FREE_MODELS);
    for (const model of models) {
      if (managed) {
        model.architecture = { ...model.architecture, input_modalities: ['text'] };
        model.top_provider = { ...model.top_provider, max_completion_tokens: Math.min(model.top_provider?.max_completion_tokens || 4096, 4096) };
      }
      const light = typeof model.id === 'string' ? lights.get(model.id) : undefined;
      if (light) {
        model.arni_traffic = light;
      }
    }
    return new NextResponse(JSON.stringify({ ...catalog, data: models, arni_managed: managed }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Кэш CDN Vercel: свежий список раз в 15 минут, старый можно отдавать сутки,
        // пока OpenRouter недоступен.
        'Cache-Control': auth ? 'private, no-store' : 'public, s-maxage=900, stale-while-revalidate=86400',
      },
    });
  } catch (error) {
    console.error('OpenRouter models fetch failed:', error);
    return NextResponse.json({ error: 'Failed to load models' }, { status: 502 });
  }
}
