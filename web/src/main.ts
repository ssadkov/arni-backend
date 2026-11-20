import './style.css';
import { billingSection, renderBilling, toggleTariffSort, type BillingPayload, type BillingSection, type TariffSortKey } from './billing';
import { captureDesktopRequest, pendingDesktopRequest, startDesktopApproval } from './desktopAuth';
import { renderMarkdown } from './markdown';

const API = (import.meta.env.VITE_API_ORIGIN || 'https://api.arnion.ru').replace(/\/$/, '');
const TOKEN_KEY = 'arni.web.token';
const MODEL_KEY = 'arni.web.model';
const IMAGE_GEN_MODEL_KEY = 'arni.web.imageGenModel';
const FREE_ONLY_KEY = 'arni.web.freeOnly';

type Chat = { id: string; title: string; updatedAt: string };
type Hit = { title: string; url: string; snippet: string };
type ImageRef = { id: string; mediaType: string };
type Message = { id: string; role: string; text: string; status: string; sources: Hit[]; images: ImageRef[] };
type BudgetWindow = { usedMicros: number; limitMicros: number; requests: number; requestLimit: number; resetsAt: string | null };
type Account = {
  email: string;
  freeSteps: { remaining: number; limit: number; resetsAt: string };
  budget?: {
    enabled: boolean;
    expired: boolean;
    limitsEnabled?: boolean;
    balanceMicros: number;
    validUntil: string;
    fiveHour: BudgetWindow;
    weekly: BudgetWindow;
  } | null;
  billingRates?: { RUB: number | null };
};
type Model = {
  id: string;
  name?: string;
  arni_default?: boolean;
  arni_free?: boolean;
  arni_provider?: string;
  architecture?: { input_modalities?: string[] };
};
type ImageGenModel = {
  id: string;
  name: string;
  modelName?: string;
  description: string;
  purpose: 'simple' | 'text';
  costMicros: number;
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Missing app root');
}

let token = localStorage.getItem(TOKEN_KEY) || '';
let chats: Chat[] = [];
let activeId = '';
let messages: Message[] = [];
let account: Account | null = null;
let models: Model[] = [];
let pendingImage: { file: File; preview: string; id?: string } | null = null;
let imageMode = false;
let imageModels: ImageGenModel[] = [];
let imageGenEnabled: boolean | null = null;
let imageGenDefault = '';
let sending = false;
let opening = false;
let chatListRequest = 0;
let chatsLoading = false;
let chatsError = false;
let modelsLoading = false;
let modelsError = false;
const narrowScreen = matchMedia('(max-width: 800px)');

const icons = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  compose: '<path d="M12 5H5v14h14v-7M10 14l1-4 7-7 3 3-7 7-4 1Z"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m3 17 5-5 4 4 3-3 6 6"/>',
  spark: '<path d="M12 3c0 5-4 9-9 9 5 0 9 4 9 9 0-5 4-9 9-9-5 0-9-4-9-9Z"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
};

function icon(name: keyof typeof icons) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

function usd(micros: number) {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function money(micros: number) {
  const rate = account?.billingRates?.RUB;
  if (!rate) {
    return usd(micros);
  }
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(micros / 1_000_000 * rate);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
}

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  headers.set('X-Arni-Client', 'web');
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${API}${path}`, { ...init, headers });
  return response;
}

async function errorMessage(response: Response) {
  const body = await response.json().catch(() => null) as { error?: { message?: string } | string } | null;
  if (typeof body?.error === 'string') {
    return body.error;
  }
  return body?.error?.message || 'Запрос не выполнился.';
}

/** The user's pick, else a free default. Never a paid model the user did not choose: sending stays off instead. */
function selectedModel() {
  const stored = localStorage.getItem(MODEL_KEY);
  return models.find(model => model.id === stored)?.id
    || models.find(model => model.arni_default && model.arni_free === true)?.id
    || models.find(model => model.arni_free === true)?.id
    || '';
}

function selectedImageGenModel() {
  const stored = localStorage.getItem(IMAGE_GEN_MODEL_KEY);
  return imageModels.find(model => model.id === stored)?.id
    || imageModels.find(model => model.id === imageGenDefault)?.id
    || imageModels[0]?.id
    || '';
}

async function refreshImageConfig() {
  if (!token) {
    imageModels = [];
    imageGenEnabled = null;
    return;
  }
  try {
    const response = await api('/api/web/images/config');
    if (!response.ok) {
      throw new Error('Image config unavailable');
    }
    const body = await response.json() as {
      enabled?: boolean;
      default_model?: string;
      models?: ImageGenModel[];
    };
    imageGenEnabled = body.enabled === true;
    imageGenDefault = body.default_model || '';
    imageModels = Array.isArray(body.models) ? body.models : [];
  } catch {
    imageGenEnabled = false;
    imageModels = [];
  }
  if (document.querySelector('#composer')) {
    paintImageGenModels();
    paintComposer();
  }
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  captureDesktopRequest(params);
  if (code || error || params.has('desktop_request')) {
    history.replaceState({}, '', '/');
  }
  if (code) {
    const response = await fetch(`${API}/api/web/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (response.ok) {
      const body = await response.json() as { token: string };
      token = body.token;
      localStorage.setItem(TOKEN_KEY, token);
    }
  } else if (error) {
    renderGate(pendingDesktopRequest()
      ? 'Не удалось войти. Попробуйте ещё раз. После входа подтвердите код из окна Arni Lite.'
      : 'Не удалось войти. Попробуйте ещё раз.');
    return;
  }
  if (!token) {
    renderGate(pendingDesktopRequest() ? 'После входа подтвердите код из окна Arni Lite. Подтверждайте только тот код, который видите в программе.' : '');
    return;
  }
  const desktopRequest = pendingDesktopRequest();
  if (desktopRequest && app) {
    startDesktopApproval(app, {
      api: API,
      token,
      requestId: desktopRequest,
      onFinished: () => { void enterApp(); },
    });
    return;
  }
  await enterApp();
}

