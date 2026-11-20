/** 100 means the user is charged twice the provider price. */
export const DEFAULT_MARKUP_PERCENT = 100;
export const MARKUP_PROVIDERS = ['bedrock', 'openrouter', 'image'] as const;

export function applyMarkup(micros: number, percent: number): number {
	if (percent <= 0 || micros <= 0) { return micros; }
	return Math.round(micros * (100 + percent) / 100);
}

export function markedPerMillion(value: number, percent: number): number {
	if (percent <= 0) { return value; }
	return value * (100 + percent) / 100;
}

/** Most specific row wins. A free model and a missing table both stay predictable. */
export function percentFromTable(table: Map<string, number>, input: { source: string; model: string; operation?: string }): number {
	if (input.model.endsWith(':free')) { return 0; }
	const provider = input.operation === 'image' ? 'image' : input.source;
	const model = table.get(`model:${input.model}`);
	if (model !== undefined) { return model; }
	const scoped = table.get(`provider:${provider}`);
	if (scoped !== undefined) { return scoped; }
	const global = table.get('global');
	return global !== undefined ? global : DEFAULT_MARKUP_PERCENT;
}

export async function markupTable(): Promise<Map<string, number>> {
	try {
		const { default: prisma } = await import('@/lib/prisma');
		const rows = await prisma.billingMarkup.findMany({ select: { id: true, percent: true } });
		return new Map(rows.map(row => [row.id, row.percent]));
	} catch (error) {
		console.error('Markup table is unavailable:', error instanceof Error ? error.name : 'unknown');
		return new Map();
	}
}

export async function markupPercentFor(input: { source: string; model: string; operation?: string }): Promise<number> {
	return percentFromTable(await markupTable(), input);
}
