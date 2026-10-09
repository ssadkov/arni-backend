import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import prisma from '@/lib/prisma';
import type { LlmProvider } from '@prisma/client';

const CHOICES = new Set(['default', 'openrouter', 'bedrock']);

export async function POST(
	req: NextRequest,
	context: { params: Promise<{ id: string }> }
) {
	const denied = requireAdmin(req);
	if (denied) {
		return denied;
	}

	const { id } = await context.params;
	const body = await req.json().catch(() => ({}));
	const choice = typeof body?.provider === 'string' ? body.provider : '';
	if (!CHOICES.has(choice)) {
		return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
	}

	const llmProvider: LlmProvider | null = choice === 'bedrock'
		? 'BEDROCK'
		: choice === 'openrouter'
			? 'OPENROUTER'
			: null;

	try {
		const user = await prisma.user.update({
			where: { id },
			data: { llmProvider },
		});
		return NextResponse.json({ id: user.id, llmProvider: user.llmProvider });
	} catch {
		return NextResponse.json({ error: 'User not found' }, { status: 404 });
	}
}