async function enterApp() {
  await refreshAccount();
  if (!token) {
    return;
  }
  renderApp();
  openHashedBilling();
  void refreshChats();
  void refreshModels();
  void refreshImageConfig();
}

let billingPayload: BillingPayload | null = null;

async function showBilling(section: BillingSection) {
  document.querySelector<HTMLDialogElement>('#account-dialog')?.close();
  const dialog = document.querySelector<HTMLDialogElement>('#billing-dialog');
  const body = document.querySelector('#billing-body');
  if (!dialog || !body) {
    return;
  }
  dialog.showModal();
  if (!billingPayload) {
    body.innerHTML = '<p class="muted">Загрузка…</p>';
    const response = await api('/api/billing');
    if (!response.ok) {
      body.innerHTML = `<p class="error">${escapeHtml(await errorMessage(response))}</p>`;
      return;
    }
    billingPayload = await response.json() as BillingPayload;
  }
  paintBilling(section);
}

function paintBilling(section: BillingSection) {
  const body = document.querySelector('#billing-body');
  if (!body || !billingPayload) {
    return;
  }
  body.innerHTML = renderBilling(billingPayload, section);
}

async function onBillingClick(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const sortKey = target.closest<HTMLButtonElement>('[data-tariff-sort]')?.dataset.tariffSort;
  if (sortKey === 'name' || sortKey === 'provider' || sortKey === 'output' || sortKey === 'input') {
    toggleTariffSort(sortKey as TariffSortKey);
    paintBilling('tariffs');
    return;
  }
  const selected = target.closest<HTMLButtonElement>('[data-billing-section]')?.dataset.billingSection;
  const section = selected ? billingSection(selected) : null;
  if (section) {
    paintBilling(section);
    return;
  }
  if (!target.closest('#start-checkout')) {
    return;
  }
  const status = document.querySelector('#billing-status');
  if (status) {
    status.textContent = 'Открываем оплату…';
  }
  const response = await api('/api/billing/checkout');
  const payload = await response.json().catch(() => null) as { url?: string; error?: string } | null;
  if (!response.ok || !payload?.url?.startsWith('https://')) {
    if (status) {
      status.textContent = typeof payload?.error === 'string' ? payload.error : 'Не удалось открыть оплату.';
    }
    return;
  }
  location.assign(payload.url);
}

function openHashedBilling() {
  const section = billingSection(location.hash);
  if (section) {
    void showBilling(section);
  }
}

window.addEventListener('hashchange', () => {
  if (token) {
    openHashedBilling();
  }
});

const YANDEX_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#FC3F1D"/><path fill="#fff" d="M13.32 7.67h-.93c-1.7 0-2.6.86-2.6 2.13 0 1.44.62 2.11 1.89 2.97l1.05.7-3.02 4.52H7.45l2.72-4.04c-1.56-1.12-2.44-2.2-2.44-4.04 0-2.3 1.6-3.87 4.65-3.87h3.03v11.95h-2.09V7.67z"/></svg>';
const VK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#0077FF"/><path fill="#fff" d="M12.77 17.29c-5.2 0-8.17-3.56-8.29-9.49h2.6c.09 4.35 2.01 6.19 3.53 6.57V7.8h2.45v3.75c1.5-.16 3.08-1.87 3.61-3.75h2.45c-.41 2.32-2.11 4.03-3.32 4.73 1.21.57 3.15 2.05 3.89 4.76h-2.7c-.58-1.81-2.03-3.21-3.93-3.4v3.4h-.29z"/></svg>';
const GOOGLE_ICON = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

function renderGate(message: string) {
  app!.innerHTML = `<main class="gate"><section class="gate-card">
    <h1>Arni</h1>
    <p>Чат с памятью, картинками и поиском. Вход тот же, что в редакторе.</p>
    ${message ? `<p class="error">${escapeHtml(message)}</p>` : ''}
    <div class="actions">
      <a class="primary" href="${API}/api/web/auth/yandex/start">${YANDEX_ICON}Войти через Яндекс</a>
      <a href="${API}/api/web/auth/vk/start">${VK_ICON}Войти через VK</a>
      <a href="${API}/api/web/auth/google/start">${GOOGLE_ICON}Войти через Google</a>
    </div>
  </section></main>`;
}

function limitsHtml() {
  if (!account) {
    return '';
  }
  const budget = account.budget;
  if (!budget) {
    return `<div><strong>${escapeHtml(account.email)}</strong><dl><div><dt>Бесплатные шаги</dt><dd>${account.freeSteps.remaining} из ${account.freeSteps.limit}</dd></div></dl></div>`;
  }
  const windowLine = (title: string, window: BudgetWindow) => `<div><dt>${title}</dt><dd>${money(window.usedMicros)} / ${money(window.limitMicros)} · ${window.requests}/${window.requestLimit}</dd></div>`;
  const state = !budget.enabled || budget.expired ? '<p class="error">Доступ приостановлен или срок истёк.</p>' : '';
  const term = new Date(budget.validUntil).getUTCFullYear() >= 2099 ? 'без срока' : `до ${escapeHtml(budget.validUntil.slice(0, 10))}`;
  return `<div><strong>${escapeHtml(account.email)}</strong>${state}<dl>
    <div><dt>Бюджет</dt><dd>${money(Math.max(0, budget.balanceMicros))} ${term}</dd></div>
    ${budget.limitsEnabled === false ? '' : `${windowLine('5 часов', budget.fiveHour)}${windowLine('7 дней', budget.weekly)}`}
  </dl></div>`;
}

