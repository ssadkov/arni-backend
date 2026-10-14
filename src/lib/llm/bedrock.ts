import {
	BedrockRuntimeClient,
	ConverseCommand,
	ConverseStreamCommand,
	CountTokensCommand,
	type ContentBlock,
	type Message,
	type Tool,
	type ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import { decodeScreenshot, screenshotCount, supportsScreenshots } from './vision';
import { BudgetError } from '@/lib/budget';

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
	const last = messages[messages.length - 1];
	if (last && last.role === role) {
		last.content = [...(last.content ?? []), ...blocks];
		return;
	}
	messages.push({ role, content: blocks });
}

function contentBlocks(content: unknown): ContentBlock[] {
	if (!Array.isArray(content)) { return [{ text: textOf(content) || ' ' }]; }
	return content.map(part => {
		if (part?.type !== 'image_url') { return { text: textOf([part]) || ' ' }; }
		const { format, bytes } = decodeScreenshot(part.image_url?.url);
		return { image: { format, source: { bytes } } };
	});
}

export function toConverse(body: ChatBody): { system: { text: string }[]; messages: Message[]; toolConfig?: ToolConfiguration } {
	screenshotCount((body.messages || []) as Array<Record<string, unknown>>);
	const system: { text: string }[] = [];
	const messages: Message[] = [];

	for (const message of body.messages ?? []) {
		if (message.role === 'system') {
			const text = textOf(message.content);
			if (text) {
				system.push({ text });
			}
			continue;
		}

		if (message.role === 'tool') {
			pushMessage(messages, 'user', [{
				toolResult: {
					toolUseId: message.tool_call_id || 'tool',
					content: contentBlocks(message.content) as never,
				},
			}]);
			continue;
		}

		if (message.role === 'assistant') {
			const blocks: ContentBlock[] = [];
			const text = textOf(message.content);
			if (text) {
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
			pushMessage(messages, 'assistant', blocks.length > 0 ? blocks : [{ text: ' ' }]);
			continue;
		}

		pushMessage(messages, 'user', contentBlocks(message.content));
	}

	if (messages[0]?.role === 'assistant') {
		messages.unshift({ role: 'user', content: [{ text: ' ' }] });
	}
	if (messages.length === 0) {
		messages.push({ role: 'user', content: [{ text: ' ' }] });
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

	return {
		system,
		messages,
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
	// SigV4 стоит в списке схем раньше bearer. Явный приоритет нужен, чтобы
	// использовался AWS_BEARER_TOKEN_BEDROCK, а не локальный AWS-профиль.
	return new BedrockRuntimeClient({
		region: awsRegion,
		maxAttempts,
		...(tokenOverride ? { token: { token: tokenOverride } } : {}),
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

function usagePayload(model: string, input: number, output: number): unknown {
	const promptTokens = input || 0;
	const completionTokens = output || 0;
	return {
		id: 'chatcmpl-bedrock',
		object: 'chat.completion.chunk',
		model,
		choices: [],
		usage: {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: promptTokens + completionTokens,
		},
	};
}

function providerHeaders(modelId: string): Headers {
	const headers = new Headers();
	headers.set('X-Llm-Provider', 'bedrock');
	headers.set('X-Llm-Model', modelId);
	return headers;
}

function failure(error: unknown): Response {
	const message = error instanceof Error ? error.message : 'Bedrock request failed';
	const awsStatus = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
	return Response.json({ error: { message, code: error instanceof BudgetError ? error.code : 'bedrock_error' } },
		{ status: error instanceof BudgetError ? error.status : awsStatus && awsStatus >= 400 && awsStatus < 500 ? awsStatus : 502 });
}

export async function completeWithBedrock(rawBody: unknown, forcedModelId?: string): Promise<Response> {
	const body = (rawBody ?? {}) as ChatBody;
	if (!bearerToken()) {
		return Response.json({ error: 'AWS_BEARER_TOKEN_BEDROCK is not configured' }, { status: 500 });
	}

	try {
		const modelId = forcedModelId || await resolveModelId(body.model);
		if (screenshotCount((body.messages || []) as Array<Record<string, unknown>>) && !supportsScreenshots(modelId)) {
			throw new BudgetError('vision_unavailable', 'Выберите Claude с поддержкой скриншотов.', 400);
		}
		const { system, messages, toolConfig } = toConverse(body);
		const inferenceConfig = {
			maxTokens: maxTokens(body),
			...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
		};
		const input = {
			modelId,
			messages,
			...(system.length > 0 ? { system } : {}),
			...(toolConfig ? { toolConfig } : {}),
			inferenceConfig,
		};

		if (body.stream) {
			const response = await client().send(new ConverseStreamCommand(input));
			const headers = providerHeaders(modelId);
			headers.set('Content-Type', 'text/event-stream');
			headers.set('Cache-Control', 'no-cache');
			headers.set('Connection', 'keep-alive');
			return new Response(openAIStream(response.stream, modelId), { headers });
		}

		const response = await client().send(new ConverseCommand(input));
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
		const promptTokens = response.usage?.inputTokens || 0;
		const completionTokens = response.usage?.outputTokens || 0;
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
			usage: {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: promptTokens + completionTokens,
			},
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
		const response = await runtime.send(new CountTokensCommand({ modelId: countingModelId, input: { converse: toConverse(body) } }),
			{ abortSignal: AbortSignal.timeout(30_000) }).finally(() => runtime.destroy());
		if (!Number.isSafeInteger(response.inputTokens) || response.inputTokens! < 0) { throw new Error('Invalid token count'); }
		return response.inputTokens!;
	} catch {
		throw new BudgetError('vision_count_unavailable', 'Не удалось подсчитать токены скриншота. Проверьте доступ bedrock:CountTokens; повторите запрос позже.', 503);
	}
}

function openAIStream(events: AsyncIterable<unknown> | undefined, modelId: string): ReadableStream<Uint8Array> {
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
						controller.enqueue(sse(usagePayload(modelId, usage.inputTokens || 0, usage.outputTokens || 0)));
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
