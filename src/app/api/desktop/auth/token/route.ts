import { NextRequest } from 'next/server';
import { pollDesktopToken } from '@/lib/desktopAuth';
import { webJson, webOptions } from '@/lib/webCors';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function POST(req: NextRequest) {
	if (req.nextUrl.searchParams.has('device_code')) {
		return webJson(req, { error: { code: 'invalid_request', message: 'Секрет устройства в адресе не принимается.' } }, 400);
	}
	const body = await req.json().catch(() => null) as { device_code?: string } | null;
	const result = await pollDesktopToken(body?.device_code || '');
	return webJson(req, result);
}