function accountSummary() {
  if (!account) {
    return '';
  }
  const { budget, freeSteps } = account;
  if (budget?.enabled && !budget.expired) {
    return `Баланс ${money(Math.max(0, budget.balanceMicros))}`;
  }
  return freeSteps ? `Бесплатные шаги · ${freeSteps.remaining} из ${freeSteps.limit}` : '';
}

function setChatsOpen(open: boolean) {
  const sidebar = document.querySelector('#sidebar');
  const trigger = document.querySelector<HTMLButtonElement>('#show-chats');
  const main = document.querySelector<HTMLElement>('.main');
  if (!sidebar || !trigger || !main) {
    return;
  }
  const wasOpen = sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  document.querySelector('#backdrop')?.classList.toggle('open', open);
  trigger.setAttribute('aria-expanded', String(open));
  main.inert = open;
  if (open) {
    document.querySelector<HTMLButtonElement>('#hide-chats')?.focus();
  } else if (wasOpen && narrowScreen.matches) {
    trigger.focus();
  }
}

function renderApp() {
  app!.innerHTML = `<div class="shell">
    <div class="workspace">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-header">
          <strong class="brand">arni</strong>
          <button id="hide-chats" class="icon-button menu" type="button" aria-label="Закрыть список чатов">${icon('close')}</button>
        </div>
        <button id="new-chat" class="primary new-chat" type="button">${icon('compose')} Новый чат</button>
        <nav class="history" aria-label="История чатов">
          <label class="chat-search" for="chat-search">
            ${icon('search')}<span class="sr-only">Поиск чатов по названию</span>
            <input type="search" id="chat-search" placeholder="Поиск чатов" aria-controls="chat-list" autocomplete="off" />
          </label>
          <div class="chats" id="chat-list"></div>
        </nav>
        <button id="show-account" class="account-button" type="button" aria-haspopup="dialog">
          <span class="account-details">
            <span class="account-name">${escapeHtml(account?.email || 'Аккаунт')}</span>
            <span class="account-summary" id="account-summary">${escapeHtml(accountSummary())}</span>
          </span>${icon('chevron')}
        </button>
      </aside>
      <button id="backdrop" class="backdrop" type="button" tabindex="-1" aria-label="Закрыть список чатов"></button>
      <main class="main">
        <header class="topbar">
          <div class="topbar-inner">
            <button id="show-chats" class="icon-button menu" type="button" aria-label="Чаты" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button>
            <div id="chat-title" class="chat-title" role="heading" aria-level="1" tabindex="-1">Новый чат</div>
          </div>
        </header>
        <div class="conversation" id="conversation">
          <p id="copy-status" class="sr-only" role="status"></p>
          <div class="thread" id="thread" aria-label="Сообщения"></div>
          <form class="composer" id="composer">
            <div id="attachment" class="attachment" hidden>
              <img id="file-preview" alt="" />
              <span id="file-name"></span>
              <button id="remove-file" class="icon-button" type="button" aria-label="Убрать изображение">${icon('close')}</button>
            </div>
            <label class="sr-only" for="input">Сообщение</label>
            <textarea id="input" placeholder="Напишите сообщение…" rows="1" maxlength="16000"></textarea>
            <div class="composer-tools">
              <div class="add-tools">
                <button id="show-tools" class="icon-button add-button" type="button" aria-label="Добавить" aria-controls="tool-panel" aria-expanded="false">${icon('plus')}</button>
                <div id="tool-panel" class="tool-panel" hidden>
                  <button id="attach-image" type="button">${icon('image')} <span>Прикрепить изображение<small>PNG или JPEG · до 2,5 МБ</small></span></button>
                  <button id="draw" type="button">${icon('spark')} Создать изображение</button>
                </div>
                <input id="file" type="file" accept="image/png,image/jpeg" hidden />
              </div>
              <button id="show-models" class="model-trigger" type="button" aria-haspopup="dialog" aria-label="Выбрать модель">
                <span id="current-model">Выбрать модель</span>${icon('chevron')}
              </button>
              <button id="image-mode" class="mode-button" type="button" aria-label="Выйти из режима создания изображения" hidden>${icon('spark')} Изображение ${icon('close')}</button>
              <button id="send" class="primary send-button" type="submit" aria-label="Отправить">${icon('send')}<span>Отправить</span></button>
            </div>
            <div id="image-gen-picker" class="image-gen-picker" hidden>
              <p class="image-gen-hint muted">Выберите тип картинки. Описание лучше на английском — русский Stability сейчас отклоняет. Сервер не угадывает модель сам.</p>
              <div id="image-gen-options" class="image-gen-options" role="radiogroup" aria-label="Модель изображения"></div>
            </div>
            <p id="status" class="composer-status" role="status" hidden></p>
          </form>
        </div>
      </main>
    </div>
    <dialog id="model-dialog" class="model-dialog" aria-labelledby="model-heading">
      <div class="dialog-header">
        <h2 id="model-heading">Выбор модели</h2>
        <form method="dialog"><button class="icon-button" aria-label="Закрыть">${icon('close')}</button></form>
      </div>
      <div class="model-filters">
        <label class="sr-only" for="model-search">Поиск по моделям</label>
        <input type="search" id="model-search" placeholder="Найти модель" autofocus />
        <label class="free-filter"><input type="checkbox" id="free-only" /> Только бесплатные</label>
      </div>
      <div id="model-list" class="model-list" aria-label="Доступные модели"></div>
    </dialog>
    <dialog id="account-dialog" aria-labelledby="account-heading">
      <div class="dialog-header">
        <h2 id="account-heading">Аккаунт</h2>
        <form method="dialog"><button class="icon-button" aria-label="Закрыть">${icon('close')}</button></form>
      </div>
      <div class="account-content">
        <div class="limits" id="limits">${limitsHtml()}</div>
        <div class="billing-links">
          <button id="show-topup" type="button">Пополнить</button>
          <button id="show-payments" type="button">Пополнения</button>
          <button id="show-expenses" type="button">Расходы</button>
          <button id="show-tariffs" type="button">Тарифы</button>
        </div>
        <div class="actions">
          <button id="show-memory" type="button">Память</button>
          <button id="sign-out" type="button">Выйти</button>
        </div>
      </div>
    </dialog>
    <dialog id="billing-dialog" aria-labelledby="billing-heading">
      <div class="dialog-header">
        <h2 id="billing-heading">Биллинг</h2>
        <form method="dialog"><button class="icon-button" aria-label="Закрыть">${icon('close')}</button></form>
      </div>
      <div class="account-content" id="billing-body"></div>
    </dialog>
    <dialog id="memory-dialog" aria-labelledby="memory-heading">
      <form method="dialog" class="memory-form">
        <h2 id="memory-heading">Память веб-чата</h2>
        <label for="memory" class="muted">Эти сведения доступны модели во всех ваших веб-чатах.</label>
        <textarea id="memory" maxlength="4000" placeholder="Что Арни стоит помнить?"></textarea>
        <p id="memory-status" class="muted"></p>
        <div class="actions">
          <button id="save-memory" class="primary" type="button" value="">Сохранить</button>
          <button id="close-memory" type="submit" value="cancel">Закрыть</button>
        </div>
      </form>
    </dialog>
  </div>`;
  document.querySelector('#sign-out')?.addEventListener('click', signOut);
  document.querySelector('#new-chat')?.addEventListener('click', newChat);
  document.querySelector('#show-account')?.addEventListener('click', () => document.querySelector<HTMLDialogElement>('#account-dialog')?.showModal());
  for (const section of ['topup', 'payments', 'expenses', 'tariffs'] as const) {
    document.querySelector(`#show-${section}`)?.addEventListener('click', () => { void showBilling(section); });
  }
  document.querySelector('#billing-body')?.addEventListener('click', event => { void onBillingClick(event); });
  document.querySelector('#show-memory')?.addEventListener('click', () => void openMemory());
  document.querySelector('#save-memory')?.addEventListener('click', () => void saveMemory());
  document.querySelector('#show-chats')?.addEventListener('click', () => setChatsOpen(true));
  document.querySelector('#hide-chats')?.addEventListener('click', () => setChatsOpen(false));
  document.querySelector('#backdrop')?.addEventListener('click', () => setChatsOpen(false));
  document.querySelector('#chat-search')?.addEventListener('input', paintChats);
  document.querySelector('#thread')?.addEventListener('click', event => void copyMessage(event));
  document.querySelector<HTMLFormElement>('#composer')?.addEventListener('submit', event => {
    event.preventDefault();
    void send(imageMode);
  });
  document.querySelector<HTMLTextAreaElement>('#input')?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(pointer: fine)').matches) {
      event.preventDefault();
      void send(imageMode);
    }
  });
  document.querySelector('#input')?.addEventListener('input', paintComposer);
  document.querySelector('#show-tools')?.addEventListener('click', () => setToolsOpen(document.querySelector<HTMLElement>('#tool-panel')?.hidden ?? false));
  document.querySelector('#attach-image')?.addEventListener('click', () => {
    setToolsOpen(false, true);
    document.querySelector<HTMLInputElement>('#file')?.click();
  });
  document.querySelector('#draw')?.addEventListener('click', () => {
    imageMode = true;
    setToolsOpen(false);
    paintComposer();
    void refreshImageConfig().then(() => {
      if (imageGenEnabled === false) {
        setStatus('Генерация изображений пока недоступна для этого аккаунта.', true);
      }
      document.querySelector<HTMLTextAreaElement>('#input')?.focus();
    });
  });
  document.querySelector('#image-mode')?.addEventListener('click', () => {
    imageMode = false;
    paintComposer();
    document.querySelector<HTMLTextAreaElement>('#input')?.focus();
  });
  document.querySelector('#remove-file')?.addEventListener('click', () => {
    clearAttachment();
    setStatus('');
    paintComposer();
    document.querySelector<HTMLButtonElement>('#show-tools')?.focus();
  });
  document.querySelector<HTMLInputElement>('#file')?.addEventListener('change', attachFile);
  document.querySelector('.shell')?.addEventListener('click', event => {
    if (event.target instanceof Element && !event.target.closest('.add-tools')) {
      setToolsOpen(false);
    }
  });
  document.querySelector('.shell')?.addEventListener('keydown', event => {
    if ((event as KeyboardEvent).key === 'Escape' && !document.querySelector('dialog[open]')) {
      if (!document.querySelector<HTMLElement>('#tool-panel')?.hidden) {
        setToolsOpen(false, true);
      } else if (document.querySelector('#sidebar')?.classList.contains('open')) {
        setChatsOpen(false);
      }
    }
  });
  const modelDialog = document.querySelector<HTMLDialogElement>('#model-dialog')!;
  const modelSearch = document.querySelector<HTMLInputElement>('#model-search')!;
  const freeOnly = document.querySelector<HTMLInputElement>('#free-only')!;
  modelSearch.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      modelDialog.close();
    }
  });
  freeOnly.checked = localStorage.getItem(FREE_ONLY_KEY) === 'true';
  document.querySelector('#show-models')?.addEventListener('click', () => {
    modelSearch.value = '';
    paintModels();
    modelDialog.showModal();
  });
  modelSearch.addEventListener('input', paintModels);
  freeOnly.addEventListener('change', () => {
    localStorage.setItem(FREE_ONLY_KEY, String(freeOnly.checked));
    paintModels();
  });
  paintChats();
  paintModels();
  paintMessages();
  paintComposer();
}

