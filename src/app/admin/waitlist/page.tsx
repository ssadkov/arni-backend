import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

interface WaitlistRow {
  key: string;
  contact: string;
  source: string;
  joinedAt: Date;
}

export default async function WaitlistPage() {
  let rows: WaitlistRow[] = [];
  let dbError = false;

  try {
    const [users, entries] = await Promise.all([
      prisma.user.findMany({ where: { proWaitlistAt: { not: null } } }),
      prisma.waitlistEntry.findMany(),
    ]);
    rows = [
      ...users.map(user => ({
        key: `user-${user.id}`,
        // У VK-аккаунтов без почты вместо неё заглушка, настоящий контакт лежит отдельно.
        contact: user.proWaitlistContact ?? user.email,
        source: 'приложение',
        joinedAt: user.proWaitlistAt ?? user.createdAt,
      })),
      ...entries.map(entry => ({ key: `entry-${entry.id}`, contact: entry.contact, source: entry.source, joinedAt: entry.createdAt })),
    ].sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime());
  } catch {
    dbError = true;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-800">Лист ожидания Pro: {rows.length}</h2>

      {dbError && (
        <div className="bg-red-50 border-l-4 border-red-500 p-4 text-red-700">
          <p>База данных не подключена. Отображается пустой список.</p>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Контакт</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Откуда</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Когда (МСК)</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {rows.length === 0 && !dbError && (
              <tr>
                <td colSpan={3} className="px-6 py-8 text-center text-gray-500">Пока никто не записался.</td>
              </tr>
            )}
            {rows.map(row => (
              <tr key={row.key} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{row.contact}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.source}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.joinedAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
