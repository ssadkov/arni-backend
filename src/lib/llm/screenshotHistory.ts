/**
 * Agents take a screenshot after nearly every browser action, and the client resends the whole history each step.
 * A 10-minute DeepSeek session on 2026-11-19 reached 20 screenshots per request (696 sent in total) and the 21st
 * was refused with images_too_large. The model needs the recent frames; older ones become a short text note.
 */
export const KEPT_SCREENSHOTS = 6;
/** Same total as MAX_IMAGE_BYTES in vision.ts; kept here so this module has no server imports. */
const KEPT_SCREENSHOT_BYTES = 2_500_000;
export const PRUNED_SCREENSHOT_TEXT = '[Старый скриншот удалён из истории, чтобы уложиться в лимит. Сделайте новый, если он нужен.]';

type Part = { type?: unknown; image_url?: { url?: unknown }; text?: unknown };
type Message = Record<string, unknown> & { content?: unknown };

/** Decoded size of a data URL; anything else counts as zero and is left for validation to reject. */
function imageBytes(part: Part): number {
	const url = part.image_url?.url;
	if (typeof url !== 'string') { return 0; }
	const comma = url.indexOf(',');
	return comma < 0 ? 0 : Math.floor((url.length - comma - 1) * 3 / 4);
}

/** Keeps the newest screenshots within the count and size budget; replaces older ones with text, newest first. */
export function pruneScreenshots<T extends Message>(messages: T[], keep = KEPT_SCREENSHOTS, maxBytes = KEPT_SCREENSHOT_BYTES): T[] {
	let kept = 0;
	let bytes = 0;
	const result = [...messages];
	for (let i = result.length - 1; i >= 0; i--) {
		const content = result[i].content;
		if (!Array.isArray(content) || !content.some((part: Part) => part?.type === 'image_url')) { continue; }
		let changed = false;
		const parts = [...content].reverse().map((part: Part) => {
			if (part?.type !== 'image_url') { return part; }
			const size = imageBytes(part);
			if (kept < keep && bytes + size <= maxBytes) { kept++; bytes += size; return part; }
			changed = true;
			return { type: 'text', text: PRUNED_SCREENSHOT_TEXT };
		}).reverse();
		if (changed) { result[i] = { ...result[i], content: parts }; }
	}
	return result;
}
