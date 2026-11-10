const STORAGE_KEY = 'arni.desktop.request';
const REQUEST_ID = /^[A-Za-z0-9_-]{22,128}$/;

type Root = HTMLElement;

export function captureDesktopRequest(params: URLSearchParams) {
  const value = params.get('desktop_request');
  if (value && REQUEST_ID.test(value)) {
    sessionStorage.setItem(STORAGE_KEY, value);
  }
}

export function pendingDesktopRequest() {
  const value = sessionStorage.getItem(STORAGE_KEY) || '';
  if (!REQUEST_ID.test(value)) {
    sessionStorage.removeItem(STORAGE_KEY);
    return '';
  }
  return value;
}

export function clearDesktopRequest() {
  sessionStorage.removeItem(STORAGE_KEY);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
}

type ApprovalOptions = {
  api: string;
  token: string;
  requestId: string;
  onFinished: () => void;
};

export function startDesktopApproval(root: Root, options: ApprovalOptions) {
  void render(root, options);
}

async function render(root: Root, options: ApprovalOptions) {
  root.innerHTML = `<main class="gate"><section class="gate-card desktop-card">
    <h1>Arni Lite</h1>
    <p>Проверяем запрос входа…</p>
  </section></main>`;
  const response = await fetch(`${options.api}/api/desktop/auth/request?request_id=${encodeURIComponent(options.requestId)}`);
  if (!response.ok) {
    showMessage(root, 'Запрос входа не найден или истёк. Вернитесь в Arni Lite и начните снова.', options);
    return;
  }
  const body = await response.json() as { application?: string; user_code?: string; status?: string };
  if (body.status === 'approved') {
    showMessage(root, 'Вход уже подтверждён. Можно вернуться в Arni Lite.', options);
    return;
  }
  if (body.status === 'denied') {
    showMessage(root, 'Вход отклонён. Можно закрыть эту страницу.', options);
    return;
  }
  const code = body.user_code || '';
  root.innerHTML = `<main class="gate"><section class="gate-card desktop-card">
    <h1>${escapeHtml(body.application || 'Arni Lite')}</h1>
    <p>Код ниже относится к запросу, открытому по этой ссылке. Введите код из окна Arni Lite. Подтверждайте только если коды совпадают. Если ссылку прислал кто-то другой, нажмите «Отклонить».</p>
    <p class="code-display">${escapeHtml(code)}</p>
    <label>Код из окна Arni Lite
      <input id="desktop-code" autocomplete="off" spellcheck="false" maxlength="20" />
    </label>
    <p class="error" id="desktop-error" hidden></p>
    <div class="actions">
      <button class="primary" id="desktop-approve" type="button">Подтвердить</button>
      <button id="desktop-deny" type="button">Отклонить</button>
    </div>
  </section></main>`;
  const input = root.querySelector<HTMLInputElement>('#desktop-code');
  const error = root.querySelector<HTMLParagraphElement>('#desktop-error');
  root.querySelector('#desktop-approve')?.addEventListener('click', () => {
    void submit(root, options, input?.value || '', error);
  });
  root.querySelector('#desktop-deny')?.addEventListener('click', () => {
    void deny(root, options, error);
  });
  input?.focus();
}

async function submit(root: Root, options: ApprovalOptions, userCode: string, error: HTMLParagraphElement | null) {
  const response = await fetch(`${options.api}/api/desktop/auth/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: options.requestId, user_code: userCode }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    if (error) {
      error.hidden = false;
      error.textContent = body?.error?.message || 'Не удалось подтвердить вход.';
    }
    return;
  }
  clearDesktopRequest();
  showMessage(root, 'Вход подтверждён. Вернитесь в окно Arni Lite.', options);
}

async function deny(root: Root, options: ApprovalOptions, error: HTMLParagraphElement | null) {
  const response = await fetch(`${options.api}/api/desktop/auth/deny`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: options.requestId }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    if (error) {
      error.hidden = false;
      error.textContent = body?.error?.message || 'Не удалось отклонить вход.';
    }
    return;
  }
  clearDesktopRequest();
  showMessage(root, 'Вход отклонён. Arni Lite не получит доступ к аккаунту.', options);
}

function showMessage(root: Root, message: string, options: ApprovalOptions) {
  root.innerHTML = `<main class="gate"><section class="gate-card desktop-card">
    <h1>Arni Lite</h1>
    <p>${escapeHtml(message)}</p>
    <div class="actions"><button class="primary" id="desktop-continue" type="button">Перейти в чат</button></div>
  </section></main>`;
  root.querySelector('#desktop-continue')?.addEventListener('click', () => {
    clearDesktopRequest();
    options.onFinished();
  });
}
