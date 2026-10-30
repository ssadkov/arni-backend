import {
	BedrockRuntimeClient,
	ConverseCommand,
	ConverseStreamCommand,
	CountTokensCommand,
	type ContentBlock,
	type Message,
	type SystemContentBlock,
	type Tool,
	type ToolConfiguration,
	type TokenUsage,
} from '@aws-sdk/client-bedrock-runtime';
import { decodeScreenshot, screenshotCount, supportsScreenshots } from './vision';
import { BudgetError } from '@/lib/budget';
import { modelCapabilities } from './modelCapabilities';
import { usageCostMicros, type ReportedUsage } from '../budgetPolicy';

type CatalogPrice = { inputPerMillion: number | null; outputPerMillion: number | null };

type ChatToolCall = {
	id?: string;
	function?: { name?: string; arguments?: string };
};

type ChatMessage = {
	role?: string;
	content?: unknown;
	tool_calls?: ChatToolCall[];
	tool_call_id?: string;
};

type ChatTool = {
	type?: string;
	function?: { name?: string; description?: string; parameters?: unknown };
};

type ChatBody = {
	model?: string;
	messages?: ChatMessage[];
	tools?: ChatTool[];
	stream?: boolean;
	max_tokens?: number;
	max_completion_tokens?: number;
	temperature?: number;
};

const encoder = new TextEncoder();

function region(): string {
	return process.env.AWS_REGION?.trim() || 'us-east-1';
}

function bearerToken(): string {
	return process.env.AWS_BEARER_TOKEN_BEDROCK?.trim() || '';
}

function textOf(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	return content
		.map((part) => {
			if (typeof part === 'string') {
				return part;
			}
			if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
				return part.text;
			}
			return '';
		})
		.filter(Boolean)
		.join('\n');
}

function pushMessage(messages: Message[], role: 'user' | 'assistant', blocks: ContentBlock[]) {
	if (blocks.length === 0) {
		return;
	}
	const last = messages[messages.length - 1];
	if (last && last.role === role) {
		last.content = [...(last.content ?? []), ...blocks];
		return;
	}
	messages.push({ role, content: blocks });
}

function contentBlocks(content: unknown): ContentBlock[] {
	if (!Array.isArray(content)) {
		const text = textOf(content);
		return text.trim() ? [{ text }] : [];
	}
	return content.flatMap<ContentBlock>(part => {
		if (part?.type !== 'image_url') {
			const text = textOf([part]);
			return text.trim() ? [{ text }] : [];
		}
		const { format, bytes } = decodeScreenshot(part.image_url?.url);
		return [{ image: { format, source: { bytes } } }];
	});
}

/** Recover protocol pairs removed by interrupted turns or history compaction. */
function normalizeToolHistory(messages: Message[]): Message[] {
	const normalized: Message[] = [];
	const missingResult = (toolUseId: string): ContentBlock => ({ toolResult: {
		toolUseId, status: 'error', content: [{ text: 'Tool result is missing from conversation history. Do not assume the tool succeeded.' }],
	} });
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === 'assistant') {
			pushMessage(normalized, 'assistant', message.content ?? []);
			if (messages[index + 1]?.role === 'user') { continue; }
		} else {
			const previous = normalized.at(-1);
			const expected = new Set(previous?.role === 'assistant'
				? (previous.content ?? []).flatMap(block => block.toolUse?.toolUseId ? [block.toolUse.toolUseId] : []) : []);
			const blocks: ContentBlock[] = [];
			for (const block of message.content ?? []) {
				if (!block.toolResult) { blocks.push(block); continue; }
				if (block.toolResult.toolUseId && expected.delete(block.toolResult.toolUseId)) {
					blocks.push(block);
					continue;
				}
				// An orphan result is still useful context, but cannot be a protocol toolResult.
				blocks.push({ text: `Historical tool output (${block.toolResult.toolUseId ?? 'unknown'}):` });
				for (const output of block.toolResult.content ?? []) {
					if (output.text?.trim()) { blocks.push({ text: output.text }); }
					else if (output.image) { blocks.push({ image: output.image }); }
				}
			}
			for (const toolUseId of expected) {
				blocks.unshift(missingResult(toolUseId));
			}
			pushMessage(normalized, 'user', blocks);
			continue;
		}
		const pending = (message.content ?? []).flatMap(block => block.toolUse?.toolUseId ? [block.toolUse.toolUseId] : []);
		if (pending.length) {
			pushMessage(normalized, 'user', pending.map(missingResult));
		}
	}
	return normalized;
}

