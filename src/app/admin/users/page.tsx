import Link from 'next/link';
import prisma from '@/lib/prisma';
import { freeStepSnapshot } from '@/lib/freeSteps';
import { envLlmProvider } from '@/lib/llm/provider';
import ProviderSelect from './ProviderSelect';
import UserActions from './UserActions';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  let users: any[] = [];
  let dbError = false;
  const spentByUser = new Map<string, number>();

  try {
    const [found, spend] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        include: { identities: true }
      }),
      prisma.usageLog.groupBy({
        by: ['userId'],
        where: { NOT: { model: { endsWith: ':free' } } },
        _sum: { promptTokens: true, completionTokens: true },
      }),
    ]);
    users = found;
    for (const row of spend) {
      spentByUser.set(row.userId, (row._sum.promptTokens || 0) + (row._sum.completionTokens || 0));
    }
  } catch (error) {
    dbError = true;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-800">Управление пользователями</h2>
        <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md font-medium transition disabled:opacity-50" disabled={dbError}>
          + Добавить вручную
        </button>
      </div>

      {dbError && (
        <div className="bg-red-50 border-l-4 border-red-500 p-4 text-red-700">
          <p>База данных не подключена. Отображается пустой список.</p>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Пользователь</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Провайдеры</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Токены</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Бесплатные шаги</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Модель</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Тариф</th>
              <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Действия</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {users.length === 0 && !dbError && (
              <tr>
                <td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                  Пользователей пока нет.
                </td>
              </tr>
            )}
            {users.map((user) => {
              const steps = freeStepSnapshot(user);
              const spent = spentByUser.get(user.id) || 0;
              return (
              <tr key={user.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center">
                    <div className="h-10 w-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold">
                      {user.email.charAt(0).toUpperCase()}
                    </div>
                    <div className="ml-4">
                      <div className="text-sm font-medium text-gray-900">{user.email}</div>
                      <div className="text-sm text-gray-500">ID: {user.id.slice(0, 8)}...</div>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex space-x-2">
                    {user.identities.map((id: any) => (
                      <span key={id.id} className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-red-100 text-red-800">
                        {id.provider}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-gray-900 font-mono">осталось {user.tokenBalance.toLocaleString('ru-RU')}</div>
                  <div className="text-xs text-gray-500 font-mono">потрачено {spent.toLocaleString('ru-RU')}</div>
                  <div className="text-xs text-gray-500 font-mono">выделено {(user.tokenBalance + spent).toLocaleString('ru-RU')}</div>
                  <Link href={`/admin/users/${user.id}`} className="text-xs text-indigo-600 hover:text-indigo-800">модели</Link>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-gray-900 font-mono">{steps.used} / {steps.limit}</div>
                  <div className="text-xs text-gray-500">сегодня · всего {steps.total.toLocaleString('ru-RU')}</div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <ProviderSelect
                    userId={user.id}
                    value={user.llmProvider === 'BEDROCK' ? 'bedrock' : user.llmProvider === 'OPENROUTER' ? 'openrouter' : 'default'}
                    envProvider={envLlmProvider()}
                  />
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${user.plan === 'PRO' ? 'bg-purple-100 text-purple-800' : 'bg-gray-100 text-gray-800'}`}>
                    {user.plan}
                  </span>
                  {user.proWaitlistAt && (
                    <div className="text-xs text-purple-700 mt-1" title={user.proWaitlistContact ?? undefined}>
                      Ждёт Pro с {new Date(user.proWaitlistAt).toLocaleDateString('ru-RU')}
                      {user.proWaitlistContact ? ` · ${user.proWaitlistContact}` : ''}
                    </div>
                  )}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <UserActions userId={user.id} isBanned={user.isBanned} />
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
