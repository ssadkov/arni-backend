import sharp from 'sharp';
import { IMAGE_MAX_BYTES } from './imageModels';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

export function isPng(image: Buffer) {
	return image.length >= 24 && image.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** Keep product PNG ≤ IMAGE_MAX_BYTES without rejecting a billed Bedrock result. */
export async function fitImagePng(image: Buffer, maxBytes = IMAGE_MAX_BYTES): Promise<Buffer> {
	if (!isPng(image)) {
		throw new Error('not_png');
	}
	if (image.length <= maxBytes) {
		return image;
	}
	const meta = await sharp(image).metadata();
	let width = meta.width || 1024;
	let height = meta.height || 1024;
	for (let step = 0; step < 12; step++) {
		const out = await sharp(image)
			.resize({
				width: Math.max(64, Math.round(width)),
				height: Math.max(64, Math.round(height)),
				fit: 'inside',
				withoutEnlargement: true,
			})
			.png({ compressionLevel: 9, adaptiveFiltering: true })
			.toBuffer();
		if (out.length <= maxBytes) {
			return out;
		}
		width *= 0.85;
		height *= 0.85;
	}
	throw new Error('png_too_large');
}
