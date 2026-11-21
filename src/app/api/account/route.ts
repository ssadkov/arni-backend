import { NextRequest, NextResponse } from 'next/server';
import { decryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import { accountPayload } from '@/lib/freeSteps';
import { budgetSnapshot } from '@/lib/budget';
import { readDeepSeekBonus } from '@/lib/deepSeekBonus';
import { billingRates } from '@/lib/billingCurrency';
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

	const user = await prisma.user.findUnique({
		where: { id: userId },
		include: {
			identities: {
				where: { provider: { in: ['yandex', 'google', 'vk'] } },
				select: { provider: true },
				distinct: ['provider'],
			},
		},
	});
	if (!user) {
		return NextResponse.json({ error: 'User not found' }, { status: 404, headers });
	}
	if (user.isBanned) {
		return NextResponse.json({ error: 'Account is blocked' }, { status: 403, headers });
	}

	const [budget, rates, wallet] = await Promise.all([
		prisma.accountBudget.findUnique({ where: { userId } }), billingRates(), readDeepSeekBonus(userId),
	]);
	// Desktop tokens don't record the sign-in provider. Show it only for an unambiguous linked identity.
	const authProvider = user.identities.length === 1 ? user.identities[0].provider : null;
	return NextResponse.json({ user: { ...accountPayload(user), authProvider, budget: budget ? budgetSnapshot(budget, new Date(), wallet) : null, billingRates: rates } }, {
		headers: { 'Cache-Control': 'no-store', ...headers },
	});
}
