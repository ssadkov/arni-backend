import type { Metadata } from 'next';
import WaitlistForm from './WaitlistForm';

export const metadata: Metadata = {
  title: 'Arni Code Pro — лист ожидания',
  description: 'Оставьте почту или Telegram, и мы напишем, когда откроется тариф Pro.',
};

export default function WaitlistPage() {
  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-4 py-16 font-sans">
      <main className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-zinc-900">Arni Code Pro</h1>
        <p className="mt-3 mb-6 text-base leading-7 text-zinc-600">
          Сейчас Arni Code работает на бесплатных моделях. В тарифе Pro появятся Claude, GPT и другие.
          Оставьте контакт, и мы напишем, когда Pro откроется.
        </p>
        <WaitlistForm />
      </main>
    </div>
  );
}
