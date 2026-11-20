import { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { BudgetError, budgetSnapshot } from '@/lib/budget';
import { billingRates, formatBillingRub } from '@/lib/billingCurrency';
import { checkoutConfigured } from '@/lib/billingPayment';
import { applyMarkup, markedPerMillion, markupTable, percentFromTable } from '@/lib/billingMarkup';
import { IMAGE_MODELS } from '@/lib/imageModels';
import { modelsAllowedForUser } from '@/lib/llm/bedrockAccess';
import { routerCatalog } from '@/lib/llm/openRouterCatalog';
import { PAID_DEEPSEEK_MODEL } from '@/lib/llm/trialModel';
import { webJson, webOptions } from '@/lib/webCors';
import { webUser } from '@/lib/webSession';

export const dynamic = 'force-dynamic';

/** Paid DeepSeek is billed from the account budget at the OpenRouter price plus markup. Catalog failure leaves the other rows. */
async function openRouterTariffs(markups: Map<string, number>, rubRate: number | null) {
	try {
		const row = (await routerCatalog()).find(model => model.id === PAID_DEEPSEEK_MODEL);
		const prompt = Number(row?.pricing?.prompt);
		const completion = Number(row?.pricing?.completion);
		if (!row || !Number.isFinite(prompt) || !Number.isFinite(completion)) { return []; }
		const percent = percentFromTable(markups, { source: 'openrouter', model: row.id });
		const price = (perToken: number) => {
			const amount = Math.round(markedPerMillion(perToken * 1_000_000, percent) * 1_000_000);
			return { text: formatBillingRub(amount, rubRate), amount };
		};
		const input = price(prompt);
		const output = price(completion);
		return [{
			id: row.id, name: row.name, provider: 'OpenRouter',
			input: input.text, output: output.text, inputAmount: input.amount, outputAmount: output.amount,
		}];
	} catch (error) {
		console.error('OpenRouter tariff is unavailable:', error instanceof Error ? error.name : 'unknown');
		return [];
	}
}

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function GET(req: NextRequest) {
	try {
		const { user } = await webUser(req);
		const [budget, rates, markups, entries, usage, models] = await Promise.all([
			prisma.accountBudget.findUnique({ where: { userId: user.id } }),
			billingRates(),
			markupTable(),
			prisma.budgetEntry.findMany({
				where: { userId: user.id, kind: { in: ['grant', 'payment', 'payment_refund'] } },
				orderBy: { createdAt: 'desc' }, take: 30,
				select: { id: true, kind: true, amountMicros: true, rubKopecks: true, note: true, createdAt: true },
			}),
			prisma.usageLog.findMany({
				where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 30,
				select: { id: true, model: true, createdAt: true, costMicros: true, providerCostMicros: true, promptTokens: true, completionTokens: true },
			}),
			modelsAllowedForUser(user.id),
		]);
		const tokenPrice = (perMillion: number, percent: number) => {
			const amount = Math.round(markedPerMillion(perMillion, percent) * 1_000_000);
			return { text: formatBillingRub(amount, rates.RUB), amount };
		};
		const tariffs = [
			...models.filter(model => model.inputPerMillion != null && model.outputPerMillion != null).map(model => {
				const percent = percentFromTable(markups, { source: 'bedrock', model: model.id });
				const input = tokenPrice(model.inputPerMillion!, percent);
				const output = tokenPrice(model.outputPerMillion!, percent);
				return { id: model.id, name: model.name, provider: 'Bedrock', input: input.text, output: output.text, inputAmount: input.amount, outputAmount: output.amount };
			}),
			...await openRouterTariffs(markups, rates.RUB),
			...IMAGE_MODELS.map(model => {
				const percent = percentFromTable(markups, { source: 'bedrock', model: model.id, operation: 'image' });
				const amount = applyMarkup(model.costMicros, percent);
				return {
					id: model.id, name: model.name, provider: 'Изображения',
					input: null, output: formatBillingRub(amount, rates.RUB), inputAmount: null, outputAmount: amount,
				};
			}),
		];
		return webJson(req, {
			rates, checkoutReady: checkoutConfigured(),
			budget: budget ? { ...budgetSnapshot(budget), limitsEnabled: budget.limitsEnabled } : null,
			entries, usage, tariffs,
		});
	} catch (error) {
		const known = error instanceof BudgetError;
		return webJson(req, { error: known ? error.message : 'Не удалось открыть биллинг.' }, known ? error.status : 500);
	}
}
