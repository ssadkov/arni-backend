import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { mediaUser } from '@/lib/mediaAuth';
import { BudgetError } from '@/lib/budget';

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
	try {
		const user = await mediaUser(req);
		const { id } = await context.params;
		const row = await prisma.mediaGeneration.findFirst({ where: { id, userId: user.id, status: 'succeeded' } });
		if (!row?.image) { return NextResponse.json({ error: 'Image not found' }, { status: 404 }); }
		return new NextResponse(new Uint8Array(row.image), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="${row.id}.png"` } });
	} catch (error) { return NextResponse.json({ error: error instanceof BudgetError ? error.message : 'Internal error' }, { status: error instanceof BudgetError ? error.status : 500 }); }
}
