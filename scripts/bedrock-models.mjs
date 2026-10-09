import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	BedrockClient,
	GetFoundationModelAvailabilityCommand,
	GetInferenceProfileCommand,
	ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock';
import { PrismaClient } from '@prisma/client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOUNDATION_PRICE_URL = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/us-east-1/index.json';
const NOVA_PRICE_URL = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json';

async function loadEnv() {
	const text = await readFile(path.join(root, '.env'), 'utf8');
	for (const line of text.split(/\n/)) {
		const match = line.match(/^([^#=]+)=(.*)$/);
		if (!match || process.env[match[1]] !== undefined) {
			continue;
		}
		let value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		process.env[match[1]] = value;
	}
}

function normalizeSlug(value) {
	return value
		.toLowerCase()
		.replace(/(\d+)\.0+\b/g, '$1')
		.replace(/(\d+)\.(\d+)/g, '$1-$2')
		.replace(/([a-z])(\d)/g, '$1-$2')
		.replace(/(\d)([a-z])/g, '$1-$2')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.replace(/-(instruct|latency-optimized)$/g, '');
}

function priceSlug(name) {
	return normalizeSlug(name);
}

function profileKey(id) {
	const scope = id.startsWith('global.') ? 'global' : id.startsWith('us.') ? 'us' : null;
	if (!scope) {
		return null;
	}
	let rest = id.slice(scope.length + 1).replace(/^[a-z0-9-]+\./, '');
	rest = rest.replace(/-\d{8}-v\d+(?::\d+)?$/, '').replace(/-v\d+(?::\d+)?$/, '');
	return { scope, slug: normalizeSlug(rest) };
}

function findPrice(prices, scope, slug) {
	const direct = prices.get(`${scope}:${slug}`);
	if (direct) {
		return direct;
	}
	let match = null;
	let matchLength = -1;
	for (const [key, row] of prices) {
		if (!key.startsWith(`${scope}:`)) {
			continue;
		}
		const candidate = key.slice(scope.length + 1);
		const fits = candidate === slug || candidate.endsWith(`-${slug}`) || slug.endsWith(`-${candidate}`);
		if (fits && candidate.length > matchLength) {
			match = row;
			matchLength = candidate.length;
		}
	}
	return match;
}

function plainTokenUsage(usage) {
	return !/long[_-]?ctx|batch|custom-model|latency|flex|priority|cache|provisioned/i.test(usage || '');
}

function onDemandUsd(terms, sku) {
	const offers = terms.OnDemand?.[sku];
	if (!offers) {
		return null;
	}
	for (const offer of Object.values(offers)) {
		for (const dimension of Object.values(offer.priceDimensions || {})) {
			if (/cache|batch|provisioned/i.test(dimension.description || '')) {
				continue;
			}
			const usd = Number(dimension.pricePerUnit?.USD);
			if (!Number.isFinite(usd)) {
				continue;
			}
			if (dimension.unit === '1M tokens') {
				return usd;
			}
			if (dimension.unit === '1K tokens') {
				return usd * 1000;
			}
		}
	}
	return null;
}

function rememberPrice(prices, scope, modelName, kind, usd) {
	if (usd == null || !modelName || /latency/i.test(modelName)) {
		return;
	}
	const key = `${scope}:${priceSlug(modelName)}`;
	const row = prices.get(key) || { name: modelName };
	if (row[kind] == null) {
		row[kind] = usd;
	}
	prices.set(key, row);
}

function collectFoundationPrices(offer, prices) {
	for (const product of Object.values(offer.products)) {
		const attributes = product.attributes || {};
		if (attributes.feature !== 'On-demand Inference') {
			continue;
		}
		if (attributes.inferenceType !== 'Input tokens' && attributes.inferenceType !== 'Output tokens') {
			continue;
		}
		if (!plainTokenUsage(attributes.usagetype)) {
			continue;
		}
		const scope = /global/i.test(attributes.usagetype || '') ? 'global' : 'us';
		const kind = attributes.inferenceType === 'Output tokens' ? 'output' : 'input';
		rememberPrice(prices, scope, attributes.model, kind, onDemandUsd(offer.terms, product.sku));
	}
}

function collectNovaPrices(offer, prices) {
	for (const product of Object.values(offer.products)) {
		const attributes = product.attributes || {};
		if (attributes.inferenceType !== 'Input tokens' && attributes.inferenceType !== 'Output tokens') {
			continue;
		}
		if (attributes.feature && attributes.feature !== 'On-demand Inference') {
			continue;
		}
		if (!plainTokenUsage(attributes.usagetype)) {
			continue;
		}
		const scope = /global/i.test(attributes.usagetype || '') ? 'global' : 'us';
		const kind = attributes.inferenceType === 'Output tokens' ? 'output' : 'input';
		rememberPrice(prices, scope, attributes.model, kind, onDemandUsd(offer.terms, product.sku));
	}
}

async function downloadJson(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Price list ${response.status} for ${url}`);
	}
	return response.json();
}

async function foundationModelId(client, profile) {
	let arn = profile.models?.[0]?.modelArn || '';
	if (!arn) {
		try {
			const full = await client.send(new GetInferenceProfileCommand({
				inferenceProfileIdentifier: profile.inferenceProfileId,
			}));
			arn = full.models?.[0]?.modelArn || '';
		} catch (error) {
			if (!isAccessDenied(error)) {
				console.error('profile', profile.inferenceProfileId, error?.name || error);
			}
		}
	}
	const slash = arn.lastIndexOf('/');
	if (slash >= 0) {
		return arn.slice(slash + 1);
	}
	return String(profile.inferenceProfileId || '').replace(/^(us|global)\./, '');
}

function isAccessDenied(error) {
	const name = error?.name || '';
	const message = error?.message || String(error);
	return name === 'AccessDeniedException' || /accessdenied|not authorized/i.test(message);
}

async function listProfiles(client) {
	const profiles = [];
	let nextToken;
	do {
		const page = await client.send(new ListInferenceProfilesCommand({ maxResults: 100, nextToken }));
		profiles.push(...(page.inferenceProfileSummaries || []));
		nextToken = page.nextToken;
	} while (nextToken);
	return profiles.filter((profile) => /^(us|global)\./.test(profile.inferenceProfileId || ''));
}

async function availability(client, modelId) {
	try {
		const result = await client.send(new GetFoundationModelAvailabilityCommand({ modelId }));
		return {
			agreementStatus: result.agreementAvailability?.status || '',
			authorizationStatus: result.authorizationStatus || '',
			regionAvailability: result.regionAvailability || '',
			note: '',
		};
	} catch (error) {
		if (isAccessDenied(error)) {
			return {
				agreementStatus: '',
				authorizationStatus: '',
				regionAvailability: '',
				note: 'AccessDenied',
			};
		}
		return {
			agreementStatus: '',
			authorizationStatus: '',
			regionAvailability: '',
			note: (error?.name || 'error') + (error?.message ? `: ${error.message}` : ''),
		};
	}
}

function availableNow(row) {
	if (row.note) {
		return row.note;
	}
	return [row.agreementStatus, row.authorizationStatus, row.regionAvailability].filter(Boolean).join(' / ') || 'неизвестно';
}

function money(value) {
	return value == null ? '' : value.toFixed(value >= 1 ? 2 : 4);
}

function markdown(rows) {
	const lines = [
		'# Модели Amazon Bedrock, us-east-1',
		'',
		'Цены — on-demand за 1 млн токенов, без batch, cache и provisioned. Доступ — ответ GetFoundationModelAvailability.',
		'',
		'| модель | ID профиля | доступна сейчас | $/1M input | $/1M output |',
		'| --- | --- | --- | ---: | ---: |',
	];
	for (const row of rows) {
		lines.push(`| ${row.name.replace(/\|/g, '/')} | \`${row.id}\` | ${availableNow(row).replace(/\|/g, '/')} | ${money(row.inputPerMillion)} | ${money(row.outputPerMillion)} |`);
	}
	lines.push('');
	return lines.join('\n');
}

async function main() {
	await loadEnv();
	if (process.argv.includes('--catalog-only')) {
		const rows = JSON.parse(await readFile(path.join(root, 'data', 'bedrock-models.json'), 'utf8'));
		await syncCatalog(rows);
		return;
	}
	if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
		throw new Error('AWS_BEARER_TOKEN_BEDROCK is empty');
	}

	const [foundation, nova] = await Promise.all([
		downloadJson(FOUNDATION_PRICE_URL),
		downloadJson(NOVA_PRICE_URL),
	]);
	const prices = new Map();
	collectFoundationPrices(foundation, prices);
	collectNovaPrices(nova, prices);

	const client = new BedrockClient({
		region: 'us-east-1',
		authSchemePreference: ['httpBearerAuth'],
	});
	const profiles = await listProfiles(client);
	const rows = [];
	for (const profile of profiles) {
		const id = profile.inferenceProfileId;
		const key = profileKey(id);
		const price = key ? findPrice(prices, key.scope, key.slug) : undefined;
		const access = await availability(client, await foundationModelId(client, profile));
		rows.push({
			id,
			name: profile.inferenceProfileName || price?.name || id,
			inputPerMillion: price?.input ?? null,
			outputPerMillion: price?.output ?? null,
			...access,
		});
		process.stdout.write('.');
	}
	process.stdout.write('\n');

	rows.sort((a, b) => {
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

	await mkdir(path.join(root, 'data'), { recursive: true });
	await writeFile(path.join(root, 'bedrock-models.md'), markdown(rows), 'utf8');
	await writeFile(path.join(root, 'data', 'bedrock-models.json'), JSON.stringify(rows, null, 2), 'utf8');
	const priced = rows.filter((row) => row.outputPerMillion != null).length;
	console.log(`profiles ${rows.length}, with output price ${priced}`);
	console.log('wrote bedrock-models.md and data/bedrock-models.json');
	await syncCatalog(rows);
}

async function syncCatalog(rows) {
	const prisma = new PrismaClient();
	try {
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
		console.log(`catalog ${rows.length}`);
	} finally {
		await prisma.$disconnect();
	}
}

main().catch((error) => {
	console.error('ERR', error.name || 'Error', error.message);
	process.exitCode = 1;
});
