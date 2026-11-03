import './style.css';

const API = (import.meta.env.VITE_API_ORIGIN || 'https://api.arnion.ru').replace(/\/$/, '');
const TOKEN_KEY = 'arni.web.token';
const MODEL_KEY = 'arni.web.model';
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
    balanceMicros: number;
    validUntil: string;
    fiveHour: BudgetWindow;
    weekly: BudgetWindow;
  } | null;
};
type Model = {
  id: string;
  name?: string;
  arni_default?: boolean;
  arni_free?: boolean;
  arni_provider?: string;
  architecture?: { input_modalities?: string[] };
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
let sending = false;
let opening = false;
let modelsLoading = false;
let modelsError = false;

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
};

function icon(name: keyof typeof icons) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

function usd(micros: number) {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
}

function renderText(value: string) {
  const escaped = escapeHtml(value);
  return escaped.split('```').map((part, index) => index % 2 === 1
    ? `<pre><code>${part.replace(/^\w+\n/, '')}</code></pre>`
    : part.replace(/\n/g, '<br>')).join('');
}

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
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

function selectedModel() {
  const stored = localStorage.getItem(MODEL_KEY);
  return models.find(model => model.id === stored)?.id || models.find(model => model.arni_default)?.id || models[0]?.id || '';
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
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
    history.replaceState({}, '', '/');
  } else if (error) {
    history.replaceState({}, '', '/');
    renderGate('Не удалось войти. Попробуйте ещё раз.');
    return;
  }
  if (!token) {
    renderGate('');
    return;
  }
  await refreshAccount();
  if (!token) {
    return;
  }
  await refreshChats();
  renderApp();
  void refreshModels();
}

