import { NextRequest, NextResponse } from 'next/server';
import { decryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/** Owned ledger only; prompts, keys and other users' usage never leave the server. */
export async function GET(req: NextRequest) {
	const auth = req.headers.get('Authorization');
	if (!auth?.startsWith('Bearer ')) { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
	let userId: string;
	try { userId = (await decryptJWT(auth.slice(7))).userId; }
	catch { return NextResponse.json({ error: 'Invalid Token' }, { status: 401 }); }
	const user = await prisma.user.findUnique({ where: { id: userId }, select: { isBanned: true } });
	if (!user || user.isBanned) { return NextResponse.json({ error: 'Account is blocked' }, { status: 403 }); }
	const chatId = req.nextUrl.searchParams.get('chatId');
	if (chatId && !/^[a-zA-Z0-9:._/-]{1,200}$/.test(chatId)) { return NextResponse.json({ error: 'Invalid chat ID' }, { status: 400 }); }
	const where = { userId, ...(chatId ? { chatId } : {}) };
	const [total, models, requests] = await Promise.all([
		prisma.usageLog.aggregate({ where, _sum: { costMicros: true }, _count: true }),
		prisma.usageLog.groupBy({ by: ['model'], where, _sum: { costMicros: true, promptTokens: true, completionTokens: true, cacheReadTokens: true }, _count: true }),
		prisma.usageLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100,
			select: { requestId: true, model: true, chatId: true, createdAt: true, costMicros: true, accounting: true, promptTokens: true, completionTokens: true, cacheReadTokens: true, cacheWriteTokens: true } }),
	]);
	return NextResponse.json({ currency: 'USD', chatId, totalMicros: total._sum.costMicros || 0, requestCount: total._count, models, requests }, { headers: { 'Cache-Control': 'private, no-store' } });
}