function paintLimits() {
  const limits = document.querySelector('#limits');
  if (limits) {
    limits.innerHTML = limitsHtml();
  }
  const summary = document.querySelector('#account-summary');
  if (summary) {
    summary.textContent = accountSummary();
  }
}

async function openMemory() {
  document.querySelector<HTMLDialogElement>('#account-dialog')?.close();
  const dialog = document.querySelector<HTMLDialogElement>('#memory-dialog');
  const status = document.querySelector('#memory-status');
  if (status) {
    status.textContent = '';
    status.classList.remove('error');
  }
  dialog?.showModal();
  await loadMemory();
}

function paintChats() {
  const list = document.querySelector('#chat-list');
  const heading = document.querySelector<HTMLElement>('#chat-title');
  if (!list || !heading) {
    return;
  }
  heading.textContent = chats.find(chat => chat.id === activeId)?.title || 'Новый чат';
  heading.title = heading.textContent;
  const query = document.querySelector<HTMLInputElement>('#chat-search')!.value.trim().toLocaleLowerCase('ru');
  const matching = chats.filter(chat => (chat.title || 'Новый чат').toLocaleLowerCase('ru').includes(query));
  const rows = matching.map(chat => {
    const title = escapeHtml(chat.title || 'Новый чат');
    return `<button class="chat-row" type="button" title="${title}" data-id="${escapeHtml(chat.id)}" ${chat.id === activeId ? 'aria-current="true"' : ''} ${sending || opening ? 'disabled' : ''}>${title}</button>`;
  }).join('');
  let status = '';
  if (chatsError) {
    status = '<div class="empty"><p class="error" role="status">Не удалось обновить список чатов.</p><button id="retry-chats" type="button">Повторить</button></div>';
  } else if (!rows) {
    status = `<p class="muted empty" role="status">${chatsLoading ? 'Загружаем чаты…' : query ? 'Чаты не найдены' : 'Пока нет чатов'}</p>`;
  }
  list.innerHTML = rows + status;
  list.querySelectorAll<HTMLButtonElement>('[data-id]').forEach(button => button.addEventListener('click', () => void openChat(button.dataset.id!)));
  list.querySelector('#retry-chats')?.addEventListener('click', () => {
    document.querySelector<HTMLInputElement>('#chat-search')?.focus();
    void refreshChats();
  });
}

