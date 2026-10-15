import type { NextRequest } from 'next/server';
import { decryptJWT } from './jwt';
import prisma from './prisma';
import { BudgetError } from './budget';

export async function mediaUser(req: NextRequest) {
	const header = req.headers.get('authorization');
	if (!header?.startsWith('Bearer ')) { throw new BudgetError('unauthorized', 'Войдите в ArniCode.', 401); }
	let id: string;
	try { id = (await decryptJWT(header.slice(7))).userId; }
	catch { throw new BudgetError('unauthorized', 'Войдите в ArniCode повторно.', 401); }
	const user = await prisma.user.findUnique({ where: { id } });
	if (!user || user.isBanned) { throw new BudgetError('account_blocked', 'Аккаунт недоступен.', 403); }
	return user;
}
