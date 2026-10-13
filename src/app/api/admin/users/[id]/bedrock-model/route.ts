import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import prisma from '@/lib/prisma';

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
	const modelId = body?.modelId === null || body?.modelId === ''
		? null
		: typeof body?.modelId === 'string' ? body.modelId : undefined;
	if (modelId === undefined) {
		return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
	}

	if (modelId) {
		const model = await prisma.bedrockModel.findUnique({ where: { id: modelId } });
		if (!model) {
			return NextResponse.json({ error: 'Model not found' }, { status: 404 });
		}
	}

	try {
		const user = await prisma.user.update({
			where: { id },
			data: { bedrockModelId: modelId },
		});
		return NextResponse.json({ id: user.id, bedrockModelId: user.bedrockModelId });
	} catch {
		return NextResponse.json({ error: 'User not found' }, { status: 404 });
	}
}
