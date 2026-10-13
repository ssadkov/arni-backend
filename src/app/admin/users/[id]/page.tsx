import Link from 'next/link';
import { notFound } from 'next/navigation';
import prisma from '@/lib/prisma';
import UserModels from './UserModels';

export const dynamic = 'force-dynamic';

export default async function UserAccessPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const user = await prisma.user.findUnique({
		where: { id },
		include: { modelAccess: true },
	});
	if (!user) {
		notFound();
	}

	const [models, spent] = await Promise.all([
		prisma.bedrockModel.findMany(),
		prisma.usageLog.aggregate({
			where: { userId: id, NOT: { model: { endsWith: ':free' } } },
			_sum: { promptTokens: true, completionTokens: true },
		}),
	]);

	const spentTokens = (spent._sum.promptTokens || 0) + (spent._sum.completionTokens || 0);
	const grants = new Map(user.modelAccess.map((grant) => [grant.modelId, grant.enabled]));
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

	return (
		<div className="space-y-6">
			<div>
				<Link href="/admin/users" className="text-sm text-indigo-600 hover:text-indigo-800">← Пользователи</Link>
				<h2 className="text-2xl font-bold text-gray-800 mt-2">{user.email}</h2>
			</div>

			<div className="grid grid-cols-3 gap-4">
				<div className="bg-white rounded-xl border border-gray-100 p-4">
					<div className="text-xs uppercase text-gray-500">Выделено</div>
					<div className="text-2xl font-mono">{(user.tokenBalance + spentTokens).toLocaleString('ru-RU')}</div>
				</div>
				<div className="bg-white rounded-xl border border-gray-100 p-4">
					<div className="text-xs uppercase text-gray-500">Потрачено</div>
					<div className="text-2xl font-mono">{spentTokens.toLocaleString('ru-RU')}</div>
				</div>
				<div className="bg-white rounded-xl border border-gray-100 p-4">
					<div className="text-xs uppercase text-gray-500">Осталось</div>
					<div className="text-2xl font-mono">{user.tokenBalance.toLocaleString('ru-RU')}</div>
				</div>
			</div>
			<p className="text-sm text-gray-500">
				Считаются токены всех запросов, кроме бесплатных моделей OpenRouter с суффиксом :free. Начисление через «Начислить» увеличивает остаток, даже если доступ к Amazon выдан бесплатно.
			</p>

			<UserModels
				userId={user.id}
				selected={user.bedrockModelId}
				rows={models.map((model) => {
					const grant = grants.get(model.id);
					return {
						id: model.id,
						name: model.name,
						inputPerMillion: model.inputPerMillion,
						outputPerMillion: model.outputPerMillion,
						globalEnabled: model.enabled,
						mode: grant === undefined ? 'default' as const : grant ? 'on' as const : 'off' as const,
					};
				})}
			/>
		</div>
	);
}
