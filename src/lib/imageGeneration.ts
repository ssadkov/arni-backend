import { createHash } from 'node:crypto';
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import prisma from '@/lib/prisma';
import { BudgetError, reserveBudget, settleBudget } from './budget';
import { applyMarkup, markupPercentFor } from './billingMarkup';
import {
	BACKGROUND_REMOVAL,
	backgroundRemovalProblem,
	IMAGE_MODEL,
	IMAGE_PRICE_MICROS,
	IMAGE_RATIOS,
	IMAGE_REGION,
	imageCatalogPublic,
	imageModelCard,
	promptHasUnsupportedScript,
	type ImageModelCard,
} from './imageModels';
import { fitImagePng, isPng } from './imagePng';
import { client } from './llm/bedrock';
import { recordModelRequest } from './modelRequests';
import { requestClient } from './requestClient';

export {
	IMAGE_MODEL,
	IMAGE_PRICE_MICROS,
	IMAGE_RATIOS,
	IMAGE_REGION,
	imageCatalogPublic,
} from './imageModels';

export type ImageRequestInput = {
	model: string;
	prompt: string;
	aspect_ratio: string;
	output_format: 'png';
};

export function imageRequest(body: unknown): ImageRequestInput {
	const input = body as Record<string, unknown>;
	if (!input || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 10_000
		|| input.n != null && input.n !== 1
		|| input.aspect_ratio != null && !(IMAGE_RATIOS as readonly string[]).includes(String(input.aspect_ratio))) {
		throw new BudgetError('invalid_image_request', 'Укажите описание до 10 000 символов, одну картинку и допустимые пропорции.', 400);
	}
	let card: ImageModelCard;
	try {
		card = imageModelCard(typeof input.model === 'string' ? input.model : undefined);
	} catch {
		throw new BudgetError('invalid_image_request', 'Выберите модель из списка простых картинок или картинок с текстом.', 400);
	}
	return {
		model: card.id,
		prompt: input.prompt.trim(),
		aspect_ratio: String(input.aspect_ratio || '16:9'),
		output_format: 'png',
	};
}

function invokePayload(card: ImageModelCard, input: ImageRequestInput) {
	const payload: Record<string, string> = {
		prompt: input.prompt,
		aspect_ratio: input.aspect_ratio,
		output_format: input.output_format,
	};
	if (card.includeMode) {
		payload.mode = 'text-to-image';
	}
	return payload;
}

async function result(row: { id: string; model: string; status: string; errorCode: string | null }) {
	if (row.status === 'pending') { throw new BudgetError('image_in_progress', 'Генерация уже запущена. Проверьте результат по тому же ключу; новая оплата не списывается.', 409); }
	if (row.status !== 'succeeded') { throw new BudgetError(row.errorCode || 'image_failed', 'Этот запрос завершился без изображения. Не запускайте его автоматически повторно; проверьте доступ и журнал расходов.', 409); }
	const usage = await prisma.usageLog.findUnique({ where: { requestId: row.id }, select: { costMicros: true } });
	return { id: row.id, model: row.model, costMicros: usage?.costMicros ?? null, data: [{ url: `/api/images/${row.id}`, mime_type: 'image/png' }] };
}

/** One paid InvokeModel call that returns one PNG: a generation or an edit. */
type ImageJob = {
	model: string;
	modelName: string;
	costMicros: number;
	payloadHash: string;
	payload: Record<string, string>;
	/** Refuses the request once the feature is known to be on, before any money is reserved. */
	validate?: () => void;
};

