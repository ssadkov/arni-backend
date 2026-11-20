import { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { BudgetError, budgetSnapshot } from '@/lib/budget';
import { billingRates, formatBillingRub } from '@/lib/billingCurrency';
import { checkoutConfigured } from '@/lib/billingPayment';
import { markedPerMillion, markupTable, percentFromTable } from '@/lib/billingMarkup';
import { IMAGE_MODELS } from '@/lib/imageModels';
import { modelsAllowedForUser } from '@/lib/llm/bedrockAccess';
import { webJson, webOptions } from '@/lib/webCors';
import { webUser } from '@/lib/webSession';

export const dynamic = 'force-dynamic';

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
		const price = (perMillion: number | null, percent: number) => perMillion == null ? null : {
			provider: formatBillingRub(perMillion * 1_000_000, rates.RUB),
			user: formatBillingRub(markedPerMillion(perMillion, percent) * 1_000_000, rates.RUB),
		};
		const tariffs = [
			...models.filter(model => model.inputPerMillion != null && model.outputPerMillion != null).map(model => {
				const percent = percentFromTable(markups, { source: 'bedrock', model: model.id });
				return { id: model.id, name: model.name, provider: 'Bedrock', percent, input: price(model.inputPerMillion, percent), output: price(model.outputPerMillion, percent) };
			}),
			...IMAGE_MODELS.map(model => {
				const percent = percentFromTable(markups, { source: 'bedrock', model: model.id, operation: 'image' });
				return { id: model.id, name: model.name, provider: 'Изображения', percent, unit: {
					provider: formatBillingRub(model.costMicros, rates.RUB), user: formatBillingRub(Math.round(model.costMicros * (100 + percent) / 100), rates.RUB),
				} };
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
