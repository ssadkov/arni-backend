export type BillingPayload = {
  rates: { RUB: number | null };
  checkoutReady: boolean;
  budget: { balanceMicros: number; enabled: boolean; expired: boolean; validUntil: string; limitsEnabled: boolean } | null;
  entries: Array<{ id: string; kind: string; amountMicros: number; rubKopecks: number | null; note: string; createdAt: string }>;
  usage: Array<{ id: string; model: string; createdAt: string; costMicros: number | null; providerCostMicros: number | null; promptTokens: number; completionTokens: number }>;
  tariffs: Array<{
    id: string; name: string; provider: string; percent: number;
    input?: { provider: string; user: string } | null;
    output?: { provider: string; user: string } | null;
    unit?: { provider: string; user: string };
  }>;
};

const SECTIONS = [
  ['topup', 'Пополнить'],
  ['payments', 'Пополнения'],
  ['expenses', 'Расходы'],
  ['tariffs', 'Тарифы'],
] as const;

export type BillingSection = typeof SECTIONS[number][0];

export function billingSection(hash: string): BillingSection | null {
  const name = hash.replace(/^#/, '');
  return SECTIONS.some(item => item[0] === name) ? name as BillingSection : null;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
}

function rub(micros: number, rate: number | null) {
  if (!rate) {
    return `$${(micros / 1_000_000).toFixed(2)}`;
  }
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(micros / 1_000_000 * rate);
}

function when(value: string) {
  return new Date(value).toLocaleString('ru-RU', { timeZone: 'Asia/Qyzylorda' });
}

const KIND: Record<string, string> = { grant: 'Бесплатно', payment: 'Оплата', payment_refund: 'Возврат' };

export function renderBilling(payload: BillingPayload, section: BillingSection) {
  const rate = payload.rates.RUB;
  const tabs = SECTIONS.map(([id, label]) => `<button type="button" data-billing-section="${id}" aria-pressed="${id === section}">${label}</button>`).join('');
  const budget = payload.budget;
  const term = !budget ? '' : new Date(budget.validUntil).getUTCFullYear() >= 2099 ? 'без срока' : `до ${budget.validUntil.slice(0, 10)}`;
  const summary = budget
    ? `<p>Остаток <strong>${rub(Math.max(0, budget.balanceMicros), rate)}</strong>, ${term}.${budget.limitsEnabled ? '' : ' Лимиты на 5 часов и неделю сняты.'}${rate ? ` Курс ${rate} ₽ за 1 USD.` : ''}</p>`
    : '<p>Платного баланса пока нет. Пополнение откроет его без срока.</p>';
  let body = summary;
  if (section === 'topup') {
    body += payload.checkoutReady
      ? '<p>Сумму вы вводите на странице оплаты. После оплаты остаток обновится по уведомлению.</p><button id="start-checkout" class="primary" type="button">Перейти к оплате</button>'
      : '<p>Оплата ещё не настроена.</p>';
  } else if (section === 'payments') {
    body += payload.entries.length === 0 ? '<p class="muted">Пополнений пока нет.</p>' : `<ul class="billing-list">${payload.entries.map(entry => `<li><span>${KIND[entry.kind] || entry.kind}</span><strong>${entry.rubKopecks != null ? `${(entry.rubKopecks / 100).toLocaleString('ru-RU')} ₽` : rub(entry.amountMicros, rate)}</strong><small>${escapeHtml(when(entry.createdAt))}</small></li>`).join('')}</ul>`;
  } else if (section === 'expenses') {
    body += payload.usage.length === 0 ? '<p class="muted">Расходов пока нет.</p>' : `<ul class="billing-list">${payload.usage.map(row => `<li><span>${escapeHtml(row.model)}</span><strong>${row.costMicros == null ? '—' : rub(row.costMicros, rate)}</strong><small>${row.providerCostMicros == null ? '' : `себестоимость ${rub(row.providerCostMicros, rate)} · `}${escapeHtml(when(row.createdAt))}</small></li>`).join('')}</ul>`;
  } else {
    body += `<ul class="billing-list">${payload.tariffs.map(row => `<li><span>${escapeHtml(row.name)} <small>${escapeHtml(row.provider)}, наценка ${row.percent}%</small></span><strong>${row.unit ? row.unit.user : `${row.input?.user ?? '—'} / ${row.output?.user ?? '—'}`}</strong><small>${row.unit ? `себестоимость ${row.unit.provider}` : `себестоимость ${row.input?.provider ?? '—'} / ${row.output?.provider ?? '—'}`}</small></li>`).join('')}</ul>`;
  }
  return `<div class="billing-tabs">${tabs}</div><div class="billing-panel">${body}<p id="billing-status" class="muted"></p></div>`;
}
