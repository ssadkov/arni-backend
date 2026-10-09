import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import prisma from '@/lib/prisma';
import { freeStepSnapshot } from '@/lib/freeSteps';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
	const denied = requireAdmin(req);
	if (denied) {
		return denied;
	}

	const users = await prisma.user.findMany({
		orderBy: { createdAt: 'desc' },
		include: { identities: true },
	});

	return NextResponse.json({
		users: users.map((user) => ({
			id: user.id,
			email: user.email,
			tokenBalance: user.tokenBalance,
			plan: user.plan,
			isBanned: user.isBanned,
			llmProvider: user.llmProvider,
			freeSteps: freeStepSnapshot(user),
			identities: user.identities.map((identity) => ({
				provider: identity.provider,
				providerId: identity.providerId,
			})),
		})),
	});
}
