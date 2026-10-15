import { NextRequest, NextResponse } from 'next/server';
import { trafficByModel, WATCHED_FREE_MODELS } from '@/lib/openRouterStatus';
import { decryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import { modelIdForUser, modelsAllowedForUser } from '@/lib/llm/bedrockAccess';
import { managedModelMetadata } from '@/lib/llm/modelCapabilities';
import { routerCatalog, routerCacheMode, zeroPrice, type RouterModel } from '@/lib/llm/openRouterCatalog';

export async function GET(req: NextRequest) {
	try {
		let managed = false;
		let bedrock: Record<string, unknown>[] = [];
		const auth = req.headers.get('authorization');
		if (auth?.startsWith('Bearer ')) {
			let userId: string;
			try { userId = (await decryptJWT(auth.slice(7))).userId; }
			catch { return NextResponse.json({ error: 'Invalid Token' }, { status: 401 }); }
			const user = await prisma.user.findUnique({ where: { id: userId }, include: { budget: true } });
			if (!user || user.isBanned) { return NextResponse.json({ error: 'Account is blocked' }, { status: 403 }); }
			managed = Boolean(user.budget);
			if (managed) {
				const allowed = await modelsAllowedForUser(userId);
				const selected = await modelIdForUser(userId, user.bedrockModelId);
				bedrock = allowed.filter(model => model.inputPerMillion != null && model.outputPerMillion != null).map(model => ({
					id: model.id, name: model.name, arni_default: user.llmProvider === 'BEDROCK' && model.id === selected,
					arni_provider: 'bedrock', supported_parameters: ['tools'], ...managedModelMetadata(model.id),
					pricing: { prompt: String(model.inputPerMillion! / 1_000_000), completion: String(model.outputPerMillion! / 1_000_000) },
				}));
			}
		}
		// A provider outage must not remove otherwise available Bedrock models.
		let router: RouterModel[];
		try { router = await routerCatalog(); }
		catch (error) { if (!bedrock.length) { throw error; } router = []; }
		const lights = await trafficByModel(WATCHED_FREE_MODELS);
		const models = router.filter(model => managed ? model.architecture?.input_modalities?.includes('text') : zeroPrice(model)).map(model => ({
			...model, arni_provider: 'openrouter', arni_free: zeroPrice(model), arni_cache: routerCacheMode(model.id),
			top_provider: { ...model.top_provider, max_completion_tokens: Math.min(model.top_provider?.max_completion_tokens || 4096, 4096) },
			arni_traffic: lights.get(model.id),
		}));
		return NextResponse.json({ arni_managed: managed, data: [...bedrock, ...models] }, {
			headers: { 'Cache-Control': auth ? 'private, no-store' : 'public, s-maxage=60, stale-while-revalidate=300' },
		});
	} catch (error) {
		console.error('Model catalog failed:', error instanceof Error ? error.name : 'unknown');
		return NextResponse.json({ error: 'Failed to load models' }, { status: 503 });
	}
}
