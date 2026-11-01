import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_ORIGIN = 'https://chat.arnion.kz';

export function allowedWebOrigins(): Set<string> {
	const configured = (process.env.WEB_APP_ORIGIN || DEFAULT_ORIGIN)
		.split(',')
		.map(origin => origin.trim())
		.filter(Boolean);
	const origins = new Set(configured);
	origins.add(DEFAULT_ORIGIN);
	if (process.env.NODE_ENV !== 'production') {
		origins.add('http://localhost:5173');
		origins.add('http://127.0.0.1:5173');
	}
	return origins;
}

export function webCorsHeaders(req: NextRequest, extraExpose = ''): Record<string, string> {
	const origin = req.headers.get('origin');
	if (!origin || !allowedWebOrigins().has(origin)) {
		return {};
	}
	const expose = ['X-Arni-Sources', extraExpose].filter(Boolean).join(', ');
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
		'Access-Control-Expose-Headers': expose,
		Vary: 'Origin',
	};
}

export function webOptions(req: NextRequest) {
	return new NextResponse(null, { status: 204, headers: webCorsHeaders(req) });
}

export function webJson(req: NextRequest, body: unknown, status = 200) {
	return NextResponse.json(body, { status, headers: { ...webCorsHeaders(req), 'Cache-Control': 'private, no-store' } });
}
