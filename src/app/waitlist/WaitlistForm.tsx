'use client';

import { FormEvent, useState } from 'react';

export default function WaitlistForm() {
  const [contact, setContact] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/waitlist/public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact, website, source: 'waitlist-page' }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setJoined(true);
      } else {
        setError(data?.error?.message ?? 'Не получилось записаться. Попробуйте позже.');
      }
    } catch {
      setError('Нет связи с сервером. Попробуйте позже.');
    } finally {
      setBusy(false);
    }
  }

  if (joined) {
    return <p className="text-lg text-emerald-700" role="status">Готово! Напишем, когда тариф Pro откроется.</p>;
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label htmlFor="contact" className="text-sm font-medium text-zinc-700">Почта или Telegram</label>
      <input
        id="contact"
        value={contact}
        onChange={event => setContact(event.target.value)}
        placeholder="name@example.ru или @username"
        required
        maxLength={200}
        className="rounded-md border border-zinc-300 px-4 py-3 text-base text-zinc-900 outline-none focus:border-indigo-500"
      />
      {/* Приманка для ботов: скрыта от людей и от клавиатурной навигации. */}
      <input
        value={website}
        onChange={event => setWebsite(event.target.value)}
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="hidden"
      />
      <button type="submit" disabled={busy} className="rounded-md bg-indigo-600 px-4 py-3 text-base font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50">
        {busy ? 'Записываем…' : 'Сообщить о запуске'}
      </button>
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
    </form>
  );
}