function paintModels() {
  const list = document.querySelector('#model-list');
  const label = document.querySelector('#current-model');
  if (!list || !label) {
    return;
  }
  const current = selectedModel();
  const chosen = models.find(model => model.id === current);
  label.textContent = chosen ? chosen.name || chosen.id : 'Выбрать модель';
  const trigger = document.querySelector<HTMLButtonElement>('#show-models')!;
  trigger.title = label.textContent;
  trigger.setAttribute('aria-label', chosen ? `Выбрать модель. Сейчас выбрана ${label.textContent}` : 'Выбрать модель');
  if (modelsLoading || modelsError) {
    list.innerHTML = modelsLoading
      ? '<p class="model-state muted" role="status">Загружаем модели…</p>'
      : '<div class="model-state"><p class="error">Не удалось загрузить модели.</p><button id="retry-models" type="button">Повторить</button></div>';
    list.querySelector('#retry-models')?.addEventListener('click', () => void refreshModels());
    return;
  }
  const query = document.querySelector<HTMLInputElement>('#model-search')?.value.trim().toLowerCase() || '';
  const freeOnly = document.querySelector<HTMLInputElement>('#free-only')?.checked;
  const matching = models.filter(model => (!freeOnly || model.arni_free === true) && `${model.name || ''} ${model.id}`.toLowerCase().includes(query));
  if (!matching.length) {
    list.innerHTML = `<p class="model-state muted" role="status">${models.length ? 'Модели не найдены. Измените поиск или фильтр.' : 'Для вашего аккаунта пока нет доступных моделей.'}</p>`;
    return;
  }
  const groups = [
    { title: 'Бесплатные', models: matching.filter(model => model.arni_free === true) },
    { title: 'Модели по бюджету', models: matching.filter(model => model.arni_free !== true) },
  ];
  list.innerHTML = groups.filter(group => group.models.length).map(group => `<section class="model-group">
    <h3>${group.title}</h3>
    ${group.models.map(model => `<button type="button" class="model-option" data-model="${escapeHtml(model.id)}" aria-pressed="${model.id === current}">
      <span><strong>${escapeHtml(model.name || model.id)}</strong><small>${escapeHtml(model.arni_provider === 'bedrock' ? 'Amazon Bedrock' : model.arni_provider === 'openrouter' ? 'OpenRouter' : model.id)}${supportsImage(model) ? ' · Изображения' : ''}</small></span>
      ${model.id === current ? icon('check') : ''}
    </button>`).join('')}
  </section>`).join('');
  list.querySelectorAll<HTMLButtonElement>('[data-model]').forEach(button => button.addEventListener('click', () => {
    localStorage.setItem(MODEL_KEY, button.dataset.model!);
    document.querySelector<HTMLDialogElement>('#model-dialog')?.close();
    setStatus('');
    paintModels();
    paintComposer();
  }));
}

