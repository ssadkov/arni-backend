import { NextRequest } from 'next/server';
import { BudgetError } from '@/lib/budget';
import prisma from '@/lib/prisma';
import { webJson, webOptions } from '@/lib/webCors';
import { webUser } from '@/lib/webSession';
import { ownChat } from '@/lib/webTurn';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
	try {
		const { user } = await webUser(req);
		const { id } = await context.params;
		await ownChat(user.id, id);
		await prisma.webChat.delete({ where: { id } });
		return webJson(req, { ok: true });
	} catch (error) {
		const known = error instanceof BudgetError;
		return webJson(req, { error: { message: known ? error.message : 'Не удалось удалить чат.' } }, known ? error.status : 500);
	}
}
