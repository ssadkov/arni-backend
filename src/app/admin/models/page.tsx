import prisma from '@/lib/prisma';
import { ImportCatalog, ModelToggle } from './ModelControls';

export const dynamic = 'force-dynamic';

function money(value: number | null) {
	if (value == null) {
		return '—';
	}
	return `$${value >= 1 ? value.toFixed(2) : value.toFixed(4)}`;
}

function accessLabel(model: { agreementStatus: string | null; authorizationStatus: string | null; regionAvailability: string | null }) {
	return [model.agreementStatus, model.authorizationStatus, model.regionAvailability].filter(Boolean).join(' / ') || '—';
}

export default async function ModelsPage() {
	let models: Awaited<ReturnType<typeof prisma.bedrockModel.findMany>> = [];
	let dbError = false;
	try {
		models = await prisma.bedrockModel.findMany();
		models.sort((a, b) => {
			if (a.outputPerMillion == null && b.outputPerMillion == null) {
				return a.name.localeCompare(b.name);
			}
			if (a.outputPerMillion == null) {
				return 1;
			}
			if (b.outputPerMillion == null) {
				return -1;
			}
			return a.outputPerMillion - b.outputPerMillion || a.name.localeCompare(b.name);
		});
	} catch {
		dbError = true;
	}

	return (
		<div className="space-y-6">
			<div className="flex justify-between items-center gap-4">
				<div>
					<h2 className="text-2xl font-bold text-gray-800">Модели Bedrock</h2>
					<p className="text-sm text-gray-500 mt-1">
						Цены on-demand за 1 млн токенов, регион us-east-1. Выключенная модель недоступна всем, пока её не включат конкретному человеку.
					</p>
				</div>
				<ImportCatalog />
			</div>

			{dbError && (
				<div className="bg-red-50 border-l-4 border-red-500 p-4 text-red-700">
					База данных не подключена.
				</div>
			)}

			{!dbError && models.length === 0 && (
				<div className="bg-amber-50 border-l-4 border-amber-500 p-4 text-amber-800">
					Каталог пуст. Сначала выполните <code>node scripts/bedrock-models.mjs</code>, затем нажмите «Загрузить каталог».
				</div>
			)}

			<div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
				<table className="min-w-full divide-y divide-gray-200">
					<thead className="bg-gray-50">
						<tr>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Модель</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Доступ AWS</th>
							<th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">$/1M input</th>
							<th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">$/1M output</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Для всех</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-gray-200">
						{models.map((model) => (
							<tr key={model.id} className="hover:bg-gray-50">
								<td className="px-4 py-3">
									<div className="text-sm font-medium text-gray-900">{model.name}</div>
									<div className="text-xs text-gray-500 font-mono">{model.id}</div>
								</td>
								<td className="px-4 py-3 text-xs text-gray-600">{accessLabel(model)}</td>
								<td className="px-4 py-3 text-right text-sm font-mono">{money(model.inputPerMillion)}</td>
								<td className="px-4 py-3 text-right text-sm font-mono">{money(model.outputPerMillion)}</td>
								<td className="px-4 py-3">
									<ModelToggle id={model.id} enabled={model.enabled} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
