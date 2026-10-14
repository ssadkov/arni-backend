import { NextRequest, NextResponse } from 'next/server';

export function getAdminCredentials(): { user: string; pass: string } | null {
	if (!process.env.ADMIN_PASS) { return null; }
	return {
		user: process.env.ADMIN_USER || 'admin',
		pass: process.env.ADMIN_PASS,
	};
}

export function expectedAdminAuthorization(): string | null {
	const credentials = getAdminCredentials();
	if (!credentials) { return null; }
	const { user, pass } = credentials;
	return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

export function unauthorizedAdminResponse(): NextResponse {
	return new NextResponse('Authentication required', {
		status: 401,
		headers: {
			'WWW-Authenticate': 'Basic realm="Secure Admin Area"',
		},
	});
}

export function requireAdmin(req: NextRequest): NextResponse | null {
	const expected = expectedAdminAuthorization();
	if (!expected || req.headers.get('authorization') !== expected) {
		return unauthorizedAdminResponse();
	}
	// Basic authentication is cached by the browser. Don't accept cross-site mutations.
	if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
		const origin = req.headers.get('origin');
		// The Russia proxy deliberately forwards Host as arni-backend.vercel.app.
		const sameOrigin = !origin || origin === req.nextUrl.origin || (origin === 'https://api.arnion.ru' && req.nextUrl.hostname === 'arni-backend.vercel.app');
		if (req.headers.get('sec-fetch-site') === 'cross-site' || !sameOrigin) {
			return NextResponse.json({ error: 'Cross-origin admin mutation denied' }, { status: 403 });
		}
	}
	return null;
}
