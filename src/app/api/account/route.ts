import { NextRequest, NextResponse } from 'next/server';
import { decryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import { accountPayload } from '@/lib/freeSteps';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
	const authHeader = req.headers.get('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
	}

	let userId: string;
	try {
		const payload = await decryptJWT(authHeader.slice('Bearer '.length));
		userId = payload.userId;
	} catch {
		return NextResponse.json({ error: 'Invalid Token' }, { status: 401 });
	}

	const user = await prisma.user.findUnique({ where: { id: userId } });
	if (!user) {
		return NextResponse.json({ error: 'User not found' }, { status: 404 });
	}
	if (user.isBanned) {
		return NextResponse.json({ error: 'Account is blocked' }, { status: 403 });
	}

	return NextResponse.json({ user: accountPayload(user) });
}