/** Move tool-result images next to their toolResult blocks, keeping every toolResult first in the message. */
function liftToolResultImages(messages: Message[]): Message[] {
	return messages.map(message => {
		if (message.role !== 'user' || !message.content?.some(block => block.toolResult?.content?.some(output => output.image))) {
			return message;
		}
		const results: ContentBlock[] = [];
		const rest: ContentBlock[] = [];
		for (const block of message.content) {
			if (!block.toolResult) { rest.push(block); continue; }
			const images = (block.toolResult.content ?? []).filter(output => output.image);
			const texts = (block.toolResult.content ?? []).filter(output => !output.image);
			const note = images.length ? [{ text: `Image output (${images.length}) is attached after the tool results.` }] : [];
			results.push({ toolResult: { ...block.toolResult, content: [...texts, ...note] as never } });
			rest.push(...images.map(output => ({ image: output.image! })));
		}
		return { ...message, content: [...results, ...rest] };
	});
}

export function toConverse(body: ChatBody, modelId?: string): { system: { text: string }[]; messages: Message[]; toolConfig?: ToolConfiguration } {
	screenshotCount((body.messages || []) as Array<Record<string, unknown>>);
	const system: { text: string }[] = [];
	const messages: Message[] = [];

	for (const message of body.messages ?? []) {
		if (message.role === 'system') {
			const text = textOf(message.content);
			if (text.trim()) {
				system.push({ text });
			}
			continue;
		}

		if (message.role === 'tool') {
			const blocks = contentBlocks(message.content);
			pushMessage(messages, 'user', [{
				toolResult: {
					toolUseId: message.tool_call_id || 'tool',
					content: (blocks.length > 0 ? blocks : [{ text: 'Tool returned no text output.' }]) as never,
				},
			}]);
			continue;
		}

		if (message.role === 'assistant') {
			const blocks: ContentBlock[] = [];
			const text = textOf(message.content);
			if (text.trim()) {
				blocks.push({ text });
			}
			for (const call of message.tool_calls ?? []) {
				let input: unknown = {};
				try {
					const parsed = JSON.parse(call.function?.arguments || '{}');
					if (parsed && typeof parsed === 'object') {
						input = parsed;
					}
				} catch {
					input = {};
				}
				blocks.push({
					toolUse: {
						toolUseId: call.id || crypto.randomUUID(),
						name: call.function?.name || 'tool',
						input: input as never,
					},
				});
			}
			pushMessage(messages, 'assistant', blocks);
			continue;
		}

		pushMessage(messages, 'user', contentBlocks(message.content));
	}

	if (messages[0]?.role === 'assistant') {
		messages.unshift({ role: 'user', content: [{ text: 'Continue.' }] });
	}
	if (messages.length === 0) {
		throw new BudgetError('invalid_messages', 'Добавьте текст сообщения или изображение.', 400);
	}

	const tools: Tool[] = (body.tools ?? [])
		.filter((tool) => tool.function?.name)
		.map((tool) => ({
			toolSpec: {
				name: tool.function!.name!,
				description: tool.function!.description || tool.function!.name!,
				inputSchema: {
					json: (tool.function!.parameters && typeof tool.function!.parameters === 'object'
						? tool.function!.parameters
						: { type: 'object', properties: {} }) as never,
				},
			},
		}));

	const normalized = normalizeToolHistory(messages);
	return {
		system,
		messages: modelId && modelCapabilities(modelId).toolResultImages === false ? liftToolResultImages(normalized) : normalized,
		toolConfig: tools.length > 0 ? { tools } : undefined,
	};
}

let cachedModelId: string | undefined;

