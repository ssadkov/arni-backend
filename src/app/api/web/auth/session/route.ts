import { NextRequest } from 'next/server';
import { encryptJWT } from '@/lib/jwt';
import { webJson, webOptions } from '@/lib/webCors';
import { consumeLoginCode } from '@/lib/webSession';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function POST(req: NextRequest) {
	const body = await req.json().catch(() => null) as { code?: string } | null;
	const user = body?.code ? await consumeLoginCode(body.code) : null;
	if (!user) {
		return webJson(req, { error: { message: 'Ссылка для входа устарела. Войдите ещё раз.' } }, 401);
	}
	const token = await encryptJWT({ userId: user.id, email: user.email, plan: user.plan });
	return webJson(req, { token });
}
