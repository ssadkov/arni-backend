import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function AdminDashboard() {
  let userCount = 0;
  let totalTokens = 0;
  let dbError = false;

  try {
    userCount = await prisma.user.count();
    const logs = await prisma.usageLog.aggregate({
      _sum: {
        promptTokens: true,
        completionTokens: true,
      }
    });
    totalTokens = (logs._sum.promptTokens || 0) + (logs._sum.completionTokens || 0);
  } catch (error) {
    dbError = true;
  }

  return (
    <div className="space-y-6">
      {dbError && (
        <div className="bg-red-50 border-l-4 border-red-500 p-4 text-red-700">
          <p className="font-bold">Ошибка подключения к Базе Данных!</p>
          <p>Похоже, вы еще не настроили Vercel Postgres или не применили миграции.</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Всего пользователей</h3>
          <p className="mt-2 text-3xl font-bold text-gray-900">{userCount}</p>
        </div>
        
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Сгенерировано токенов</h3>
          <p className="mt-2 text-3xl font-bold text-indigo-600">
            {totalTokens.toLocaleString('ru-RU')}
          </p>
        </div>

        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Затраты (Примерно)</h3>
          <p className="mt-2 text-3xl font-bold text-emerald-600">
            ${(totalTokens / 1_000_000 * 0.5).toFixed(4)}
          </p>
          <p className="text-xs text-gray-400 mt-1">Оценка $0.5 за 1M токенов</p>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-800">Последняя активность</h2>
        </div>
        <div className="p-6 text-gray-500 text-center">
          Здесь будет отображаться график или лог последних запросов
        </div>
      </div>
    </div>
  );
}
