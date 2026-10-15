import prisma from '@/lib/prisma';
import { utcDayKey } from '@/lib/freeSteps';

export const dynamic = 'force-dynamic';

export default async function AdminDashboard() {
  let userCount = 0;
  let totalTokens = 0;
  let waitlistCount = 0;
  let freeStepsToday = 0;
  let freeStepsTotal = 0;
  let dbError = false;
  let recordedCostMicros = 0;
  let unpricedRequests = 0;

  try {
    userCount = await prisma.user.count();
    waitlistCount = await prisma.user.count({ where: { proWaitlistAt: { not: null } } })
      + await prisma.waitlistEntry.count();
    const logs = await prisma.usageLog.aggregate({
      _sum: {
        promptTokens: true,
        completionTokens: true,
        costMicros: true,
      },
      _count: { id: true, costMicros: true },
    });
    totalTokens = (logs._sum.promptTokens || 0) + (logs._sum.completionTokens || 0);
    recordedCostMicros = logs._sum.costMicros || 0;
    unpricedRequests = logs._count.id - logs._count.costMicros;
    const today = await prisma.user.aggregate({
      where: { freeStepsDay: utcDayKey() },
      _sum: { freeStepsToday: true },
    });
    const lifetime = await prisma.user.aggregate({
      _sum: { freeStepsTotal: true },
    });
    freeStepsToday = today._sum.freeStepsToday || 0;
    freeStepsTotal = lifetime._sum.freeStepsTotal || 0;
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
          <p className="text-xs text-gray-400 mt-1">Ждут тариф Pro: {waitlistCount}</p>
        </div>
        
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Сгенерировано токенов</h3>
          <p className="mt-2 text-3xl font-bold text-indigo-600">
            {totalTokens.toLocaleString('ru-RU')}
          </p>
        </div>

        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Бесплатные шаги сегодня</h3>
          <p className="mt-2 text-3xl font-bold text-gray-900">
            {freeStepsToday.toLocaleString('ru-RU')}
          </p>
          <p className="text-xs text-gray-400 mt-1">Сброс в 00:00 UTC · лимит 150 на пользователя</p>
        </div>

        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Бесплатные шаги всего</h3>
          <p className="mt-2 text-3xl font-bold text-gray-900">
            {freeStepsTotal.toLocaleString('ru-RU')}
          </p>
          <p className="text-xs text-gray-400 mt-1">По всем пользователям, без сброса</p>
        </div>

        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Учтённые расходы API</h3>
          <p className="mt-2 text-3xl font-bold text-emerald-600">
            ${(recordedCostMicros / 1_000_000).toFixed(4)}
          </p>
          <p className="text-xs text-gray-400 mt-1">По usage и сохранённым тарифам; без цены: {unpricedRequests} записей. Оборванные запросы могут включать оценку резерва.</p>
          <a href="/api/admin/usage/export" className="text-sm text-indigo-600 hover:text-indigo-800">Скачать расходы за 30 дней (CSV)</a>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-800">Model traffic</h2>
          <a href="/admin/traffic" className="text-sm text-indigo-600 hover:text-indigo-800">Open traffic</a>
        </div>
        <p className="px-6 py-4 text-sm text-gray-500">
          Failed requests are stored with the model and status. Availability and which models people pick are on the Traffic page.
        </p>
      </div>
    </div>
  );
}
