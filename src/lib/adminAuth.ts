import { NextRequest, NextResponse } from 'next/server';

export function getAdminCredentials(): { user: string; pass: string } {
	return {
		user: process.env.ADMIN_USER || 'admin',
		pass: process.env.ADMIN_PASS || 'arni2026',
	};
}

export function expectedAdminAuthorization(): string {
	const { user, pass } = getAdminCredentials();
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
	if (req.headers.get('authorization') !== expectedAdminAuthorization()) {
		return unauthorizedAdminResponse();
	}
	return null;
}