function supportsImage(model: Model) {
  return model.architecture?.input_modalities?.includes('image') === true;
}

function setToolsOpen(open: boolean, returnFocus = false) {
  const trigger = document.querySelector<HTMLButtonElement>('#show-tools')!;
  document.querySelector<HTMLElement>('#tool-panel')!.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
  if (returnFocus) {
    trigger.focus();
  }
}

function setStatus(text: string, error = false) {
  const status = document.querySelector<HTMLElement>('#status');
  if (status) {
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle('error', error);
  }
}

function paintImageGenModels() {
  const picker = document.querySelector<HTMLElement>('#image-gen-picker');
  const options = document.querySelector('#image-gen-options');
  if (!picker || !options) {
    return;
  }
  picker.hidden = !imageMode;
  if (!imageMode) {
    return;
  }
  if (!imageModels.length) {
    options.innerHTML = '<p class="muted">Загружаем модели изображений…</p>';
    return;
  }
  const current = selectedImageGenModel();
  options.innerHTML = imageModels.map(model => `<button type="button" class="image-gen-option" data-image-model="${escapeHtml(model.id)}" aria-pressed="${model.id === current}">
    <span><strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.modelName || model.id)} · ${usd(model.costMicros)} · ${escapeHtml(model.description)}</small></span>
    ${model.id === current ? icon('check') : ''}
  </button>`).join('');
  options.querySelectorAll<HTMLButtonElement>('[data-image-model]').forEach(button => button.addEventListener('click', () => {
    localStorage.setItem(IMAGE_GEN_MODEL_KEY, button.dataset.imageModel!);
    paintImageGenModels();
    paintComposer();
  }));
}

function paintComposer() {
  const input = document.querySelector<HTMLTextAreaElement>('#input')!;
  input.placeholder = imageMode ? 'Опишите изображение' : 'Напишите сообщение…';
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
  input.readOnly = sending || opening;
  document.querySelector<HTMLElement>('#image-mode')!.hidden = !imageMode;
  document.querySelector<HTMLButtonElement>('#image-mode')!.disabled = sending || opening;
  document.querySelector<HTMLElement>('#attachment')!.hidden = !pendingImage || imageMode;
  document.querySelector<HTMLButtonElement>('#remove-file')!.disabled = sending || opening;
  document.querySelector<HTMLButtonElement>('#show-tools')!.disabled = sending || opening;
  const modelTrigger = document.querySelector<HTMLButtonElement>('#show-models')!;
  modelTrigger.hidden = imageMode;
  modelTrigger.disabled = sending;
  document.querySelector<HTMLButtonElement>('#new-chat')!.disabled = sending || opening;
  document.querySelector<HTMLButtonElement>('#sign-out')!.disabled = sending || opening;
  paintImageGenModels();
  const imageModelReady = !!selectedImageGenModel() && imageGenEnabled !== false;
  document.querySelector<HTMLButtonElement>('#send')!.disabled = sending || opening || (imageMode
    ? !input.value.trim() || !imageModelReady
    : !selectedModel() || (!input.value.trim() && !pendingImage));
}

function paintMessages() {
  const thread = document.querySelector('#thread');
  if (!thread) {
    return;
  }
  document.querySelector('#conversation')?.classList.toggle('is-empty', !messages.length && !opening && !sending);
  if (opening) {
    thread.innerHTML = '<p class="muted empty-thread" role="status">Открываем чат…</p>';
    return;
  }
  if (!messages.length) {
    thread.innerHTML = sending ? '' : '<div class="empty-thread"><h2>Чем помочь?</h2></div>';
    return;
  }
  thread.innerHTML = messages.map((message, index) => {
    const user = message.role === 'user';
    const author = user ? 'Вы' : 'Arni';
    const images = message.images.map(image => `<img data-image="${escapeHtml(image.id)}" alt="${user ? 'Прикреплённое изображение' : 'Изображение от Арни'}" />`).join('');
    const links = message.sources?.filter(hit => /^https?:\/\//i.test(hit.url));
    const sources = links?.length ? `<ol class="sources">${links.map(hit => `<li><a href="${escapeHtml(hit.url)}" target="_blank" rel="noreferrer">${escapeHtml(hit.title)}</a></li>`).join('')}</ol>` : '';
    const copy = message.text ? `<button class="icon-button copy-button" type="button" data-copy-index="${index}" aria-label="Копировать сообщение" title="Копировать сообщение">${icon('copy')}</button>` : '';
    return `<article class="bubble${user ? ' user' : ''}" aria-labelledby="message-author-${index}">
      <div class="message-header"><span id="message-author-${index}">${author}</span>${copy}</div>
      <div class="message-text">${renderMarkdown(message.text)}</div>
      ${images}${sources}${message.status === 'incomplete' ? '<p class="muted">Ответ оборвался.</p>' : ''}
    </article>`;
  }).join('');
  thread.querySelectorAll<HTMLImageElement>('img[data-image]').forEach(image => {
    void loadImage(image);
  });
  thread.scrollTop = thread.scrollHeight;
}

async function copyMessage(event: Event) {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-copy-index]') : null;
  const message = button && messages[Number(button.dataset.copyIndex)];
  if (!button || !message?.text) {
    return;
  }
  const status = document.querySelector('#copy-status')!;
  status.textContent = '';
  try {
    await navigator.clipboard.writeText(message.text);
    status.textContent = 'Сообщение скопировано.';
    button.innerHTML = icon('check');
    window.setTimeout(() => { button.innerHTML = icon('copy'); }, 1500);
  } catch {
    if (button.isConnected) {
      setStatus('Не удалось скопировать сообщение. Выделите и скопируйте текст вручную.', true);
    }
  }
}

