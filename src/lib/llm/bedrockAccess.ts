import { readFile } from 'node:fs/promises';
import path from 'node:path';
import prisma from '@/lib/prisma';

export type CatalogRow = {
	id: string;
	name: string;
	inputPerMillion: number | null;
	outputPerMillion: number | null;
	agreementStatus?: string;
	authorizationStatus?: string;
	regionAvailability?: string;
	note?: string;
};

export async function importBedrockCatalog() {
	const file = path.join(process.cwd(), 'data', 'bedrock-models.json');
	const rows = JSON.parse(await readFile(file, 'utf8')) as CatalogRow[];
	for (const row of rows) {
		await prisma.bedrockModel.upsert({
			where: { id: row.id },
			create: {
				id: row.id,
				name: row.name,
				inputPerMillion: row.inputPerMillion,
				outputPerMillion: row.outputPerMillion,
				enabled: row.id === 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
				agreementStatus: row.agreementStatus || null,
				authorizationStatus: row.authorizationStatus || row.note || null,
				regionAvailability: row.regionAvailability || null,
			},
			update: {
				name: row.name,
				inputPerMillion: row.inputPerMillion,
				outputPerMillion: row.outputPerMillion,
				agreementStatus: row.agreementStatus || null,
				authorizationStatus: row.authorizationStatus || row.note || null,
				regionAvailability: row.regionAvailability || null,
			},
		});
	}
	return rows.length;
}

export async function modelsAllowedForUser(userId: string) {
	const [models, grants] = await Promise.all([
		prisma.bedrockModel.findMany({ orderBy: [{ outputPerMillion: 'asc' }, { name: 'asc' }] }),
		prisma.userModelAccess.findMany({ where: { userId } }),
	]);
	const grantByModel = new Map(grants.map((grant) => [grant.modelId, grant.enabled]));
	return models
		.filter((model) => {
			const grant = grantByModel.get(model.id);
			return grant === undefined ? model.enabled : grant;
		})
		.sort((a, b) => (a.outputPerMillion ?? Number.POSITIVE_INFINITY) - (b.outputPerMillion ?? Number.POSITIVE_INFINITY));
}

export async function modelIdForUser(userId: string, preferred: string | null) {
	const allowed = await modelsAllowedForUser(userId);
	if (allowed.length === 0) {
		return null;
	}
	return allowed.find((model) => model.id === preferred)?.id || allowed[0].id;
}
