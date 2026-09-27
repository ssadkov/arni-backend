import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
	const denied = requireAdmin(req);
	if (denied) {
		return denied;
	}

	const key = process.env.OPENROUTER_API_KEY || '';
	const present = Boolean(key);
	const looksLikeOpenRouter = key.startsWith('sk-or-v1-') && key.length > 20;

	if (!present) {
		return NextResponse.json({
			present,
			looksLikeOpenRouter,
			length: 0,
			error: 'OPENROUTER_API_KEY is empty on the server',
		}, { status: 500 });
	}

	const headers = {
		Authorization: `Bearer ${key}`,
		'Content-Type': 'application/json',
		'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL || 'https://arni-code.com',
		'X-Title': 'Arni Code IDE',
	};

	const keyRes = await fetch('https://openrouter.ai/api/v1/key', { headers });
	const keyJson = await keyRes.json().catch(() => ({}));
	const data = keyJson.data || {};

	async function probe(model: string) {
		const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			headers,
			body: JSON.stringify({
				model,
				max_tokens: 8,
				messages: [{ role: 'user', content: 'Reply with the single word pong.' }],
			}),
		});
		const json = await res.json().catch(() => ({}));
		return {
			status: res.status,
			ok: res.ok,
			model: json.model || model,
			reply: json.choices?.[0]?.message?.content || null,
			error: json.error?.message || json.error || null,
		};
	}

	const [deepseek, free] = await Promise.all([
		probe('deepseek/deepseek-v4.1-flash'),
		probe('nvidia/nemotron-3-super-120b-a12b:free'),
	]);

	return NextResponse.json({
		present,
		looksLikeOpenRouter,
		length: key.length,
		openRouterKeyValid: keyRes.ok,
		label: data.label || null,
		limitRemaining: data.limit_remaining ?? null,
		usage: data.usage ?? null,
		isFreeTier: data.is_free_tier ?? null,
		deepseek,
		free,
	});
}
