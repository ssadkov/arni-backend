module.exports = ['test:free', 'test/vision:free', 'test/text:free', 'test/paid'].map(id => ({
	id, name: id, supported_parameters: ['tools'], context_length: 131072,
	architecture: { input_modalities: id.includes('text') ? ['text'] : ['text', 'image'] },
	pricing: { prompt: id.endsWith(':free') ? '0' : '0.000001', completion: id.endsWith(':free') ? '0' : '0.000002', request: '0' },
	top_provider: { max_completion_tokens: 4096 },
}));
