export type LlmProviderName = 'openrouter' | 'bedrock';

export function envLlmProvider(): LlmProviderName {
	return process.env.LLM_PROVIDER?.trim().toLowerCase() === 'bedrock' ? 'bedrock' : 'openrouter';
}

/** Персональная настройка перекрывает LLM_PROVIDER. Пустое значение — дефолт из окружения. */
export function resolveLlmProvider(choice: 'OPENROUTER' | 'BEDROCK' | null | undefined): LlmProviderName {
	if (choice === 'BEDROCK') {
		return 'bedrock';
	}
	if (choice === 'OPENROUTER') {
		return 'openrouter';
	}
	return envLlmProvider();
}
