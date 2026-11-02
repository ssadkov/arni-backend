import './style.css';

const API = (import.meta.env.VITE_API_ORIGIN || 'https://api.arnion.ru').replace(/\/$/, '');
const TOKEN_KEY = 'arni.web.token';
const MODEL_KEY = 'arni.web.model';

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
type Model = { id: string; name?: string; arni_default?: boolean };

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
let pendingImage: { id: string; name: string } | null = null;
let sending = false;

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
  await refreshModels();
  await refreshChats();
  renderApp();
  if (activeId) {
    await openChat(activeId);
  }
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
}

function renderApp() {
  app!.innerHTML = `<div class="shell">
    <header class="topbar">
      <button id="show-chats" class="menu" type="button">Чаты</button>
      <strong class="brand">Arni</strong>
      <div class="top-actions">
        <button id="show-memory" type="button">Память</button>
        <button id="sign-out" type="button">Выйти</button>
      </div>
    </header>
    <div class="limits" id="limits">${limitsHtml()}</div>
    <div class="workspace">
      <aside class="sidebar" id="sidebar">
        <button id="new-chat" class="primary" type="button">Новый чат</button>
        <div class="chats" id="chat-list"></div>
      </aside>
      <button id="backdrop" class="backdrop" type="button" aria-label="Закрыть список чатов"></button>
      <main class="main">
        <div class="thread" id="thread"></div>
        <form class="composer" id="composer">
          <select id="model" aria-label="Модель"></select>
          <textarea id="input" placeholder="Сообщение" rows="2"></textarea>
          <div class="actions">
            <label class="file"><input id="file" type="file" accept="image/png,image/jpeg" hidden />Картинка</label>
            <span id="file-name" class="muted"></span>
            <button id="send" class="primary" type="submit">Отправить</button>
            <button id="draw" type="button">Нарисовать</button>
          </div>
          <p id="status" class="error"></p>
        </form>
      </main>
    </div>
    <dialog id="memory-dialog">
      <form method="dialog" class="memory-form">
        <h2>Память аккаунта</h2>
        <p class="muted">Один текст для всех чатов. Бот видит его в каждом разговоре.</p>
        <textarea id="memory" maxlength="4000" placeholder="Короткие факты, которые бот должен помнить"></textarea>
        <p id="memory-status" class="muted"></p>
        <div class="actions">
          <button id="save-memory" class="primary" type="button" value="">Сохранить</button>
          <button id="close-memory" type="submit" value="cancel">Закрыть</button>
        </div>
      </form>
    </dialog>
  </div>`;
  document.querySelector('#sign-out')?.addEventListener('click', signOut);
  document.querySelector('#new-chat')?.addEventListener('click', () => void createChat());
  document.querySelector('#show-memory')?.addEventListener('click', () => void openMemory());
  document.querySelector('#save-memory')?.addEventListener('click', () => void saveMemory());
  document.querySelector('#show-chats')?.addEventListener('click', () => setChatsOpen(!document.querySelector('#sidebar')?.classList.contains('open')));
  document.querySelector('#backdrop')?.addEventListener('click', () => setChatsOpen(false));
  document.querySelector<HTMLFormElement>('#composer')?.addEventListener('submit', event => {
    event.preventDefault();
    void send(false);
  });
  document.querySelector<HTMLTextAreaElement>('#input')?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send(false);
    }
  });
  document.querySelector('#draw')?.addEventListener('click', () => void send(true));
  document.querySelector<HTMLInputElement>('#file')?.addEventListener('change', () => void attachFile());
  document.querySelector<HTMLSelectElement>('#model')?.addEventListener('change', event => {
    localStorage.setItem(MODEL_KEY, (event.target as HTMLSelectElement).value);
  });
  paintChats();
  paintModels();
  paintMessages();
}

function paintLimits() {
  const limits = document.querySelector('#limits');
  if (limits) {
    limits.innerHTML = limitsHtml();
  }
}

async function openMemory() {
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
    ? chats.map(chat => `<button type="button" data-id="${chat.id}" class="${chat.id === activeId ? 'active' : ''}">${escapeHtml(chat.title || 'Новый чат')}</button>`).join('')
    : '<p class="muted empty">Пока нет чатов</p>';
  list.querySelectorAll('button').forEach(button => button.addEventListener('click', () => void openChat(button.dataset.id || '')));
}

