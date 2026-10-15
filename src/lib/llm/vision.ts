import { BudgetError } from '@/lib/budget';
import { modelCapabilities } from './modelCapabilities';

export const MAX_IMAGE_BYTES = 2_500_000;
export const MAX_CHAT_BYTES = 3_800_000;
export function supportsScreenshots(model: string) { return modelCapabilities(model).vision; }

/** Accept embedded screenshots only; never fetch model-supplied URLs on the server. */
export function decodeScreenshot(value: unknown) {
	if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40) {
		throw new BudgetError('invalid_image', 'Прикрепите PNG/JPEG размером до 2,5 МБ.', 400);
	}
	const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
	if (!match) { throw new BudgetError('invalid_image', 'Скриншот должен быть встроенным PNG/JPEG, а не ссылкой.', 400); }
	const bytes = Buffer.from(match[2], 'base64');
	if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== match[2]) { throw new BudgetError('invalid_image', 'Некорректный размер или base64 изображения.', 400); }
	let width = 0; let height = 0;
	if (match[1] === 'png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') {
		width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
	} else if (match[1] === 'jpeg' && bytes[0] === 255 && bytes[1] === 216) {
		for (let pos = 2; pos + 8 < bytes.length;) {
			if (bytes[pos++] !== 255) { break; }
			while (bytes[pos] === 255) { pos++; }
			const marker = bytes[pos++];
			if (pos + 2 > bytes.length) { break; }
			if (marker === 217 || marker === 218) { break; }
			if (marker === 1 || marker >= 208 && marker <= 215) { continue; }
			const length = bytes.readUInt16BE(pos);
			if (length < 2 || pos + length > bytes.length) { break; }
			if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) {
				height = bytes.readUInt16BE(pos + 3); width = bytes.readUInt16BE(pos + 5); break;
			}
			pos += length;
		}
	}
	if (!width || !height || width > 8000 || height > 8000) { throw new BudgetError('invalid_image', 'Изображение повреждено или превышает 8000×8000.', 400); }
	return { format: match[1] as 'png' | 'jpeg', bytes, width, height };
}

export function screenshotCount(messages: Array<Record<string, unknown>>) {
	if (!Array.isArray(messages) || messages.some(message => !message || typeof message !== 'object')) {
		throw new BudgetError('invalid_messages', 'Некорректный список сообщений.', 400);
	}
	let count = 0; let total = 0;
	for (const message of messages) {
		if (!Array.isArray(message.content)) { continue; }
		for (const part of message.content) {
			if (part?.type !== 'image_url') { continue; }
			if (!['user', 'tool'].includes(String(message.role))) { throw new BudgetError('invalid_image_role', 'Изображения допустимы в сообщении пользователя или результате инструмента.', 400); }
			const image = decodeScreenshot(part.image_url?.url);
			count++; total += image.bytes.length;
		}
	}
	if (count > 20 || total > MAX_IMAGE_BYTES) { throw new BudgetError('images_too_large', 'Уменьшите число или размер скриншотов: всего до 2,5 МБ на запрос.', 400); }
	return count;
}

/** Upper-bound unmerged vision patches for models without a CountTokens API. */
export function conservativeInputTokenBound(messages: Array<Record<string, unknown>>, tools: unknown) {
	let patches = 0;
	const textMessages = messages.map(message => ({ ...message, content: Array.isArray(message.content)
		? message.content.map(part => {
			if (part?.type !== 'image_url') { return part; }
			const { width, height } = decodeScreenshot(part.image_url?.url);
			patches += Math.ceil(width / 14) * Math.ceil(height / 14) + 1024;
			return { type: 'text', text: '[image]' };
		}) : message.content }));
	return Buffer.byteLength(JSON.stringify({ messages: textMessages, tools }), 'utf8') + 1024 + messages.length * 32 + patches;
}
