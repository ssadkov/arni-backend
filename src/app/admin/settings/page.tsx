export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-800">Настройки системы</h2>
        <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md font-medium transition">
          Сохранить изменения
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden p-6 space-y-6">
        <div>
          <h3 className="text-lg font-medium text-gray-900">ИИ Модели по умолчанию</h3>
          <p className="text-sm text-gray-500 mb-4">Выберите модели, которые будут использоваться для бесплатных и платных пользователей.</p>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Модель для тарифа FREE</label>
              <select className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md border">
                <option>openrouter/auto</option>
                <option>anthropic/claude-3-haiku</option>
                <option>meta-llama/llama-3-8b-instruct</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Модель для тарифа PRO</label>
              <select className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md border">
                <option>anthropic/claude-3.5-sonnet</option>
                <option>openai/gpt-4o</option>
              </select>
            </div>
          </div>
        </div>

        <div className="pt-6 border-t border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Безопасность и Лимиты</h3>
          <div className="mt-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Токенов при регистрации (баланс по умолчанию)</label>
              <input type="number" defaultValue={100000} className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm" />
            </div>
          </div>
        </div>
        
        <div className="pt-6 border-t border-gray-200">
          <div className="bg-blue-50 border-l-4 border-blue-400 p-4">
            <div className="flex">
              <div className="ml-3">
                <p className="text-sm text-blue-700">
                  Секретные ключи (OpenRouter API, JWT Secret) настраиваются через переменные окружения Vercel (вкладка Environment Variables).
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
