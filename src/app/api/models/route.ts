import { NextRequest, NextResponse } from 'next/server';
import { trafficByModel, WATCHED_FREE_MODELS } from '@/lib/openRouterStatus';
import { decryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import { modelIdForUser, modelsAllowedForUser } from '@/lib/llm/bedrockAccess';
import { FREE_MAX_OUTPUT_TOKENS, MANAGED_MAX_OUTPUT_TOKENS, managedModelMetadata } from '@/lib/llm/modelCapabilities';
import { routerCatalog, routerCacheMode, zeroPrice, type RouterModel } from '@/lib/llm/openRouterCatalog';
import { webCorsHeaders, webOptions } from '@/lib/webCors';
import { billingRates } from '@/lib/billingCurrency';
import { pickBedrockModels, pickFreeModels } from '@/lib/modelPicker';

function outputLimit(model: RouterModel): number {
	const limit = zeroPrice(model) ? FREE_MAX_OUTPUT_TOKENS : MANAGED_MAX_OUTPUT_TOKENS;
	return Math.min(model.top_provider?.max_completion_tokens || limit, limit);
}

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function GET(req: NextRequest) {
	try {
		let managed = false;
		let bedrock: Record<string, unknown>[] = [];
		const auth = req.headers.get('authorization');
		if (auth?.startsWith('Bearer ')) {
			let userId: string;
			try { userId = (await decryptJWT(auth.slice(7))).userId; }
			catch { return NextResponse.json({ error: 'Invalid Token' }, { status: 401, headers: webCorsHeaders(req) }); }
			const user = await prisma.user.findUnique({ where: { id: userId }, include: { budget: true } });
			if (!user || user.isBanned) { return NextResponse.json({ error: 'Account is blocked' }, { status: 403, headers: webCorsHeaders(req) }); }
			managed = Boolean(user.budget);
			if (managed) {
				const allowed = await modelsAllowedForUser(userId);
				const selected = await modelIdForUser(userId, user.bedrockModelId);
				const priced = allowed.filter(model => model.inputPerMillion != null && model.outputPerMillion != null);
				// Paid models are Bedrock only (AWS credits); a short curated list keeps the picker readable.
				bedrock = pickBedrockModels(priced, selected).map(model => ({
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
		const [lights, rates] = await Promise.all([trafficByModel(WATCHED_FREE_MODELS), billingRates()]);
		// Paid OpenRouter models are not offered: Arni pays for them in cash, not AWS credits.
		const models = pickFreeModels(router.filter(model => zeroPrice(model))).map(model => ({
			...model, arni_provider: 'openrouter', arni_free: zeroPrice(model), arni_cache: routerCacheMode(model.id),
			top_provider: { ...model.top_provider, max_completion_tokens: outputLimit(model) },
			arni_traffic: lights.get(model.id),
		}));
		return NextResponse.json({ arni_managed: managed, billingRates: rates, data: [...bedrock, ...models] }, {
			headers: { 'Cache-Control': auth ? 'private, no-store' : 'public, s-maxage=60, stale-while-revalidate=300', ...webCorsHeaders(req) },
		});
	} catch (error) {
		console.error('Model catalog failed:', error instanceof Error ? error.name : 'unknown');
		return NextResponse.json({ error: 'Failed to load models' }, { status: 503, headers: webCorsHeaders(req) });
	}
}
