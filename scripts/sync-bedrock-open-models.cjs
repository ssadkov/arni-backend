// Read the live AWS catalogue without invoking inference. Database grants are a separate step.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const models = [
	['qwen.qwen3-coder-next', 'Qwen3 Coder Next', 'us-east-1'],
	['qwen.qwen3-next-80b-a3b', 'Qwen3 Next 80B A3B', 'us-east-1'],
	['qwen.qwen3-32b-v1:0', 'Qwen3 32B', 'us-east-1'],
	['qwen.qwen3-vl-235b-a22b', 'Qwen3 VL 235B A22B', 'us-east-1'],
	['qwen.qwen3-coder-30b-a3b-v1:0', 'Qwen3 Coder 30B A3B', 'us-east-1'],
	['qwen.qwen3-coder-480b-a35b-v1:0', 'Qwen3 Coder 480B A35B', 'us-west-2'],
	['qwen.qwen3-235b-a22b-2507-v1:0', 'Qwen3 235B A22B 2507', 'us-west-2'],
	// Names must match the `model` attribute of the AWS Pricing API.
	['deepseek.v3.2', 'DeepSeek v3.2', 'us-east-1'],
	['minimax.minimax-m2.5', 'MiniMax M2.5', 'us-east-1'],
	['moonshotai.kimi-k2.5', 'Kimi K2.5', 'us-east-1'],
];

function aws(region, ...args) {
	const result = spawnSync('aws', [...args, '--profile', process.env.AWS_PROFILE || 'arni-bedrock-audit', '--region', region, '--output', 'json'], { encoding: 'utf8', windowsHide: true });
	if (result.status !== 0) { throw new Error(`AWS catalogue read failed (${args[0]} ${args[1]})`); }
	return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}

function perMillion(product) {
	return Object.values(product.terms.OnDemand).flatMap(term => Object.values(term.priceDimensions)).map(rate => {
		const unit = rate.unit.toLowerCase();
		const multiplier = /^1k tokens$/.test(unit) ? 1000 : /^1m tokens$/.test(unit) ? 1 : /^tokens$/.test(unit) ? 1_000_000 : NaN;
		const price = Number((Number(rate.pricePerUnit.USD) * multiplier).toFixed(10));
		if (!Number.isFinite(price) || price <= 0) { throw new Error('Unexpected AWS pricing unit or amount'); }
		return price;
	});
}

const rows = models.map(([id, name, region]) => {
	const availability = aws(region, 'bedrock', 'get-foundation-model-availability', '--model-id', id);
	if (availability.authorizationStatus !== 'AUTHORIZED' || availability.regionAvailability !== 'AVAILABLE'
		|| availability.agreementAvailability?.status !== 'AVAILABLE' || availability.entitlementAvailability !== 'AVAILABLE') {
		throw new Error(`Bedrock model is not available: ${id}`);
	}
	const response = aws('us-east-1', 'pricing', 'get-products', '--service-code', 'AmazonBedrock', '--filters',
		`Type=TERM_MATCH,Field=model,Value=${name}`, `Type=TERM_MATCH,Field=regionCode,Value=${region}`, '--max-results', '100');
	if (response.NextToken) { throw new Error(`Pricing pagination needs review for ${id}`); }
	const products = response.PriceList.map(value => JSON.parse(value)).filter(product => {
		const a = product.product.attributes;
		return !/batch|custom/i.test(a.usagetype || '') && ['Input tokens', 'Output tokens'].includes(a.inferenceType)
			&& (!a.service_tier || a.service_tier.toLowerCase() === 'standard');
	});
	const priceFor = type => {
		const matching = products.filter(p => p.product.attributes.inferenceType === type);
		const runtime = matching.filter(p => !/mantle/i.test(p.product.attributes.usagetype));
		const prices = [...new Set((runtime.length ? runtime : matching).flatMap(perMillion))];
		if (prices.length !== 1) { throw new Error(`Ambiguous ${type} tariff for ${id}`); }
		return prices[0];
	};
	return { id, name, inputPerMillion: priceFor('Input tokens'), outputPerMillion: priceFor('Output tokens'),
		agreementStatus: 'AVAILABLE', authorizationStatus: 'AUTHORIZED', regionAvailability: 'AVAILABLE',
		region, note: `AWS Pricing API, Standard; runtime SKU preferred, verified ${new Date().toISOString().slice(0, 10)}` };
});

if (process.argv.includes('--write-catalog')) {
	const file = path.join(__dirname, '..', 'data', 'bedrock-models.json');
	const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
	const ids = new Set(rows.map(row => row.id));
	fs.writeFileSync(file, JSON.stringify([...existing.filter(row => !ids.has(row.id)), ...rows], null, 2) + '\n');
}
console.log(JSON.stringify(rows, null, 2));