async function loadImage(image: HTMLImageElement) {
  try {
    const response = await api(`/api/web/images/${image.dataset.image}`);
    if (response.ok && image.isConnected) {
      const url = URL.createObjectURL(await response.blob());
      image.src = url;
      void image.decode().catch(() => undefined).finally(() => URL.revokeObjectURL(url));
    }
  } catch {
    // Keep the image's alternative text if the download fails.
  }
}

async function refreshAccount() {
  const response = await api('/api/account');
  if (response.status === 401) {
    signOut();
    return;
  }
  const body = await response.json() as { user: Account };
  account = body.user;
}

async function refreshModels() {
  modelsLoading = true;
  modelsError = false;
  paintModels();
  try {
    const response = await api('/api/models');
    if (!response.ok) {
      throw new Error('Model catalog unavailable');
    }
    const body = await response.json() as { data: Model[] };
    models = body.data || [];
  } catch {
    modelsError = true;
  } finally {
    modelsLoading = false;
    if (document.querySelector('#composer')) {
      paintModels();
      paintComposer();
    }
  }
}

async function refreshChats() {
  const request = ++chatListRequest;
  chatsLoading = true;
  chatsError = false;
  paintChats();
  try {
    const response = await api('/api/web/chats');
    if (!response.ok) {
      throw new Error('Chat list unavailable');
    }
    const body = await response.json() as { chats: Chat[] };
    if (request === chatListRequest) {
      chats = body.chats;
    }
  } catch {
    if (request === chatListRequest) {
      chatsError = true;
    }
  } finally {
    if (request === chatListRequest) {
      chatsLoading = false;
      paintChats();
    }
  }
}

async function openChat(id: string) {
  if (sending || opening) {
    return;
  }
  setChatsOpen(false);
  opening = true;
  setStatus('');
  paintChats();
  paintMessages();
  paintComposer();
  try {
    await loadChat(id);
    activeId = id;
    clearDraft();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Не удалось открыть чат.', true);
  } finally {
    opening = false;
    paintChats();
    paintMessages();
    paintComposer();
    if (document.activeElement === document.body) {
      document.querySelector<HTMLElement>('#chat-title')?.focus();
    }
  }
}

async function loadChat(id: string) {
  const response = await api(`/api/web/chats/${id}/messages`);
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  const body = await response.json() as { messages: Message[] };
  messages = body.messages;
}

function newChat() {
  activeId = '';
  messages = [];
  clearDraft();
  setStatus('');
  setChatsOpen(false);
  paintChats();
  paintMessages();
  paintComposer();
  document.querySelector<HTMLTextAreaElement>('#input')?.focus();
}

function clearDraft() {
  document.querySelector<HTMLTextAreaElement>('#input')!.value = '';
  clearAttachment();
  imageMode = false;
}

async function loadMemory() {
  const response = await api('/api/web/memory');
  if (!response.ok) {
    return;
  }
  const body = await response.json() as { text: string };
  const field = document.querySelector<HTMLTextAreaElement>('#memory');
  if (field) {
    field.value = body.text;
  }
}

async function saveMemory() {
  const field = document.querySelector<HTMLTextAreaElement>('#memory');
  const response = await api('/api/web/memory', { method: 'PUT', body: JSON.stringify({ text: field?.value || '' }) });
  const status = document.querySelector('#memory-status');
  if (!status) {
    return;
  }
  status.classList.toggle('error', !response.ok);
  status.textContent = response.ok ? 'Сохранено' : await errorMessage(response);
}

function clearAttachment() {
  if (pendingImage) {
    URL.revokeObjectURL(pendingImage.preview);
    pendingImage = null;
  }
  document.querySelector<HTMLImageElement>('#file-preview')?.removeAttribute('src');
}

function attachFile() {
  const input = document.querySelector<HTMLInputElement>('#file')!;
  const file = input.files?.[0];
  input.value = '';
  if (!file) {
    return;
  }
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 2_500_000) {
    setStatus('Выберите PNG или JPEG размером до 2,5 МБ.', true);
    return;
  }
  clearAttachment();
  pendingImage = { file, preview: URL.createObjectURL(file) };
  imageMode = false;
  document.querySelector<HTMLImageElement>('#file-preview')!.src = pendingImage.preview;
  document.querySelector('#file-name')!.textContent = file.name;
  const model = models.find(item => item.id === selectedModel());
  setStatus(model && !supportsImage(model) ? 'Для вложения выберите модель с поддержкой изображений.' : '');
  paintComposer();
}

