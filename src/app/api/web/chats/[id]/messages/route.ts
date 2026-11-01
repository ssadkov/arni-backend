import { NextRequest } from 'next/server';
import { BudgetError } from '@/lib/budget';
import prisma from '@/lib/prisma';
import { webCorsHeaders, webJson, webOptions } from '@/lib/webCors';
import { webUser } from '@/lib/webSession';
import { ownChat, prepareTurn, publicMessage, runTurn, saveAssistant, textFromSse } from '@/lib/webTurn';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
	try {
		const { user } = await webUser(req);
		const { id } = await context.params;
		await ownChat(user.id, id);
		const messages = await prisma.webMessage.findMany({
			where: { chatId: id },
			orderBy: { createdAt: 'asc' },
			include: { images: { select: { id: true, mediaType: true } } },
		});
		return webJson(req, { messages: messages.map(publicMessage) });
	} catch (error) {
		const known = error instanceof BudgetError;
		return webJson(req, { error: { message: known ? error.message : 'Не удалось открыть чат.' } }, known ? error.status : 500);
	}
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
	try {
		const { user, token } = await webUser(req);
		const { id } = await context.params;
		const body = await req.json().catch(() => null) as { text?: string; imageId?: string; model?: string } | null;
		await prepareTurn(user.id, id, body?.text || '', body?.imageId);
		const turn = await runTurn(token, user.id, id, body?.model || '');
		if ('error' in turn && turn.error) {
			return webJson(req, turn.error, turn.status);
		}
		if ('text' in turn && typeof turn.text === 'string') {
			const encoder = new TextEncoder();
			const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: turn.text } }], arni_sources: turn.sources })}\n\ndata: [DONE]\n\n`;
			return new Response(encoder.encode(payload), { headers: streamHeaders(req) });
		}
		if (!('stream' in turn) || !turn.stream) {
			return webJson(req, { error: { message: 'Не удалось получить ответ.' } }, 502);
		}
		const sources = turn.sources;
		let saved = false;
		const reader = turn.stream.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let text = '';
		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();
				if (sources.length) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ arni_sources: sources })}\n\n`));
				}
				const pump = async () => {
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) {
								break;
							}
							buffer += decoder.decode(value, { stream: true });
							const split = buffer.lastIndexOf('\n');
							if (split >= 0) {
								text += textFromSse(buffer.slice(0, split + 1));
								buffer = buffer.slice(split + 1);
							}
							controller.enqueue(value);
						}
						text += textFromSse(buffer);
						await saveAssistant(id, text, 'complete', sources);
						saved = true;
						controller.close();
					} catch {
						if (!saved) {
							await saveAssistant(id, text, 'incomplete', sources).catch(() => undefined);
							saved = true;
						}
						controller.error(new Error('stream failed'));
					}
				};
				void pump();
			},
			cancel() {
				if (!saved) {
					saved = true;
					void saveAssistant(id, text, 'incomplete', sources).catch(() => undefined);
				}
			},
		});
		return new Response(stream, { headers: streamHeaders(req) });
	} catch (error) {
		const known = error instanceof BudgetError;
		return webJson(req, { error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Не удалось отправить сообщение.' } }, known ? error.status : 500);
	}
}

function streamHeaders(req: NextRequest): HeadersInit {
	return { ...webCorsHeaders(req), 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' };
}
