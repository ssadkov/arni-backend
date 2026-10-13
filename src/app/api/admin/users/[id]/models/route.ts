import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import prisma from '@/lib/prisma';

const MODES = new Set(['default', 'on', 'off']);

export async function POST(
	req: NextRequest,
	context: { params: Promise<{ id: string }> }
) {
	const denied = requireAdmin(req);
	if (denied) {
		return denied;
	}

	const { id } = await context.params;
	const body = await req.json().catch(() => ({}));
	const modelId = typeof body?.modelId === 'string' ? body.modelId : '';
	const mode = typeof body?.mode === 'string' ? body.mode : '';
	if (!modelId || !MODES.has(mode)) {
		return NextResponse.json({ error: 'Invalid model access' }, { status: 400 });
	}

	const model = await prisma.bedrockModel.findUnique({ where: { id: modelId } });
	if (!model) {
		return NextResponse.json({ error: 'Model not found' }, { status: 404 });
	}

	if (mode === 'default') {
		await prisma.userModelAccess.deleteMany({ where: { userId: id, modelId } });
		return NextResponse.json({ userId: id, modelId, mode });
	}

	await prisma.userModelAccess.upsert({
		where: { userId_modelId: { userId: id, modelId } },
		create: { userId: id, modelId, enabled: mode === 'on' },
		update: { enabled: mode === 'on' },
	});
	return NextResponse.json({ userId: id, modelId, mode });
}