async function uploadImage(image: NonNullable<typeof pendingImage>) {
  if (!image.id) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
      reader.readAsDataURL(image.file);
    });
    const response = await api('/api/web/images', { method: 'POST', body: JSON.stringify({ dataUrl }) });
    if (!response.ok) {
      throw new Error(await errorMessage(response));
    }
    const body = await response.json() as { id: string };
    image.id = body.id;
  }
  return image.id;
}

async function send(draw: boolean) {
  if (sending || opening) {
    return;
  }
  const text = document.querySelector<HTMLTextAreaElement>('#input')!.value.trim();
  const image = draw ? null : pendingImage;
  const model = selectedModel();
  if ((!text && !image) || (!draw && !model)) {
    return;
  }
  const selected = models.find(item => item.id === model);
  if (image && selected && !supportsImage(selected)) {
    setStatus('Для вложения выберите модель с поддержкой изображений.', true);
    return;
  }

  const imageGenModel = draw ? selectedImageGenModel() : '';
  const imageGenCard = draw ? imageModels.find(item => item.id === imageGenModel) : undefined;
  if (draw && (!imageGenModel || imageGenEnabled === false)) {
    setStatus(imageGenEnabled === false
      ? 'Генерация изображений пока недоступна для этого аккаунта.'
      : 'Выберите модель изображения.', true);
    return;
  }

  sending = true;
  setToolsOpen(false);
  setStatus(draw
    ? `Создаём изображение${imageGenCard ? ` · ${imageGenCard.name} · ${imageGenCard.modelName || imageGenCard.id} · ${usd(imageGenCard.costMicros)}` : ''}…`
    : 'Готовим ответ…');
  paintChats();
  paintComposer();
  let submitted = false;
  try {
    if (!activeId) {
      const response = await api('/api/web/chats', { method: 'POST' });
      if (!response.ok) {
        throw new Error(await errorMessage(response));
      }
      const chat = await response.json() as Chat;
      activeId = chat.id;
      chats.unshift(chat);
      paintChats();
    }

    const imageId = image ? await uploadImage(image) : undefined;
    const path = draw ? 'images' : 'messages';
    const payload = draw
      ? { prompt: text, aspect_ratio: '1:1', model: imageGenModel }
      : { text, model, imageId };
    submitted = true;
    const response = await api(`/api/web/chats/${activeId}/${path}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(await errorMessage(response));
    }
    document.querySelector<HTMLTextAreaElement>('#input')!.value = '';
    if (!draw) {
      clearAttachment();
      if (!response.body) {
        throw new Error('Не удалось получить ответ.');
      }
      paintComposer();
      await streamReply(response.body, text, imageId);
    }
    await loadChat(activeId);
    setStatus('');
  } catch (error) {
    if (submitted) {
      const knownIds = new Set(messages.map(message => message.id));
      await loadChat(activeId).then(() => {
        const saved = messages.some(message => !knownIds.has(message.id) && message.role === 'user' &&
          (image?.id ? message.images.some(item => item.id === image.id) : message.text === text));
        if (saved) {
          document.querySelector<HTMLTextAreaElement>('#input')!.value = '';
          if (image) {
            clearAttachment();
          }
        }
      }).catch(() => undefined);
    }
    setStatus(error instanceof Error ? error.message : 'Не удалось отправить сообщение.', true);
  } finally {
    sending = false;
    paintMessages();
    paintComposer();
    paintChats();
    void refreshChats();
    void refreshAccount().then(paintLimits).catch(() => undefined);
  }
}

async function streamReply(body: ReadableStream<Uint8Array>, text: string, imageId?: string) {
  const draft: Message = { id: 'draft', role: 'assistant', text: '', status: 'complete', sources: [], images: [] };
  const images = imageId ? [{ id: imageId, mediaType: '' }] : [];
  messages.push({ id: 'outgoing', role: 'user', text, status: 'complete', sources: [], images }, draft);
  paintMessages();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:') || trimmed === 'data: [DONE]') {
        continue;
      }
      let event: { choices?: Array<{ delta?: { content?: string } }>; arni_sources?: Hit[]; error?: { message?: string } };
      try {
        event = JSON.parse(trimmed.slice(5));
      } catch {
        continue;
      }
      if (event.error) {
        await reader.cancel().catch(() => undefined);
        throw new Error(event.error.message || 'Ответ оборвался.');
      }
      draft.sources = event.arni_sources ?? draft.sources;
      draft.text += event.choices?.[0]?.delta?.content || '';
    }
    if (draft.text) {
      setStatus('');
    }
    const reply = document.querySelector('#thread article:last-child .message-text');
    if (reply) {
      reply.innerHTML = renderMarkdown(draft.text);
      const thread = document.querySelector('#thread')!;
      thread.scrollTop = thread.scrollHeight;
    }
    if (done) {
      break;
    }
  }
}

function signOut() {
  clearAttachment();
  chatListRequest++;
  chats = [];
  chatsLoading = false;
  chatsError = false;
  token = '';
  localStorage.removeItem(TOKEN_KEY);
  renderGate('');
}

narrowScreen.addEventListener('change', () => setChatsOpen(false));
void boot().catch(() => renderGate('Не удалось подключиться к Arni. Обновите страницу и попробуйте снова.'));
