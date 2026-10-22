import { BudgetError } from '../budget';

/** Operator-controlled rollout, applied to discovery and invocation alike.
 * Unset preserves the existing internal catalog; [] disables paid models.
 * Populate only after saving a successful, versioned model validation. */
export function paidModelEnabled(model: string, verifiedFree = false): boolean {
	if (verifiedFree) { return true; }
	const raw = process.env.ARNI_PAID_MODEL_ALLOWLIST;
	if (raw === undefined || raw.trim() === '') { return true; }
	try {
		const ids: unknown = JSON.parse(raw);
		if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(id))) { throw new Error(); }
		return ids.includes(model);
	} catch {
		throw new BudgetError('model_rollout_unavailable', 'Не удалось проверить список разрешённых платных моделей. Обратитесь к администратору.', 503);
	}
}

export function requirePaidModelEnabled(model: string, verifiedFree = false): void {
	if (!paidModelEnabled(model, verifiedFree)) {
		throw new BudgetError('model_not_released', 'Платная модель ещё не включена в проверенный каталог. Обновите список и выберите доступную модель.', 403);
	}
}
