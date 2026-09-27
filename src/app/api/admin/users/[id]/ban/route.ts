import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import prisma from '@/lib/prisma';

export async function POST(
	req: NextRequest,
	context: { params: Promise<{ id: string }> }
) {
	const denied = requireAdmin(req);
	if (denied) {
		return denied;
	}

	const { id } = await context.params;
	try {
		const existing = await prisma.user.findUnique({ where: { id } });
		if (!existing) {
			return NextResponse.json({ error: 'User not found' }, { status: 404 });
		}
		const user = await prisma.user.update({
			where: { id },
			data: { isBanned: !existing.isBanned },
		});
		return NextResponse.json({
			id: user.id,
			email: user.email,
			isBanned: user.isBanned,
		});
	} catch {
		return NextResponse.json({ error: 'User not found' }, { status: 404 });
	}
}
