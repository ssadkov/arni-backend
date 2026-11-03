function rate(value: string | number | undefined) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : null;
}

async function centralBankRates() {
	const response = await fetch('https://www.cbr.ru/scripts/XML_daily.asp', {
		next: { revalidate: 3600 }, signal: AbortSignal.timeout(3000),
	});
	if (!response.ok) { return null; }
	// The feed uses Windows-1251. ISO codes and the numeric fields are ASCII.
	const xml = await response.text();
	const units = new Map<string, number>();
	for (const [row] of xml.matchAll(/<Valute\b[^>]*>[\s\S]*?<\/Valute>/g)) {
		const currency = row.match(/<CharCode>(USD|KZT)<\/CharCode>/)?.[1];
		if (!currency) { continue; }
		const nominal = rate(row.match(/<Nominal>(\d+)<\/Nominal>/)?.[1]);
		const value = rate(row.match(/<Value>([\d,]+)<\/Value>/)?.[1].replace(',', '.'));
		if (nominal && value) { units.set(currency, value / nominal); }
	}
	const RUB = units.get('USD') ?? null;
	const tengeInRubles = units.get('KZT');
	return { RUB, KZT: RUB && tengeInRubles ? rate(RUB / tengeInRubles) : null };
}

export async function billingRates() {
	const RUB = rate(process.env.ARNI_USD_TO_RUB);
	const KZT = rate(process.env.ARNI_USD_TO_KZT);
	const daily = RUB && KZT ? null : await centralBankRates().catch(() => null);
	return { USD: 1, RUB: RUB ?? daily?.RUB ?? null, KZT: KZT ?? daily?.KZT ?? null };
}

export function formatBillingRub(micros: number | null, rubRate: number | null, maximumFractionDigits = 4) {
	if (micros === null) { return '—'; }
	const currency = rubRate || micros === 0 ? 'RUB' : 'USD';
	const amount = new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits })
		.format(micros / 1_000_000 * (rubRate ?? 1));
	return rubRate && micros !== 0 ? '≈ ' + amount : amount;
}