function paintModels() {
  const select = document.querySelector<HTMLSelectElement>('#model');
  if (!select) {
    return;
  }
  const current = selectedModel();
  select.innerHTML = models.map(model => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name || model.id)}</option>`).join('');
  select.value = current;
}

function paintMessages() {
  const thread = document.querySelector('#thread');
  if (!thread) {
    return;
  }
  if (!messages.length) {
    thread.innerHTML = '<p class="muted empty-thread">Напишите сообщение. Enter отправляет, Shift+Enter переносит строку.</p>';
    return;
  }
  thread.innerHTML = messages.map(message => {
    const images = message.images.map(image => `<img data-image="${image.id}" alt="" />`).join('');
    const sources = message.sources?.length ? `<ol class="sources">${message.sources.map(hit => `<li><a href="${escapeHtml(hit.url)}" target="_blank" rel="noreferrer">${escapeHtml(hit.title)}</a></li>`).join('')}</ol>` : '';
    return `<article class="bubble ${message.role === 'user' ? 'user' : ''}">${renderText(message.text)}${images}${sources}${message.status === 'incomplete' ? '<p class="muted">Ответ оборвался.</p>' : ''}</article>`;
  }).join('');
  thread.querySelectorAll<HTMLImageElement>('img[data-image]').forEach(image => {
    void loadImage(image);
  });
  thread.scrollTop = thread.scrollHeight;
}

async function loadImage(image: HTMLImageElement) {
  const response = await api(`/api/web/images/${image.dataset.image}`);
  if (!response.ok) {
    return;
  }
  image.src = URL.createObjectURL(await response.blob());
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
  const response = await api('/api/models');
  if (!response.ok) {
    return;
  }
  const body = await response.json() as { data: Model[] };
  models = body.data || [];
}

async function refreshChats() {
  const response = await api('/api/web/chats');
  if (!response.ok) {
    return;
  }
  const body = await response.json() as { chats: Chat[] };
  chats = body.chats;
  if (!activeId && chats[0]) {
    activeId = chats[0].id;
  }
}

async function openChat(id: string) {
  activeId = id;
  const response = await api(`/api/web/chats/${id}/messages`);
  if (!response.ok) {
    return;
  }
  const body = await response.json() as { messages: Message[] };
  messages = body.messages;
  paintChats();
  paintMessages();
  setChatsOpen(false);
}

async function createChat() {
  const response = await api('/api/web/chats', { method: 'POST' });
  if (!response.ok) {
    return;
  }
  const chat = await response.json() as Chat;
  chats.unshift({ ...chat, title: 'Новый чат' });
  activeId = chat.id;
  messages = [];
  paintChats();
  paintMessages();
  setChatsOpen(false);
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

async function attachFile() {
  const input = document.querySelector<HTMLInputElement>('#file');
  const file = input?.files?.[0];
  if (!file) {
    return;
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
  const response = await api('/api/web/images', { method: 'POST', body: JSON.stringify({ dataUrl }) });
  const status = document.querySelector('#status');
  if (!response.ok) {
    if (status) {
      status.textContent = await errorMessage(response);
    }
    return;
  }
  const body = await response.json() as { id: string };
  pendingImage = { id: body.id, name: file.name };
  const name = document.querySelector('#file-name');
  if (name) {
    name.textContent = file.name;
  }
}

async function send(draw: boolean) {
  if (sending) {
    return;
  }
  const input = document.querySelector<HTMLTextAreaElement>('#input');
  const text = input?.value.trim() || '';
  if (!activeId) {
    await createChat();
  }
  if (!activeId || (!text && !pendingImage)) {
    return;
  }
  sending = true;
  const status = document.querySelector('#status');
  if (status) {
    status.textContent = '';
  }
  const model = selectedModel();
  if (draw) {
    const response = await api(`/api/web/chats/${activeId}/images`, { method: 'POST', body: JSON.stringify({ prompt: text, aspect_ratio: '1:1' }) });
    sending = false;
    if (!response.ok) {
      if (status) {
        status.textContent = await errorMessage(response);
      }
      return;
    }
    if (input) {
      input.value = '';
    }
    await openChat(activeId);
    await refreshAccount();
    paintLimits();
    return;
  }
  const response = await api(`/api/web/chats/${activeId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text, model, imageId: pendingImage?.id }),
  });
  if (!response.ok || !response.body) {
    sending = false;
    if (status) {
      status.textContent = await errorMessage(response);
    }
    return;
  }
  if (input) {
    input.value = '';
  }
  pendingImage = null;
  const fileName = document.querySelector('#file-name');
  if (fileName) {
    fileName.textContent = '';
  }
  const fileInput = document.querySelector<HTMLInputElement>('#file');
  if (fileInput) {
    fileInput.value = '';
  }
  const draft: Message = { id: `local-${Date.now()}`, role: 'assistant', text: '', status: 'complete', sources: [], images: [] };
  messages.push({ id: `user-${Date.now()}`, role: 'user', text, status: 'complete', sources: [], images: [] });
  messages.push(draft);
  paintMessages();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const split = buffer.lastIndexOf('\n');
    if (split < 0) {
      continue;
    }
    const lines = buffer.slice(0, split).split('\n');
    buffer = buffer.slice(split + 1);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:') || trimmed === 'data: [DONE]') {
        continue;
      }
      try {
        const event = JSON.parse(trimmed.slice(5)) as { choices?: Array<{ delta?: { content?: string } }>; arni_sources?: Hit[] };
        if (event.arni_sources) {
          draft.sources = event.arni_sources;
        }
        const delta = event.choices?.[0]?.delta?.content;
        if (delta) {
          draft.text += delta;
        }
      } catch {
        // Partial SSE lines are kept in the buffer.
      }
    }
    paintMessages();
  }
  sending = false;
  await refreshChats();
  await refreshAccount();
  paintLimits();
}

function signOut() {
  token = '';
  localStorage.removeItem(TOKEN_KEY);
  renderGate('');
}

void boot();
