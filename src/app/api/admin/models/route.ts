import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import prisma from '@/lib/prisma';

export async function POST(req: NextRequest) {
	const denied = requireAdmin(req);
	if (denied) {
		return denied;
	}

	const body = await req.json().catch(() => ({}));
	const id = typeof body?.id === 'string' ? body.id : '';
	if (!id || typeof body?.enabled !== 'boolean') {
		return NextResponse.json({ error: 'id and enabled are required' }, { status: 400 });
	}

	try {
		const model = await prisma.bedrockModel.update({
			where: { id },
			data: { enabled: body.enabled },
		});
		return NextResponse.json({ id: model.id, enabled: model.enabled });
	} catch {
		return NextResponse.json({ error: 'Model not found' }, { status: 404 });
	}
}
