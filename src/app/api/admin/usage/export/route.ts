import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireAdmin } from '@/lib/adminAuth';

/** Export immutable rate snapshots and quantities; no prompt or screenshot content. */
export async function GET(req: NextRequest) {
	const denied = requireAdmin(req);
	if (denied) { return denied; }
	const from = new Date(req.nextUrl.searchParams.get('from') || Date.now() - 30 * 86400_000);
	const to = new Date(req.nextUrl.searchParams.get('to') || Date.now());
	if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) { return NextResponse.json({ error: 'Invalid date range' }, { status: 400 }); }
	const rows = await prisma.usageLog.findMany({ where: { createdAt: { gte: from, lte: to } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 10_001 });
	if (rows.length > 10_000) { return NextResponse.json({ error: 'Narrow the date range to at most 10000 records' }, { status: 413 }); }
	const columns = ['id', 'createdAt', 'userId', 'requestId', 'chatId', 'requestedModel', 'model', 'source', 'operation', 'region', 'promptTokens', 'completionTokens', 'cacheReadTokens', 'cacheWriteTokens', 'imageCount', 'inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion', 'unitPriceMicros', 'costMicros', 'accounting', 'costBasis'] as const;
	const quote = (value: unknown) => { const text = value instanceof Date ? value.toISOString() : value == null ? '' : String(value); return `"${(/^[=+@-]/.test(text) ? "'" + text : text).replace(/"/g, '""')}"`; };
	const csv = '\ufeff' + columns.join(',') + '\r\n' + rows.map(row => columns.map(column => quote(row[column])).join(',')).join('\r\n');
	return new NextResponse(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="arni-api-usage.csv"', 'Cache-Control': 'private, no-store' } });
}
