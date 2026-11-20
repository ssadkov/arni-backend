import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { bonusSnapshot, grantDeepSeekBonus } from '@/lib/deepSeekBonus';

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
	const denied = requireAdmin(req);
	if (denied) { return denied; }
	const { id } = await context.params;
	const result = await grantDeepSeekBonus(id);
	if (result.status === 'unavailable') {
		return NextResponse.json({ error: 'Аккаунт недоступен.' }, { status: 404 });
	}
	if (result.status === 'expired') {
		return NextResponse.json({ error: 'Срок акции истёк.' }, { status: 409 });
	}
	return NextResponse.json({ bonus: bonusSnapshot(result.wallet) });
}
