import { NextRequest, NextResponse } from 'next/server';
import { trafficByModel, WATCHED_FREE_MODELS } from '@/lib/openRouterStatus';
import { decryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import { modelIdForUser, modelsAllowedForUser } from '@/lib/llm/bedrockAccess';
import { FREE_MAX_OUTPUT_TOKENS, MANAGED_MAX_OUTPUT_TOKENS, managedModelMetadata } from '@/lib/llm/modelCapabilities';
import { routerCatalog, routerCacheMode, zeroPrice, type RouterModel } from '@/lib/llm/openRouterCatalog';
import { webCorsHeaders, webOptions } from '@/lib/webCors';
import { billingRates } from '@/lib/billingCurrency';
import { markedPerMillion, markupTable, percentFromTable } from '@/lib/billingMarkup';
import { geminiPickerAllowed, geminiPickerCatalog } from '@/lib/llm/gemini';
import { paidDeepSeekRow, TRIAL_MAX_OUTPUT_TOKENS, trialAllowed, trialCatalogRow } from '@/lib/llm/trialModel';
import { defaultFreeModelId, isRecommendedModel, pickBedrockModels, pickFreeModels } from '@/lib/modelPicker';
import { bonusSnapshot, deepSeekBonus } from '@/lib/deepSeekBonus';

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
		let gemini: Record<string, unknown>[] = [];
		let trial = false;
		let bonusAvailable = false;
		const auth = req.headers.get('authorization');
		if (auth?.startsWith('Bearer ')) {
			let userId: string;
			try { userId = (await decryptJWT(auth.slice(7))).userId; }
			catch { return NextResponse.json({ error: 'Invalid Token' }, { status: 401, headers: webCorsHeaders(req) }); }
			const [user, wallet] = await Promise.all([
				prisma.user.findUnique({ where: { id: userId }, include: { budget: true } }), deepSeekBonus(userId),
			]);
			if (!user || user.isBanned) { return NextResponse.json({ error: 'Account is blocked' }, { status: 403, headers: webCorsHeaders(req) }); }
			managed = Boolean(user.budget);
			bonusAvailable = wallet !== null && bonusSnapshot(wallet).balanceMicros > 0;
			// Google's free tier is offered to named accounts only (GEMINI_PICKER_EMAILS).
			if (geminiPickerAllowed(user.email)) { gemini = geminiPickerCatalog(FREE_MAX_OUTPUT_TOKENS); }
			// Paid DeepSeek test for named accounts only (DEEPSEEK_TRIAL_EMAILS).
			trial = trialAllowed(user.email);
			const markups = managed || trial ? await markupTable() : new Map<string, number>();
			if (managed) {
				const allowed = await modelsAllowedForUser(userId);
				const selected = await modelIdForUser(userId, user.bedrockModelId);
				const priced = allowed.filter(model => model.inputPerMillion != null && model.outputPerMillion != null);
				// Paid models are Bedrock only (AWS credits); a short curated list keeps the picker readable.
				bedrock = pickBedrockModels(priced, selected).map(model => {
					const percent = percentFromTable(markups, { source: 'bedrock', model: model.id });
					return {
					// Never the default: a paid model is used only when the user picks it.
					id: model.id, name: model.name, arni_default: false, arni_recommended: isRecommendedModel(model.id),
					arni_provider: 'bedrock', supported_parameters: ['tools'], ...managedModelMetadata(model.id),
					pricing: { prompt: String(markedPerMillion(model.inputPerMillion!, percent) / 1_000_000), completion: String(markedPerMillion(model.outputPerMillion!, percent) / 1_000_000) },
				}; });
			}
		}
		// A provider outage must not remove otherwise available Bedrock models.
		let router: RouterModel[];
		try { router = await routerCatalog(); }
		catch (error) { if (!bedrock.length) { throw error; } router = []; }
		// Paid OpenRouter models are not offered: Arni pays for them in cash, not AWS credits.
		const free = pickFreeModels(router.filter(model => zeroPrice(model)));
		// Every listed free model gets a light, so the picker can mark one that is down or refused.
		const [lights, rates] = await Promise.all([trafficByModel([...WATCHED_FREE_MODELS, ...free.map(model => model.id)]), billingRates()]);
		const defaultId = defaultFreeModelId(free.map(model => ({ id: model.id, light: lights.get(model.id) })));
		const models = free.map(model => ({
			...model, arni_provider: 'openrouter', arni_free: zeroPrice(model), arni_cache: routerCacheMode(model.id), arni_default: model.id === defaultId,
			top_provider: { ...model.top_provider, max_completion_tokens: outputLimit(model) },
			arni_traffic: lights.get(model.id), arni_recommended: isRecommendedModel(model.id),
		}));
		const trialRow = trial && !bonusAvailable ? trialCatalogRow(router, TRIAL_MAX_OUTPUT_TOKENS) : null;
		const paidBase = managed || bonusAvailable ? paidDeepSeekRow(router, TRIAL_MAX_OUTPUT_TOKENS) : null;
		const paidPercent = paidBase && managed ? percentFromTable(await markupTable(), { source: 'openrouter', model: String(paidBase.id) }) : 0;
		const marked = (value: unknown) => {
			const amount = Number(value);
			return Number.isFinite(amount) ? String(markedPerMillion(amount * 1_000_000, paidPercent) / 1_000_000) : value;
		};
		const paidRow = paidBase?.pricing ? { ...paidBase, pricing: { ...paidBase.pricing, prompt: marked(paidBase.pricing.prompt), completion: marked(paidBase.pricing.completion) } } : paidBase;
		return NextResponse.json({ arni_managed: managed || bonusAvailable, billingRates: rates,
			data: [...(trialRow ? [trialRow] : []), ...(paidRow ? [{ ...paidRow, arni_bonus: bonusAvailable }] : []), ...bedrock, ...models, ...gemini] }, {
			headers: { 'Cache-Control': auth ? 'private, no-store' : 'public, s-maxage=60, stale-while-revalidate=300', ...webCorsHeaders(req) },
		});
	} catch (error) {
		console.error('Model catalog failed:', error instanceof Error ? error.name : 'unknown');
		return NextResponse.json({ error: 'Failed to load models' }, { status: 503, headers: webCorsHeaders(req) });
	}
}
