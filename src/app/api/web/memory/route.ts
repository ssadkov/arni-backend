import { NextRequest } from 'next/server';
import { BudgetError } from '@/lib/budget';
import prisma from '@/lib/prisma';
import { webJson, webOptions } from '@/lib/webCors';
import { webUser } from '@/lib/webSession';
import { MEMORY_LIMIT } from '@/lib/webTurn';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function GET(req: NextRequest) {
	try {
		const { user } = await webUser(req);
		const memory = await prisma.webMemory.findUnique({ where: { userId: user.id } });
		return webJson(req, { text: memory?.text ?? '' });
	} catch (error) {
		return failure(req, error);
	}
}

export async function PUT(req: NextRequest) {
	try {
		const { user } = await webUser(req);
		const body = await req.json().catch(() => null) as { text?: unknown } | null;
		const text = typeof body?.text === 'string' ? body.text.trim() : '';
		if (text.length > MEMORY_LIMIT) {
			throw new BudgetError('memory_too_long', `Память длиннее ${MEMORY_LIMIT} символов.`, 400);
		}
		await prisma.webMemory.upsert({
			where: { userId: user.id },
			create: { userId: user.id, text },
			update: { text },
		});
		return webJson(req, { text });
	} catch (error) {
		return failure(req, error);
	}
}

function failure(req: NextRequest, error: unknown) {
	const known = error instanceof BudgetError;
	return webJson(req, { error: { message: known ? error.message : 'Не удалось сохранить память.' } }, known ? error.status : 500);
}
