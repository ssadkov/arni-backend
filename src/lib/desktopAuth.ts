import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { BudgetError } from '@/lib/budget';
import {
	DESKTOP_POLL_INTERVAL_SEC,
	DESKTOP_START_LIMIT,
	DESKTOP_START_WINDOW_MS,
	DESKTOP_TTL_MS,
	USER_CODE_ALPHABET,
	clientKeyHash,
	formatUserCode,
	hashSecret,
	nextFailedAttempt,
	normalizeUserCode,
	pollDecision,
	safeRequestId,
	secretHashEquals,
	verificationUri,
} from '@/lib/desktopAuthLogic';
import { encryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';

export { clientKeyHash };

function randomUserCode() {
	const bytes = randomBytes(8);
	let raw = '';
	for (const byte of bytes) {
		raw += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
	}
	return raw;
}

export async function startDesktopAuth(webOrigin: string, ipHash: string) {
	const now = new Date();
	await prisma.desktopAuthRequest.deleteMany({ where: { expiresAt: { lt: now } } });
	const since = new Date(now.getTime() - DESKTOP_START_WINDOW_MS);
	const recent = await prisma.desktopAuthRequest.count({
		where: { clientIpHash: ipHash, createdAt: { gt: since } },
	});
	if (recent >= DESKTOP_START_LIMIT) {
		throw new BudgetError('rate_limited', 'Слишком много попыток входа. Подождите и начните снова из Arni Lite.', 429);
	}

	for (let attempt = 0; attempt < 2; attempt++) {
		const deviceCode = randomBytes(32).toString('base64url');
		const requestId = randomBytes(16).toString('base64url');
		const userCode = formatUserCode(randomUserCode());
		try {
			await prisma.desktopAuthRequest.create({
				data: {
					id: requestId,
					deviceCodeHash: hashSecret(deviceCode),
					userCodeHash: hashSecret(normalizeUserCode(userCode)),
					userCode,
					clientIpHash: ipHash,
					pollIntervalSec: DESKTOP_POLL_INTERVAL_SEC,
					expiresAt: new Date(now.getTime() + DESKTOP_TTL_MS),
				},
			});
			return {
				device_code: deviceCode,
				request_id: requestId,
				user_code: userCode,
				verification_uri: verificationUri(webOrigin, requestId),
				expires_in: DESKTOP_TTL_MS / 1000,
				interval: DESKTOP_POLL_INTERVAL_SEC,
			};
		} catch (error) {
			if (attempt === 1 || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
				throw error;
			}
		}
	}
	throw new BudgetError('internal_error', 'Не удалось начать вход.', 500);
}

export async function describeDesktopRequest(requestId: string) {
	if (!safeRequestId(requestId)) {
		return null;
	}
	const row = await prisma.desktopAuthRequest.findUnique({ where: { id: requestId } });
	if (!row || row.expiresAt.getTime() <= Date.now()) {
		return null;
	}
	return {
		application: 'Arni Lite',
		user_code: row.userCode,
		status: row.status,
		expires_in: Math.max(0, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000)),
	};
}

export async function approveDesktopAuth(requestId: string, typedCode: string, userId: string) {
	if (!safeRequestId(requestId)) {
		throw new BudgetError('invalid_request', 'Запрос входа недействителен.', 400);
	}
	const row = await prisma.desktopAuthRequest.findUnique({ where: { id: requestId } });
	if (!row || row.expiresAt.getTime() <= Date.now()) {
		throw new BudgetError('expired', 'Запрос входа истёк. Начните снова из Arni Lite.', 410);
	}
	if (row.status === 'denied') {
		throw new BudgetError('denied', 'Вход отклонён.', 409);
	}
	if (row.status === 'approved') {
		if (row.userId === userId) {
			return { status: 'approved' as const };
		}
		throw new BudgetError('conflict', 'Этот запрос уже привязан к другому аккаунту.', 409);
	}
	if (row.status !== 'pending') {
		throw new BudgetError('expired', 'Запрос входа истёк. Начните снова из Arni Lite.', 410);
	}
	const normalized = normalizeUserCode(typedCode);
	if (!secretHashEquals(row.userCodeHash, normalized)) {
		const next = nextFailedAttempt(row.failedAttempts);
		await prisma.desktopAuthRequest.updateMany({
			where: { id: row.id, status: 'pending' },
			data: { failedAttempts: next.attempts, status: next.deny ? 'denied' : 'pending' },
		});
		throw new BudgetError(
			next.deny ? 'denied' : 'code_mismatch',
			next.deny ? 'Слишком много неверных кодов. Начните снова из Arni Lite.' : 'Код не совпадает с окном Arni Lite.',
			next.deny ? 429 : 400,
		);
	}
	const updated = await prisma.desktopAuthRequest.updateMany({
		where: { id: row.id, status: 'pending', expiresAt: { gt: new Date() } },
		data: { status: 'approved', userId },
	});
	if (updated.count !== 1) {
		throw new BudgetError('conflict', 'Запрос входа уже завершён.', 409);
	}
	return { status: 'approved' as const };
}

export async function denyDesktopAuth(requestId: string) {
	if (!safeRequestId(requestId)) {
		throw new BudgetError('invalid_request', 'Запрос входа недействителен.', 400);
	}
	const updated = await prisma.desktopAuthRequest.updateMany({
		where: { id: requestId, status: 'pending', expiresAt: { gt: new Date() } },
		data: { status: 'denied' },
	});
	if (updated.count !== 1) {
		throw new BudgetError('conflict', 'Запрос входа уже завершён или истёк.', 409);
	}
	return { status: 'denied' as const };
}

export async function pollDesktopToken(deviceCode: string) {
	if (!deviceCode || deviceCode.length < 20 || deviceCode.length > 200) {
		return { status: 'expired' as const };
	}
	const row = await prisma.desktopAuthRequest.findUnique({ where: { deviceCodeHash: hashSecret(deviceCode) } });
	if (!row) {
		return { status: 'expired' as const };
	}
	const now = Date.now();
	const decision = pollDecision({
		status: row.status,
		expiresAt: row.expiresAt.getTime(),
		now,
		lastPolledAt: row.lastPolledAt ? row.lastPolledAt.getTime() : null,
		intervalSec: row.pollIntervalSec,
	});
	if (decision === 'slow_down') {
		return { status: 'slow_down' as const, interval: row.pollIntervalSec };
	}
	if (decision === 'expired') {
		return { status: 'expired' as const };
	}
	if (decision === 'denied') {
		await prisma.desktopAuthRequest.update({ where: { id: row.id }, data: { lastPolledAt: new Date(now) } });
		return { status: 'denied' as const };
	}
	if (decision === 'pending') {
		await prisma.desktopAuthRequest.update({ where: { id: row.id }, data: { lastPolledAt: new Date(now) } });
		return { status: 'pending' as const, interval: row.pollIntervalSec };
	}
	if (!row.userId) {
		return { status: 'expired' as const };
	}
	const user = await prisma.user.findUnique({ where: { id: row.userId } });
	if (!user || user.isBanned) {
		return { status: 'denied' as const };
	}
	await prisma.desktopAuthRequest.update({ where: { id: row.id }, data: { lastPolledAt: new Date(now) } });
	const token = await encryptJWT({ userId: user.id, email: user.email, plan: user.plan });
	return {
		status: 'approved' as const,
		token,
		token_type: 'Bearer' as const,
		expires_in: 30 * 24 * 60 * 60,
		interval: row.pollIntervalSec,
	};
}
