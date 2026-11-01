import { NextRequest } from 'next/server';
import { BudgetError } from '@/lib/budget';
import prisma from '@/lib/prisma';
import { webJson, webOptions } from '@/lib/webCors';
import { webUser } from '@/lib/webSession';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

function failure(req: NextRequest, error: unknown) {
	const known = error instanceof BudgetError;
	return webJson(req, { error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Не удалось выполнить запрос.' } }, known ? error.status : 500);
}

export async function GET(req: NextRequest) {
	try {
		const { user } = await webUser(req);
		const chats = await prisma.webChat.findMany({
			where: { userId: user.id },
			orderBy: { updatedAt: 'desc' },
			take: 100,
			select: { id: true, title: true, updatedAt: true },
		});
		return webJson(req, { chats: chats.map(chat => ({ id: chat.id, title: chat.title || 'Новый чат', updatedAt: chat.updatedAt.toISOString() })) });
	} catch (error) {
		return failure(req, error);
	}
}

export async function POST(req: NextRequest) {
	try {
		const { user } = await webUser(req);
		const chat = await prisma.webChat.create({ data: { userId: user.id } });
		return webJson(req, { id: chat.id, title: '', updatedAt: chat.updatedAt.toISOString() }, 201);
	} catch (error) {
		return failure(req, error);
	}
}
