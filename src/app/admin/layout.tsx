import Link from 'next/link';
import { ReactNode } from 'react';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen bg-gray-50 font-sans text-gray-900">
      {/* Боковая панель */}
      <aside className="w-64 bg-slate-900 text-slate-300 flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-slate-800">
          <span className="text-xl font-bold text-white tracking-wide">Arni Admin</span>
        </div>
        <nav className="flex-1 px-4 py-6 space-y-2">
          <Link href="/admin" className="block px-4 py-2 rounded-md hover:bg-slate-800 hover:text-white transition">
            📊 Дашборд
          </Link>
          <Link href="/admin/users" className="block px-4 py-2 rounded-md hover:bg-slate-800 hover:text-white transition">
            👥 Пользователи
          </Link>
          <Link href="/admin/settings" className="block px-4 py-2 rounded-md hover:bg-slate-800 hover:text-white transition">
            ⚙️ Настройки
          </Link>
        </nav>
        <div className="p-4 border-t border-slate-800 text-sm text-slate-500">
          Arni Code Proxy v1.0
        </div>
      </aside>

      {/* Основной контент */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 bg-white border-b border-gray-200 flex items-center px-8">
          <h1 className="text-xl font-semibold">Панель управления</h1>
        </header>
        <div className="flex-1 overflow-y-auto p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
