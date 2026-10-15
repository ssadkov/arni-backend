import { createHash } from 'node:crypto';
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import prisma from '@/lib/prisma';
import { BudgetError, reserveBudget, settleBudget } from './budget';
import { client } from './llm/bedrock';
import { recordModelRequest } from './modelRequests';

// AWS offer verified 2026-10-14. One image per invocation, USD micro-units.
export const IMAGE_MODEL = 'stability.stable-image-core-v1:1';
export const IMAGE_REGION = 'us-west-2';
export const IMAGE_PRICE_MICROS = 40_000;
export const IMAGE_RATIOS = ['16:9', '1:1', '21:9', '2:3', '3:2', '4:5', '5:4', '9:16', '9:21'];

export function imageRequest(body: unknown) {
	const input = body as Record<string, unknown>;
	if (!input || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 10_000
		|| input.model != null && input.model !== IMAGE_MODEL
		|| input.n != null && input.n !== 1
		|| input.aspect_ratio != null && !IMAGE_RATIOS.includes(String(input.aspect_ratio))) {
		throw new BudgetError('invalid_image_request', 'Укажите описание до 10 000 символов, одну картинку и допустимые пропорции.', 400);
	}
	return { prompt: input.prompt.trim(), aspect_ratio: String(input.aspect_ratio || '16:9'), output_format: 'png' };
}

async function result(row: { id: string; model: string; status: string; errorCode: string | null }) {
	if (row.status === 'pending') { throw new BudgetError('image_in_progress', 'Генерация уже запущена. Проверьте результат по тому же ключу; новая оплата не списывается.', 409); }
	if (row.status !== 'succeeded') { throw new BudgetError(row.errorCode || 'image_failed', 'Этот запрос завершился без изображения. Не запускайте его автоматически повторно; проверьте доступ и журнал расходов.', 409); }
	const usage = await prisma.usageLog.findUnique({ where: { requestId: row.id }, select: { costMicros: true } });
	return { id: row.id, model: row.model, costMicros: usage?.costMicros ?? null, data: [{ url: `/api/images/${row.id}`, mime_type: 'image/png' }] };
}

export async function generateImage(userId: string, requestKey: string, body: unknown) {
	if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey)) { throw new BudgetError('idempotency_key_required', 'Нужен Idempotency-Key длиной 16–100 символов.', 400); }
	const input = imageRequest(body);
	const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
	const previous = await prisma.mediaGeneration.findUnique({ where: { userId_requestKey: { userId, requestKey } } });
	if (previous) {
		if (previous.payloadHash !== payloadHash) { throw new BudgetError('idempotency_conflict', 'Ключ уже использован с другим описанием.', 409); }
		return result(previous);
	}
	if (process.env.ARNI_IMAGE_GENERATION_ENABLED !== 'true' || !process.env.AWS_BEARER_TOKEN_BEDROCK_IMAGES) {
		throw new BudgetError('image_generation_disabled', 'Генерация изображений пока не включена. Администратору нужно активировать Stable Image Core в AWS us-west-2 и настроить backend.', 503);
	}
	// Budget is mandatory: free chat access never enables paid image generation.
	if (!await prisma.accountBudget.findUnique({ where: { userId } })) { throw new BudgetError('image_budget_required', 'Для генерации изображений нужен выданный бюджет API.', 403); }
	let row;
	try { row = await prisma.mediaGeneration.create({ data: { userId, requestKey, payloadHash, model: IMAGE_MODEL, region: IMAGE_REGION } }); }
	catch (error) {
		if ((error as { code?: string }).code !== 'P2002') { throw error; }
		const existing = await prisma.mediaGeneration.findUniqueOrThrow({ where: { userId_requestKey: { userId, requestKey } } });
		if (existing.payloadHash !== payloadHash) { throw new BudgetError('idempotency_conflict', 'Ключ уже использован с другим описанием.', 409); }
		return result(existing);
	}
	const startedAt = Date.now();
	let reservationId: string | undefined;
	let dispatched = false;
	try {
		const reservation = await reserveBudget(userId, IMAGE_MODEL, 'bedrock', IMAGE_PRICE_MICROS, 0, 0,
			{ requestId: row.id, requestedModel: IMAGE_MODEL, operation: 'image', region: IMAGE_REGION, unitPriceMicros: IMAGE_PRICE_MICROS, imageCount: 1 });
		reservationId = reservation.id;
		await prisma.mediaGeneration.update({ where: { id: row.id }, data: { reservationId } });
		// No SDK retries: an ambiguous timeout can still be a billed invocation.
		const runtime = client(IMAGE_REGION, 1, process.env.AWS_BEARER_TOKEN_BEDROCK_IMAGES);
		dispatched = true;
		const output = await runtime.send(new InvokeModelCommand({ modelId: IMAGE_MODEL, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(input) }),
			{ abortSignal: AbortSignal.timeout(180_000) }).finally(() => runtime.destroy());
		const data = JSON.parse(new TextDecoder().decode(output.body)) as { images?: string[]; seeds?: number[]; finish_reasons?: Array<string | null> };
		if (data.finish_reasons?.some(reason => reason != null) || data.images?.length !== 1 || typeof data.images[0] !== 'string') {
			throw new BudgetError('image_filtered', 'Модель не вернула изображение. Запрос не повторяется автоматически.', 422);
		}
		const image = Buffer.from(data.images[0], 'base64');
		if (image.length > 3_000_000 || image.length < 24 || !image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
			throw new BudgetError('invalid_image_response', 'Модель вернула неподдерживаемый файл.', 502);
		}
		// Store the artifact before settlement so a lost HTTP response can be recovered safely.
		await prisma.mediaGeneration.update({ where: { id: row.id }, data: { image, mimeType: 'image/png', seed: data.seeds?.[0]?.toString() } });
		await settleBudget(reservationId, { prompt_tokens: 0, completion_tokens: 0 });
		const saved = await prisma.mediaGeneration.update({ where: { id: row.id }, data: { status: 'succeeded' } });
		await recordModelRequest({ userId, model: IMAGE_MODEL, requestId: row.id, requestedModel: IMAGE_MODEL, source: 'bedrock', region: IMAGE_REGION, operation: 'image', statusCode: 200, durationMs: Date.now() - startedAt });
		return result(saved);
	} catch (error) {
		const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
		const rejected = !dispatched || status != null && status >= 400 && status < 500 && status !== 408;
		if (reservationId) { await settleBudget(reservationId, null, rejected); }
		const code = error instanceof BudgetError ? error.code : status === 403 ? 'image_access_denied' : 'image_upstream_failed';
		await prisma.mediaGeneration.update({ where: { id: row.id }, data: { status: 'failed', errorCode: code } });
		await recordModelRequest({ userId, model: IMAGE_MODEL, requestId: row.id, requestedModel: IMAGE_MODEL, source: 'bedrock', region: IMAGE_REGION, operation: 'image', statusCode: status || (error instanceof BudgetError ? error.status : 502), durationMs: Date.now() - startedAt, error: code });
		if (error instanceof BudgetError) { throw error; }
		throw new BudgetError(code, status === 403 ? 'AWS не открыл Stable Image Core. Активируйте модель в регионе us-west-2.' : 'Генерация не завершилась. Проверьте журнал расходов перед новым запросом.', status === 403 ? 403 : 502);
	}
}
