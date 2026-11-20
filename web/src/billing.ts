export type BillingPayload = {
  rates: { RUB: number | null };
  checkoutReady: boolean;
  budget: { balanceMicros: number; enabled: boolean; expired: boolean; validUntil: string; limitsEnabled: boolean } | null;
  entries: Array<{ id: string; kind: string; amountMicros: number; rubKopecks: number | null; note: string; createdAt: string }>;
  usage: Array<{ id: string; model: string; createdAt: string; costMicros: number | null; providerCostMicros: number | null; promptTokens: number; completionTokens: number }>;
  tariffs: Array<{
    id: string; name: string; provider: string;
    input: string | null; output: string | null;
    inputAmount: number | null; outputAmount: number | null;
  }>;
};

export type TariffSortKey = 'name' | 'provider' | 'output' | 'input';

const tariffSort: { key: TariffSortKey; dir: 'asc' | 'desc' } = { key: 'name', dir: 'asc' };

export function toggleTariffSort(key: TariffSortKey) {
  if (tariffSort.key === key) {
    tariffSort.dir = tariffSort.dir === 'asc' ? 'desc' : 'asc';
    return;
  }
  tariffSort.key = key;
  tariffSort.dir = 'asc';
}

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

const TARIFF_COLUMNS: Array<[TariffSortKey, string]> = [
  ['name', 'Модель'],
  ['provider', 'Провайдер'],
  ['output', 'Исходящие'],
  ['input', 'Входящие'],
];

function tariffTable(rows: BillingPayload['tariffs']) {
  const direction = tariffSort.dir === 'asc' ? 1 : -1;
  const sorted = [...rows].sort((left, right) => {
    const key = tariffSort.key;
    if (key === 'name' || key === 'provider') {
      return left[key].localeCompare(right[key], 'ru') * direction;
    }
    const leftAmount = left[key === 'output' ? 'outputAmount' : 'inputAmount'];
    const rightAmount = right[key === 'output' ? 'outputAmount' : 'inputAmount'];
    if (leftAmount == null && rightAmount == null) { return 0; }
    if (leftAmount == null) { return 1; }
    if (rightAmount == null) { return -1; }
    return (leftAmount - rightAmount) * direction;
  });
  const head = TARIFF_COLUMNS.map(([key, label]) => {
    const active = tariffSort.key === key;
    const mark = active ? (tariffSort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th aria-sort="${active ? (tariffSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" data-tariff-sort="${key}">${label}${mark}</button></th>`;
  }).join('');
  const body = sorted.map(row => `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.provider)}</td><td>${escapeHtml(row.output ?? '—')}</td><td>${escapeHtml(row.input ?? '—')}</td></tr>`).join('');
  return `<p class="muted">Цены за 1 млн токенов. Для изображений цена за одну картинку стоит в столбце «Исходящие».</p><div class="billing-table-wrap"><table class="billing-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
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
    body += tariffTable(payload.tariffs);
  }
  return `<div class="billing-tabs">${tabs}</div><div class="billing-panel">${body}<p id="billing-status" class="muted"></p></div>`;
}
