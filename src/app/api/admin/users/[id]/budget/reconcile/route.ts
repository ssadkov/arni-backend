import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import prisma from '@/lib/prisma';
import { settleBudget } from '@/lib/budget';

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
	const denied = requireAdmin(req);
	if (denied) { return denied; }
	const { id } = await context.params;
	const body = await req.json().catch(() => null);
	if (typeof body?.reservationId !== 'string') { return NextResponse.json({ error: 'Укажите резерв.' }, { status: 400 }); }
	const reservation = await prisma.budgetReservation.findUnique({ where: { id: body.reservationId } });
	if (!reservation || reservation.userId !== id) { return NextResponse.json({ error: 'Резерв не найден.' }, { status: 404 }); }
	if (reservation.status === 'pending' && Date.now() - reservation.createdAt.getTime() < 10 * 60 * 1000) {
		return NextResponse.json({ error: 'Запрос ещё может выполняться. Закрытие доступно через 10 минут.' }, { status: 409 });
	}
	await settleBudget(reservation.id, null);
	await prisma.budgetEntry.upsert({ where: { key: `reconcile:${reservation.id}` }, update: {}, create: {
		userId: id, key: `reconcile:${reservation.id}`, kind: 'reconcile', amountMicros: 0,
		note: `Администратор закрыл зависший резерв без возврата: ${reservation.id}`,
	} });
	return NextResponse.json({ ok: true });
}
