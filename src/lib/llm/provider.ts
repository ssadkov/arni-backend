export type LlmProviderName = 'openrouter' | 'bedrock';

/** Пустое значение — OpenRouter. Bedrock только если он выбран у пользователя. */
export function resolveLlmProvider(choice: 'OPENROUTER' | 'BEDROCK' | null | undefined): LlmProviderName {
	return choice === 'BEDROCK' ? 'bedrock' : 'openrouter';
}