function preferClaude(id: string): number {
	const value = id.toLowerCase();
	if (!value.includes('anthropic.claude')) {
		return 100;
	}
	// Sonnet 4.5 доступен на этом ключе. Более новые профили в списке есть,
	// но аккаунт их ещё не открыл, и вызов падает.
	if (value.includes('sonnet-4-5')) {
		return 0;
	}
	if (value.includes('sonnet-4')) {
		return 1;
	}
	if (value.includes('haiku')) {
		return 2;
	}
	if (value.includes('sonnet')) {
		return 3;
	}
	return 4;
}

async function resolveModelId(requested: string | undefined): Promise<string> {
	const explicit = process.env.BEDROCK_MODEL_ID?.trim();
	if (explicit) {
		return explicit;
	}
	if (requested && /anthropic\.claude/i.test(requested)) {
		return requested;
	}
	if (cachedModelId) {
		return cachedModelId;
	}

	const token = bearerToken();
	const response = await fetch(`https://bedrock.${region()}.amazonaws.com/inference-profiles?maxResults=100`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) {
		throw new Error(`Не удалось получить inference profile Claude (${response.status}). Задайте BEDROCK_MODEL_ID.`);
	}
	const json = await response.json() as {
		inferenceProfileSummaries?: Array<{ inferenceProfileId?: string; status?: string }>;
	};
	const ids = (json.inferenceProfileSummaries ?? [])
		.filter((profile) => profile.status === 'ACTIVE' && profile.inferenceProfileId)
		.map((profile) => profile.inferenceProfileId as string)
		.sort((a, b) => preferClaude(a) - preferClaude(b) || b.localeCompare(a));
	const chosen = ids.find((id) => id.toLowerCase().includes('anthropic.claude'));
	if (!chosen) {
		throw new Error('В регионе нет активного inference profile Claude. Задайте BEDROCK_MODEL_ID.');
	}
	cachedModelId = chosen;
	return chosen;
}

export function client(awsRegion = region(), maxAttempts = 3, tokenOverride?: string): BedrockRuntimeClient {
	// Regional API keys are not interchangeable. Reuse the existing Oregon key
	// until a dedicated text key is configured for that region.
	const token = tokenOverride || (awsRegion === 'us-west-2'
		? process.env.AWS_BEARER_TOKEN_BEDROCK_US_WEST_2?.trim() || process.env.AWS_BEARER_TOKEN_BEDROCK_IMAGES?.trim() : undefined);
	// SigV4 стоит в списке схем раньше bearer. Явный приоритет нужен, чтобы
	// использовался AWS_BEARER_TOKEN_BEDROCK, а не локальный AWS-профиль.
	return new BedrockRuntimeClient({
		region: awsRegion,
		maxAttempts,
		...(token ? { token: { token } } : {}),
		authSchemePreference: ['httpBearerAuth'],
	});
}

function maxTokens(body: ChatBody): number {
	const requested = body.max_tokens ?? body.max_completion_tokens ?? 4096;
	if (!Number.isFinite(requested) || requested <= 0) {
		return 4096;
	}
	return Math.min(Math.floor(requested), 16000);
}

function finishReason(stopReason: string | undefined): 'tool_calls' | 'length' | 'stop' {
	if (stopReason === 'tool_use') {
		return 'tool_calls';
	}
	if (stopReason === 'max_tokens') {
		return 'length';
	}
	return 'stop';
}

