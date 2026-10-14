import prisma from '@/lib/prisma';

const ERROR_MAX_LENGTH = 400;
const MODEL_MAX_LENGTH = 200;

export interface ModelRequestRecord {
	userId: string;
	model: string;
	statusCode: number;
	durationMs: number;
	error?: string | null;
	routedFrom?: string | null;
	requestId?: string;
	requestedModel?: string;
	operation?: 'chat' | 'image';
	source?: string;
	region?: string;
}

function compactError(error: string | null | undefined): string | null {
	if (!error) {
		return null;
	}
	const compact = error.replace(/\s+/g, ' ').trim();
	if (!compact) {
		return null;
	}
	return compact.length > ERROR_MAX_LENGTH ? `${compact.slice(0, ERROR_MAX_LENGTH - 1)}…` : compact;
}

/** Persists a completion attempt. A logging failure must not fail the user's request. */
export async function recordModelRequest(input: ModelRequestRecord): Promise<void> {
	try {
		await prisma.modelRequest.create({
			data: {
				userId: input.userId,
				model: input.model.slice(0, MODEL_MAX_LENGTH) || 'unknown',
				statusCode: input.statusCode,
				durationMs: Math.max(0, Math.round(input.durationMs)),
				error: compactError(input.error),
				routedFrom: input.routedFrom ? input.routedFrom.slice(0, MODEL_MAX_LENGTH) : null,
				requestId: input.requestId, requestedModel: input.requestedModel?.slice(0, MODEL_MAX_LENGTH),
				operation: input.operation, source: input.source, region: input.region,
			},
		});
	} catch (error) {
		console.error('Failed to record model request:', error);
	}
}