/** `chatId` attributes the charge to the desktop chat, so its cost shows in "Последний чат". */
export async function generateImage(userId: string, requestKey: string, body: unknown, chatId?: string, reportedClient?: string | null) {
	assertRequestKey(requestKey);
	const input = imageRequest(body);
	const card = imageModelCard(input.model);
	return runImageJob(userId, requestKey, {
		model: card.id,
		modelName: card.modelName,
		costMicros: card.costMicros,
		payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
		payload: invokePayload(card, input),
		validate: () => {
			// Stability rejects Cyrillic prompts before billing us a useful image; stop before reserve/InvokeModel.
			if (promptHasUnsupportedScript(input.prompt)) {
				throw new BudgetError(
					'image_prompt_language',
					'Модели Stability сейчас отклоняют описание на русском. Перепишите prompt на английском — тогда генерация пройдёт без лишнего списания.',
					400,
				);
			}
		},
	}, chatId, reportedClient);
}

/** Returns the picture as a PNG with a transparent background, billed like a generation. */
export async function removeBackground(
	userId: string,
	requestKey: string,
	source: { bytes: Uint8Array; width: number; height: number },
	chatId?: string,
	reportedClient?: string | null,
) {
	assertRequestKey(requestKey);
	const problem = backgroundRemovalProblem(source.width, source.height);
	if (problem) { throw new BudgetError('invalid_image_size', problem, 400); }
	const { id, modelName, costMicros } = BACKGROUND_REMOVAL;
	return runImageJob(userId, requestKey, {
		model: id,
		modelName,
		costMicros,
		payloadHash: createHash('sha256').update(id).update(source.bytes).digest('hex'),
		payload: { image: Buffer.from(source.bytes).toString('base64'), output_format: 'png' },
	}, chatId, reportedClient);
}

function assertRequestKey(requestKey: string) {
	if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey)) { throw new BudgetError('idempotency_key_required', 'Нужен Idempotency-Key длиной 16–100 символов.', 400); }
}

