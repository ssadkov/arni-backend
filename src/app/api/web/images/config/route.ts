import { NextRequest } from 'next/server';
import { BudgetError } from '@/lib/budget';
import { applyMarkup, markupPercentFor } from '@/lib/billingMarkup';
import { imageCatalogPublic } from '@/lib/imageGeneration';
import prisma from '@/lib/prisma';
import { webJson, webOptions } from '@/lib/webCors';
import { webUser } from '@/lib/webSession';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

/** Browser-facing catalog mirror of GET /api/images/generations (CORS for chat.arnion.kz). */
export async function GET(req: NextRequest) {
	try {
		const { user } = await webUser(req);
		const budget = await prisma.accountBudget.findUnique({ where: { userId: user.id } });
		const enabled = process.env.ARNI_IMAGE_GENERATION_ENABLED === 'true'
			&& !!process.env.AWS_BEARER_TOKEN_BEDROCK_IMAGES
			&& !!budget?.enabled
			&& budget.validUntil > new Date();
		const catalog = imageCatalogPublic();
		const models = await Promise.all(catalog.models.map(async model => {
			const percent = await markupPercentFor({ source: 'bedrock', model: model.id, operation: 'image' });
			return { ...model, costMicros: applyMarkup(model.costMicros, percent) };
		}));
		const defaultModel = models.find(model => model.id === catalog.default_model) ?? models[0];
		return webJson(req, { enabled, ...catalog, costMicros: defaultModel?.costMicros ?? catalog.costMicros, models });
	} catch (error) {
		const known = error instanceof BudgetError;
		return webJson(
			req,
			{ error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Не удалось загрузить настройки.' } },
			known ? error.status : 500,
		);
	}
}