function sse(payload: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunk(model: string, delta: unknown, finish: string | null = null): unknown {
	return {
		id: 'chatcmpl-bedrock',
		object: 'chat.completion.chunk',
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

export function bedrockUsage(model: string, usage: Partial<TokenUsage>, price?: CatalogPrice | null) {
	const read = usage.cacheReadInputTokens || 0;
	const write = usage.cacheWriteInputTokens || 0;
	const prompt = (usage.inputTokens || 0) + read + write;
	const output = usage.outputTokens || 0;
	const result: ReportedUsage & { total_tokens: number } = { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output,
		prompt_tokens_details: { cached_tokens: read, cache_creation_input_tokens: write } };
	if (price?.inputPerMillion != null && price.outputPerMillion != null) {
		const cache = modelCapabilities(model).cache;
		result.cost = usageCostMicros(result, price.inputPerMillion, price.outputPerMillion,
			price.inputPerMillion * (cache?.readMultiplier ?? 1), price.inputPerMillion * (cache?.writeMultiplier ?? 1)) / 1_000_000;
	}
	return result;
}

/** Rolling prefix checkpoints let subsequent tool steps reuse history without caching Qwen requests. */
export function cacheConversePrefix(model: string, messages: Message[]): Message[] {
	const cache = modelCapabilities(model).cache;
	if (cache?.textOnly) {
		const textIndex = messages.findLastIndex(message => message.role === 'user' && message.content?.every(block => 'text' in block));
		if (textIndex < 0 || Buffer.byteLength(JSON.stringify(messages.slice(0, textIndex + 1))) < cache.minimumTokens * 4) { return messages; }
		return messages.map((message, index) => index === textIndex
			? { ...message, content: [...(message.content || []), { cachePoint: { type: 'default' } }] } : message);
	}
	if (!cache || messages.length < 2 || Buffer.byteLength(JSON.stringify(messages)) < cache.minimumTokens * 4) { return messages; }
	const prefixIndex = messages.length - 2;
	return messages.map((message, index) => index === prefixIndex
		? { ...message, content: [...(message.content || []), { cachePoint: { type: 'default' } }] } : message);
}

/** Models that cannot checkpoint tool history still reuse the system prompt, which is most of an agent's fixed prefix. */
export function cacheConverseSystem(model: string, system: { text: string }[]): SystemContentBlock[] {
	const cache = modelCapabilities(model).cache;
	return cache?.textOnly && Buffer.byteLength(JSON.stringify(system)) >= cache.minimumTokens * 4 ? [...system, { cachePoint: { type: 'default' } }] : system;
}

function usagePayload(model: string, usage: Partial<TokenUsage>, price?: CatalogPrice | null): unknown {
	return {
		id: 'chatcmpl-bedrock',
		object: 'chat.completion.chunk',
		model,
		choices: [],
		usage: bedrockUsage(model, usage, price),
	};
}

function providerHeaders(modelId: string): Headers {
	const headers = new Headers();
	headers.set('X-Llm-Provider', 'bedrock');
	headers.set('X-Llm-Model', modelId);
	headers.set('X-Llm-Region', modelCapabilities(modelId).region || region());
	return headers;
}

function failure(error: unknown): Response {
	const message = error instanceof Error ? error.message : 'Bedrock request failed';
	const awsStatus = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
	return Response.json({ error: { message, code: error instanceof BudgetError ? error.code : 'bedrock_error' } },
		{ status: error instanceof BudgetError ? error.status : awsStatus && awsStatus >= 400 && awsStatus < 500 ? awsStatus : 502 });
}

export async function completeWithBedrock(rawBody: unknown, forcedModelId?: string, price?: CatalogPrice | null): Promise<Response> {
	const body = (rawBody ?? {}) as ChatBody;
	if (!bearerToken()) {
		return Response.json({ error: 'AWS_BEARER_TOKEN_BEDROCK is not configured' }, { status: 500 });
	}

	try {
		const modelId = forcedModelId || await resolveModelId(body.model);
		if (screenshotCount((body.messages || []) as Array<Record<string, unknown>>) && !supportsScreenshots(modelId)) {
			throw new BudgetError('vision_unavailable', 'Выберите модель с поддержкой изображений, например Claude, Kimi K2.5 или Qwen3 VL.', 400);
		}
		const { system, messages, toolConfig } = toConverse(body, modelId);
		const inferenceConfig = {
			maxTokens: maxTokens(body),
			...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
		};
		const input = {
			modelId,
			messages: price ? cacheConversePrefix(modelId, messages) : messages,
			...(system.length > 0 ? { system: price ? cacheConverseSystem(modelId, system) : system } : {}),
			...(toolConfig ? { toolConfig } : {}),
			inferenceConfig,
		};

		if (body.stream) {
			const response = await client(modelCapabilities(modelId).region || region()).send(new ConverseStreamCommand(input));
			const headers = providerHeaders(modelId);
			headers.set('Content-Type', 'text/event-stream');
			headers.set('Cache-Control', 'no-cache');
			headers.set('Connection', 'keep-alive');
			return new Response(openAIStream(response.stream, modelId, price), { headers });
		}

		const response = await client(modelCapabilities(modelId).region || region()).send(new ConverseCommand(input));
		const text = (response.output?.message?.content ?? [])
			.map((block) => ('text' in block ? block.text : ''))
			.filter(Boolean)
			.join('');
		const toolCalls = (response.output?.message?.content ?? [])
			.flatMap((block) => ('toolUse' in block && block.toolUse ? [block.toolUse] : []))
			.map((tool, index) => ({
				id: tool.toolUseId || `tool_${index}`,
				type: 'function' as const,
				function: {
					name: tool.name || 'tool',
					arguments: JSON.stringify(tool.input ?? {}),
				},
			}));
		const headers = providerHeaders(modelId);
		headers.set('Content-Type', 'application/json');
		return new Response(JSON.stringify({
			id: 'chatcmpl-bedrock',
			object: 'chat.completion',
			model: modelId,
			choices: [{
				index: 0,
				message: {
					role: 'assistant',
					content: text || null,
					...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
				},
				finish_reason: finishReason(response.stopReason),
			}],
			usage: bedrockUsage(modelId, response.usage || {}, price),
		}), { headers });
	} catch (error) {
		console.error('Bedrock converse failed:', error);
		return failure(error);
	}
}

export async function countBedrockInput(body: ChatBody, modelId: string) {
	if (!bearerToken()) { throw new BudgetError('vision_count_unavailable', 'Bedrock не настроен для подсчёта токенов скриншота.', 503); }
	try {
		// CountTokens targets the foundation model, not its cross-region inference profile.
		const countingModelId = modelId.replace(/^(?:us|eu|apac|global)\.(?=anthropic\.)/, '');
		const runtime = client();
		const response = await runtime.send(new CountTokensCommand({ modelId: countingModelId, input: { converse: toConverse(body, modelId) } }),
			{ abortSignal: AbortSignal.timeout(30_000) }).finally(() => runtime.destroy());
		if (!Number.isSafeInteger(response.inputTokens) || response.inputTokens! < 0) { throw new Error('Invalid token count'); }
		return response.inputTokens!;
	} catch {
		throw new BudgetError('vision_count_unavailable', 'Не удалось подсчитать токены скриншота. Проверьте доступ bedrock:CountTokens; повторите запрос позже.', 503);
	}
}

function openAIStream(events: AsyncIterable<unknown> | undefined, modelId: string, price?: CatalogPrice | null): ReadableStream<Uint8Array> {
	return new ReadableStream({
		async start(controller) {
			let stop: string | undefined;
			try {
				for await (const event of events ?? []) {
					const record = event as Record<string, any>;
					const start = record.contentBlockStart;
					if (start?.start?.toolUse) {
						controller.enqueue(sse(chunk(modelId, {
							tool_calls: [{
								index: start.contentBlockIndex ?? 0,
								id: start.start.toolUse.toolUseId,
								type: 'function',
								function: { name: start.start.toolUse.name, arguments: '' },
							}],
						})));
					}
					const delta = record.contentBlockDelta?.delta;
					if (typeof delta?.text === 'string' && delta.text) {
						controller.enqueue(sse(chunk(modelId, { content: delta.text })));
					}
					if (typeof delta?.toolUse?.input === 'string' && delta.toolUse.input) {
						controller.enqueue(sse(chunk(modelId, {
							tool_calls: [{
								index: record.contentBlockDelta.contentBlockIndex ?? 0,
								function: { arguments: delta.toolUse.input },
							}],
						})));
					}
					if (record.messageStop?.stopReason) {
						stop = record.messageStop.stopReason;
					}
					const usage = record.metadata?.usage;
					if (usage) {
						controller.enqueue(sse(usagePayload(modelId, usage, price)));
					}
				}
				controller.enqueue(sse(chunk(modelId, {}, finishReason(stop))));
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
	});
}