async function runImageJob(userId: string, requestKey: string, job: ImageJob, chatId?: string, reportedClient?: string | null) {
	const app = requestClient(reportedClient);
	const { payloadHash } = job;
	const previous = await prisma.mediaGeneration.findUnique({ where: { userId_requestKey: { userId, requestKey } } });
	if (previous) {
		if (previous.payloadHash !== payloadHash) { throw new BudgetError('idempotency_conflict', 'Ключ уже использован с другим описанием.', 409); }
		return result(previous);
	}
	if (process.env.ARNI_IMAGE_GENERATION_ENABLED !== 'true' || !process.env.AWS_BEARER_TOKEN_BEDROCK_IMAGES) {
		throw new BudgetError('image_generation_disabled', 'Генерация изображений пока не включена. Администратору нужно активировать модели в AWS us-west-2 и настроить backend.', 503);
	}
	job.validate?.();
	// Budget is mandatory: free chat access never enables paid image generation.
	if (!await prisma.accountBudget.findUnique({ where: { userId } })) { throw new BudgetError('image_budget_required', 'Для работы с изображениями пополните баланс в аккаунте.', 403); }
	let row;
	try {
		row = await prisma.mediaGeneration.create({
			data: { userId, requestKey, payloadHash, model: job.model, region: IMAGE_REGION },
		});
	} catch (error) {
		if ((error as { code?: string }).code !== 'P2002') { throw error; }
		const existing = await prisma.mediaGeneration.findUniqueOrThrow({ where: { userId_requestKey: { userId, requestKey } } });
		if (existing.payloadHash !== payloadHash) { throw new BudgetError('idempotency_conflict', 'Ключ уже использован с другим описанием.', 409); }
		return result(existing);
	}
	const startedAt = Date.now();
	let reservationId: string | undefined;
	let dispatched = false;
	try {
		const markupPercent = await markupPercentFor({ source: 'bedrock', model: job.model, operation: 'image' });
		const reservation = await reserveBudget(userId, job.model, 'bedrock', applyMarkup(job.costMicros, markupPercent), 0, 0, {
			requestId: row.id,
			requestedModel: job.model,
			chatId,
			operation: 'image',
			region: IMAGE_REGION,
			unitPriceMicros: job.costMicros,
			imageCount: 1,
			client: app,
			markupPercent,
		});
		reservationId = reservation.id;
		await prisma.mediaGeneration.update({ where: { id: row.id }, data: { reservationId } });
		// No SDK retries: an ambiguous timeout can still be a billed invocation.
		const runtime = client(IMAGE_REGION, 1, process.env.AWS_BEARER_TOKEN_BEDROCK_IMAGES);
		dispatched = true;
		const output = await runtime.send(new InvokeModelCommand({
			modelId: job.model,
			contentType: 'application/json',
			accept: 'application/json',
			body: JSON.stringify(job.payload),
		}), { abortSignal: AbortSignal.timeout(180_000) }).finally(() => runtime.destroy());
		const data = JSON.parse(new TextDecoder().decode(output.body)) as {
			images?: string[];
			seeds?: number[];
			finish_reasons?: Array<string | null>;
		};
		const blocked = data.finish_reasons?.find(reason => reason != null) || null;
		if (blocked != null || data.images?.length !== 1 || typeof data.images[0] !== 'string') {
			const filter = typeof blocked === 'string' ? blocked : '';
			const languageHint = /prompt/i.test(filter)
				? ' Часто так бывает с неанглийским описанием — попробуйте английский prompt.'
				: '';
			throw new BudgetError(
				'image_filtered',
				`Модель ${job.modelName} не вернула изображение${filter ? ` (${filter})` : ''}. Запрос не повторяется автоматически.${languageHint}`,
				422,
			);
		}
		const raw = Buffer.from(data.images[0], 'base64');
		if (!isPng(raw)) {
			throw new BudgetError('invalid_image_response', 'Модель вернула неподдерживаемый файл.', 502);
		}
		let image: Buffer;
		try {
			image = await fitImagePng(raw);
		} catch {
			throw new BudgetError('invalid_image_response', 'Модель вернула слишком большой файл, который не удалось сжать.', 502);
		}
		// Store the artifact before settlement so a lost HTTP response can be recovered safely.
		await prisma.mediaGeneration.update({
			where: { id: row.id },
			data: { image, mimeType: 'image/png', seed: data.seeds?.[0]?.toString() },
		});
		await settleBudget(reservationId, { prompt_tokens: 0, completion_tokens: 0 });
		const saved = await prisma.mediaGeneration.update({ where: { id: row.id }, data: { status: 'succeeded' } });
		await recordModelRequest({
			userId,
			model: job.model,
			requestId: row.id,
			requestedModel: job.model,
			source: 'bedrock',
			region: IMAGE_REGION,
			operation: 'image',
			statusCode: 200,
			durationMs: Date.now() - startedAt,
			client: app,
		});
		return result(saved);
	} catch (error) {
		const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
		const rejected = !dispatched || status != null && status >= 400 && status < 500 && status !== 408;
		if (reservationId) { await settleBudget(reservationId, null, rejected); }
		const code = error instanceof BudgetError ? error.code : status === 403 ? 'image_access_denied' : status === 429 ? 'image_busy' : 'image_upstream_failed';
		await prisma.mediaGeneration.update({ where: { id: row.id }, data: { status: 'failed', errorCode: code } });
		await recordModelRequest({
			userId,
			model: job.model,
			requestId: row.id,
			requestedModel: job.model,
			source: 'bedrock',
			region: IMAGE_REGION,
			operation: 'image',
			statusCode: status || (error instanceof BudgetError ? error.status : 502),
			durationMs: Date.now() - startedAt,
			error: code,
			client: app,
		});
		if (error instanceof BudgetError) { throw error; }
		// AWS allows only a few image requests a minute for the whole account; a 4xx returns the reserve.
		if (status === 429) { throw new BudgetError(code, 'Сервис картинок сейчас занят. Деньги не списаны, повторите через минуту.', 429); }
		throw new BudgetError(
			code,
			status === 403
				? 'AWS не открыл доступ к модели изображений. Активируйте модель в регионе us-west-2.'
				: 'Генерация не завершилась. Проверьте журнал расходов перед новым запросом.',
			status === 403 ? 403 : 502,
		);
	}
}
