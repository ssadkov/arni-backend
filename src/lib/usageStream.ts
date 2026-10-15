import { UsageParser, type ReportedUsage } from './budgetPolicy';

/** Drain upstream even after client cancellation so billed usage can be reconciled. */
export function usageStream(body: ReadableStream<Uint8Array>, settle: (usage: ReportedUsage | null) => Promise<void>) {
	const parser = new UsageParser();
	let cancelled = false;
	let complete!: () => void;
	const completed = new Promise<void>(resolve => { complete = resolve; });
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = body.getReader();
			let failed = false;
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) { break; }
					parser.push(value);
					if (!cancelled) { controller.enqueue(value); }
				}
				parser.push(new Uint8Array(), true);
			} catch {
				failed = true;
			} finally {
				try {
					await settle(parser.usage);
					if (!cancelled) {
						if (failed) { controller.error(new Error('Поток модели прерван. Расход учтён.')); }
						else { controller.close(); }
					}
				} catch {
					// Reservation stays pending on DB failure; new spending is blocked until reconciled.
					console.error('Usage settlement failed');
					if (!cancelled) { controller.error(new Error('Не удалось подтвердить расход API. Обратитесь к администратору.')); }
				} finally { reader.releaseLock(); complete(); }
			}
		},
		cancel() { cancelled = true; },
	});
	return { stream, completed };
}