function renderGate(message: string) {
  app!.innerHTML = `<main class="gate"><section class="gate-card">
    <h1>Arni</h1>
    <p>Чат с памятью, картинками и поиском. Вход тот же, что в редакторе.</p>
    ${message ? `<p class="error">${escapeHtml(message)}</p>` : ''}
    <div class="actions">
      <a class="primary" href="${API}/api/web/auth/yandex/start">Войти через Яндекс</a>
      <a href="${API}/api/web/auth/vk/start">Войти через VK</a>
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
  const windowLine = (title: string, window: BudgetWindow) => `<div><dt>${title}</dt><dd>${usd(window.usedMicros)} / ${usd(window.limitMicros)} · ${window.requests}/${window.requestLimit}</dd></div>`;
  const state = !budget.enabled || budget.expired ? '<p class="error">Доступ приостановлен или срок истёк.</p>' : '';
  return `<div><strong>${escapeHtml(account.email)}</strong>${state}<dl>
    <div><dt>Бюджет</dt><dd>${usd(Math.max(0, budget.balanceMicros))} до ${escapeHtml(budget.validUntil.slice(0, 10))}</dd></div>
    ${windowLine('5 часов', budget.fiveHour)}
    ${windowLine('7 дней', budget.weekly)}
  </dl></div>`;
}

function setChatsOpen(open: boolean) {
  document.querySelector('#sidebar')?.classList.toggle('open', open);
  document.querySelector('#backdrop')?.classList.toggle('open', open);
  document.querySelector('#show-chats')?.setAttribute('aria-expanded', String(open));
}

function renderApp() {
  app!.innerHTML = `<div class="shell">
    <div class="workspace">
      <aside class="sidebar" id="sidebar">
        <strong class="brand">Arni</strong>
        <button id="new-chat" class="new-chat" type="button">${icon('compose')} Новый чат</button>
        <nav class="history" aria-label="История чатов">
          <h2>Ваши чаты</h2>
          <div class="chats" id="chat-list"></div>
        </nav>
        <button id="show-account" class="account-button" type="button">
          <span class="avatar" aria-hidden="true">${escapeHtml(account?.email?.charAt(0).toUpperCase() || 'A')}</span>
          <span class="account-name">${escapeHtml(account?.email || 'Аккаунт')}</span>${icon('chevron')}
        </button>
      </aside>
      <button id="backdrop" class="backdrop" type="button" tabindex="-1" aria-label="Закрыть список чатов"></button>
      <main class="main">
        <header class="topbar">
          <button id="show-chats" class="icon-button menu" type="button" aria-label="Чаты" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button>
          <button id="show-models" class="model-trigger" type="button" aria-haspopup="dialog">
            <span id="current-model">Модель</span>${icon('chevron')}
          </button>
        </header>
        <div class="conversation" id="conversation">
          <div class="thread" id="thread" aria-label="Сообщения"></div>
          <form class="composer" id="composer">
            <div id="attachment" class="attachment" hidden>
              <img id="file-preview" alt="" />
              <span id="file-name"></span>
              <button id="remove-file" class="icon-button" type="button" aria-label="Убрать изображение">${icon('close')}</button>
            </div>
            <label class="sr-only" for="input">Сообщение</label>
            <textarea id="input" placeholder="Спросите что угодно" rows="1" maxlength="16000"></textarea>
            <div class="composer-tools">
              <div class="add-tools">
                <button id="show-tools" class="icon-button add-button" type="button" aria-label="Добавить" aria-controls="tool-panel" aria-expanded="false">${icon('plus')}</button>
                <div id="tool-panel" class="tool-panel" hidden>
                  <button id="attach-image" type="button">${icon('image')} <span>Прикрепить изображение<small>PNG или JPEG · до 2,5 МБ</small></span></button>
                  <button id="draw" type="button">${icon('spark')} Создать изображение</button>
                </div>
                <input id="file" type="file" accept="image/png,image/jpeg" hidden />
              </div>
              <button id="image-mode" class="mode-button" type="button" aria-label="Выйти из режима создания изображения" hidden>${icon('spark')} Изображение ${icon('close')}</button>
              <button id="send" class="primary icon-button send-button" type="submit" aria-label="Отправить">${icon('send')}</button>
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
        <div class="actions">
          <button id="show-memory" type="button">Память</button>
          <button id="sign-out" type="button">Выйти</button>
        </div>
      </div>
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
  document.querySelector('#show-memory')?.addEventListener('click', () => void openMemory());
  document.querySelector('#save-memory')?.addEventListener('click', () => void saveMemory());
  document.querySelector('#show-chats')?.addEventListener('click', () => setChatsOpen(!document.querySelector('#sidebar')?.classList.contains('open')));
  document.querySelector('#backdrop')?.addEventListener('click', () => setChatsOpen(false));
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
    document.querySelector<HTMLTextAreaElement>('#input')?.focus();
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
    if ((event as KeyboardEvent).key === 'Escape') {
      if (!document.querySelector<HTMLElement>('#tool-panel')?.hidden) {
        setToolsOpen(false, true);
      } else if (document.querySelector('#sidebar')?.classList.contains('open')) {
        setChatsOpen(false);
        document.querySelector<HTMLButtonElement>('#show-chats')?.focus();
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
  if (!list) {
    return;
  }
  list.innerHTML = chats.length
    ? chats.map(chat => `<button type="button" data-id="${escapeHtml(chat.id)}" ${chat.id === activeId ? 'aria-current="true"' : ''} ${sending || opening ? 'disabled' : ''}>${escapeHtml(chat.title || 'Новый чат')}</button>`).join('')
    : '<p class="muted empty">Пока нет чатов</p>';
  list.querySelectorAll('button').forEach(button => button.addEventListener('click', () => void openChat(button.dataset.id || '')));
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

function paintComposer() {
  const input = document.querySelector<HTMLTextAreaElement>('#input')!;
  input.placeholder = imageMode ? 'Опишите изображение' : 'Спросите что угодно';
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
  input.readOnly = sending || opening;
  document.querySelector<HTMLElement>('#image-mode')!.hidden = !imageMode;
  document.querySelector<HTMLButtonElement>('#image-mode')!.disabled = sending || opening;
  document.querySelector<HTMLElement>('#attachment')!.hidden = !pendingImage || imageMode;
  document.querySelector<HTMLButtonElement>('#remove-file')!.disabled = sending || opening;
  document.querySelector<HTMLButtonElement>('#show-tools')!.disabled = sending || opening;
  document.querySelector<HTMLButtonElement>('#show-models')!.disabled = sending;
  document.querySelector<HTMLButtonElement>('#new-chat')!.disabled = sending || opening;
  document.querySelector<HTMLButtonElement>('#sign-out')!.disabled = sending || opening;
  document.querySelector<HTMLButtonElement>('#send')!.disabled = sending || opening || (imageMode
    ? !input.value.trim()
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
    thread.innerHTML = sending ? '' : '<div class="empty-thread"><h1>Чем помочь?</h1><p class="muted">Задайте вопрос или добавьте изображение через «+».</p></div>';
    return;
  }
  thread.innerHTML = messages.map(message => {
    const images = message.images.map(image => `<img data-image="${escapeHtml(image.id)}" alt="${message.role === 'user' ? 'Прикреплённое изображение' : 'Изображение от Арни'}" />`).join('');
    const links = message.sources?.filter(hit => /^https?:\/\//i.test(hit.url));
    const sources = links?.length ? `<ol class="sources">${links.map(hit => `<li><a href="${escapeHtml(hit.url)}" target="_blank" rel="noreferrer">${escapeHtml(hit.title)}</a></li>`).join('')}</ol>` : '';
    return `<article class="bubble ${message.role === 'user' ? 'user' : ''}" aria-label="${message.role === 'user' ? 'Вы' : 'Арни'}">${renderText(message.text)}${images}${sources}${message.status === 'incomplete' ? '<p class="muted">Ответ оборвался.</p>' : ''}</article>`;
  }).join('');
  thread.querySelectorAll<HTMLImageElement>('img[data-image]').forEach(image => {
    void loadImage(image);
  });
  thread.scrollTop = thread.scrollHeight;
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
  const response = await api('/api/web/chats');
  if (!response.ok) {
    return;
  }
  const body = await response.json() as { chats: Chat[] };
  chats = body.chats;
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

  sending = true;
  setToolsOpen(false);
  setStatus(draw ? 'Создаём изображение…' : 'Готовим ответ…');
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
    const payload = draw ? { prompt: text, aspect_ratio: '1:1' } : { text, model, imageId };
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
    void Promise.allSettled([refreshChats(), refreshAccount()]).then(() => {
      paintChats();
      paintLimits();
    });
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
    const reply = document.querySelector('#thread article:last-child');
    if (reply) {
      reply.innerHTML = renderText(draft.text);
      const thread = reply.parentElement!;
      thread.scrollTop = thread.scrollHeight;
    }
    if (done) {
      break;
    }
  }
}

function signOut() {
  clearAttachment();
  token = '';
  localStorage.removeItem(TOKEN_KEY);
  renderGate('');
}

void boot().catch(() => renderGate('Не удалось подключиться к Arni. Обновите страницу и попробуйте снова.'));
