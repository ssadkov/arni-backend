import { NextRequest, NextResponse } from 'next/server';
import { decryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import { accountPayload } from '@/lib/freeSteps';
import { budgetSnapshot } from '@/lib/budget';
import { webCorsHeaders, webOptions } from '@/lib/webCors';

export const dynamic = 'force-dynamic';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function GET(req: NextRequest) {
	const authHeader = req.headers.get('Authorization');
	const headers = webCorsHeaders(req);
	if (!authHeader?.startsWith('Bearer ')) {
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
	}

	let userId: string;
	try {
		const payload = await decryptJWT(authHeader.slice('Bearer '.length));
		userId = payload.userId;
	} catch {
		return NextResponse.json({ error: 'Invalid Token' }, { status: 401, headers });
	}

	const user = await prisma.user.findUnique({ where: { id: userId } });
	if (!user) {
		return NextResponse.json({ error: 'User not found' }, { status: 404, headers });
	}
	if (user.isBanned) {
		return NextResponse.json({ error: 'Account is blocked' }, { status: 403, headers });
	}

	const budget = await prisma.accountBudget.findUnique({ where: { userId } });
	return NextResponse.json({ user: { ...accountPayload(user), budget: budget ? budgetSnapshot(budget) : null } }, {
		headers: { 'Cache-Control': 'no-store', ...headers },
	});
}
