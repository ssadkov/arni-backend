import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import prisma from '@/lib/prisma';

const DEFAULT_CREDIT_AMOUNT = 1_000_000;
const MAX_CREDIT_AMOUNT = 50_000_000;

export async function POST(
	req: NextRequest,
	context: { params: Promise<{ id: string }> }
) {
	const denied = requireAdmin(req);
	if (denied) {
		return denied;
	}

	const { id } = await context.params;
	let amount = DEFAULT_CREDIT_AMOUNT;
	try {
		const body = await req.json().catch(() => ({}));
		if (body?.amount !== undefined) {
			amount = Number(body.amount);
		}
	} catch {
		amount = DEFAULT_CREDIT_AMOUNT;
	}

	if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_CREDIT_AMOUNT) {
		return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
	}

	try {
		const user = await prisma.user.update({
			where: { id },
			data: { tokenBalance: { increment: Math.floor(amount) } },
		});
		return NextResponse.json({
			id: user.id,
			email: user.email,
			tokenBalance: user.tokenBalance,
			credited: Math.floor(amount),
		});
	} catch {
		return NextResponse.json({ error: 'User not found' }, { status: 404 });
	}
}
