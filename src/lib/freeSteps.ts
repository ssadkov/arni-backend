import prisma from '@/lib/prisma';

// Один шаг — один запрос модели. Задача вроде «Змейки» занимает 10–30 шагов.
// Лимит бережёт общую дневную квоту OpenRouter на :free-модели.
export const FREE_DAILY_STEP_LIMIT = 150;

export type FreeStepSnapshot = {
	used: number;
	limit: number;
	remaining: number;
	resetsAt: string;
	total: number;
};

type StepRow = {
	freeStepsToday: number;
	freeStepsDay: string | null;
	freeStepsTotal: number;
};

export function utcDayKey(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

export function nextUtcMidnightIso(now = new Date()): string {
	const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	return new Date(start + 24 * 60 * 60 * 1000).toISOString();
}

export function freeStepSnapshot(
	user: { freeStepsToday: number; freeStepsDay: string | null; freeStepsTotal: number },
	now = new Date(),
): FreeStepSnapshot {
	const used = user.freeStepsDay === utcDayKey(now) ? user.freeStepsToday : 0;
	return {
		used,
		limit: FREE_DAILY_STEP_LIMIT,
		remaining: Math.max(0, FREE_DAILY_STEP_LIMIT - used),
		resetsAt: nextUtcMidnightIso(now),
		total: user.freeStepsTotal,
	};
}

export function accountPayload(user: {
	email: string;
	plan: string;
	tokenBalance: number;
	freeStepsToday: number;
	freeStepsDay: string | null;
	freeStepsTotal: number;
}) {
	return {
		email: user.email,
		plan: user.plan,
		balance: user.tokenBalance,
		freeSteps: freeStepSnapshot(user),
	};
}

export function freeStepHeaders(snapshot: FreeStepSnapshot): Record<string, string> {
	return {
		'X-Free-Steps-Limit': String(snapshot.limit),
		'X-Free-Steps-Used': String(snapshot.used),
		'X-Free-Steps-Remaining': String(snapshot.remaining),
		'X-Free-Steps-Reset': snapshot.resetsAt,
		'Access-Control-Expose-Headers':
			'X-Free-Steps-Limit, X-Free-Steps-Used, X-Free-Steps-Remaining, X-Free-Steps-Reset',
	};
}

function snapshotFromRow(row: StepRow, now = new Date()): FreeStepSnapshot {
	return freeStepSnapshot(
		{
			freeStepsToday: Number(row.freeStepsToday),
			freeStepsDay: row.freeStepsDay,
			freeStepsTotal: Number(row.freeStepsTotal),
		},
		now,
	);
}

/** Атомарно занимает один бесплатный шаг. null — дневной лимит уже исчерпан. */
export async function reserveFreeStep(userId: string, now = new Date()): Promise<FreeStepSnapshot | null> {
	const day = utcDayKey(now);
	const rows = await prisma.$queryRaw<Array<{ freeStepsToday: number; freeStepsTotal: number }>>`
		UPDATE "User"
		SET
			"freeStepsToday" = CASE
				WHEN "freeStepsDay" = ${day} THEN "freeStepsToday" + 1
				ELSE 1
			END,
			"freeStepsDay" = ${day},
			"freeStepsTotal" = "freeStepsTotal" + 1
		WHERE "id" = ${userId}
			AND (
				"freeStepsDay" IS DISTINCT FROM ${day}
				OR "freeStepsToday" < ${FREE_DAILY_STEP_LIMIT}
			)
		RETURNING "freeStepsToday", "freeStepsTotal"
	`;
	const row = rows[0];
	if (!row) {
		return null;
	}
	const used = Number(row.freeStepsToday);
	return {
		used,
		limit: FREE_DAILY_STEP_LIMIT,
		remaining: Math.max(0, FREE_DAILY_STEP_LIMIT - used),
		resetsAt: nextUtcMidnightIso(now),
		total: Number(row.freeStepsTotal),
	};
}

/** Возвращает шаг, если OpenRouter не принял запрос и квота не должна сгореть. */
export async function releaseFreeStep(userId: string, now = new Date()): Promise<FreeStepSnapshot> {
	const day = utcDayKey(now);
	const rows = await prisma.$queryRaw<StepRow[]>`
		UPDATE "User"
		SET
			"freeStepsToday" = CASE
				WHEN "freeStepsDay" = ${day} AND "freeStepsToday" > 0 THEN "freeStepsToday" - 1
				ELSE "freeStepsToday"
			END,
			"freeStepsTotal" = GREATEST("freeStepsTotal" - 1, 0)
		WHERE "id" = ${userId}
		RETURNING "freeStepsToday", "freeStepsDay", "freeStepsTotal"
	`;
	const row = rows[0];
	if (!row) {
		return {
			used: FREE_DAILY_STEP_LIMIT,
			limit: FREE_DAILY_STEP_LIMIT,
			remaining: 0,
			resetsAt: nextUtcMidnightIso(now),
			total: 0,
		};
	}
	return snapshotFromRow(row, now);
}
