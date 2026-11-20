import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** AES-256-CBC + base64url(iv + ciphertext). Same layout as the Sheremetev checkout decrypt. */
export function encryptCheckoutEmail(email: string, secret: string): string {
	const key = createHash('sha256').update(secret.trim(), 'utf8').digest();
	const iv = randomBytes(16);
	const cipher = createCipheriv('aes-256-cbc', key, iv);
	const encrypted = Buffer.concat([cipher.update(email.trim().toLowerCase(), 'utf8'), cipher.final()]);
	return Buffer.concat([iv, encrypted]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decryptCheckoutEmail(payload: string, secret: string): string {
	const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
	const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
	const raw = Buffer.from(normalized + pad, 'base64');
	const key = createHash('sha256').update(secret.trim(), 'utf8').digest();
	const decipher = createDecipheriv('aes-256-cbc', key, raw.subarray(0, 16));
	return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8').trim().toLowerCase();
}
