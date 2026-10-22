/** Match only explicit provider context failures, not unrelated validation errors. */
export function isContextError(status: number, text: string): boolean {
	if (status !== 400 && status !== 413) { return false; }
	try {
		const error = JSON.parse(text)?.error;
		if (['context_length_exceeded', 'context_too_large', 'model_context_window_exceeded'].includes(error?.code)) { return true; }
		const message = typeof error === 'string' ? error : error?.message;
		return typeof message === 'string' && /(?:context.{0,80}(?:exceed|too (?:long|large))|(?:exceed|too (?:long|large)).{0,80}context|maximum context length.{0,200}(?:requested|resulted)|(?:input|prompt) is too long)/i.test(message);
	} catch { return false; }
}

export const CONTEXT_ERROR_MESSAGE = 'Запрос с инструкциями, инструментами и историей превышает контекст модели. Сожмите историю или уменьшите вложения. Если это первый вопрос, уменьшите набор навыков и инструментов. Повтор того же запроса не поможет.';
