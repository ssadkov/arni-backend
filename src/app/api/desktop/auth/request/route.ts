import { NextRequest } from 'next/server';
import { describeDesktopRequest } from '@/lib/desktopAuth';
import { webJson, webOptions } from '@/lib/webCors';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function GET(req: NextRequest) {
	if (req.nextUrl.searchParams.has('device_code')) {
		return webJson(req, { error: { code: 'invalid_request', message: 'Секрет устройства в адресе не принимается.' } }, 400);
	}
	const requestId = req.nextUrl.searchParams.get('request_id') || '';
	const described = await describeDesktopRequest(requestId);
	if (!described) {
		return webJson(req, { error: { code: 'expired', message: 'Запрос входа не найден или истёк.' } }, 404);
	}
	return webJson(req, described);
}
