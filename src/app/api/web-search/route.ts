import { NextRequest, NextResponse } from 'next/server';
import { BudgetError } from '@/lib/budget';
import { mediaUser } from '@/lib/mediaAuth';
import { searchExaWeb } from '@/lib/webSearch';

export const dynamic = 'force-dynamic';

/** Signed-in desktop agents search the web through the shared Exa key. */
export async function POST(req: NextRequest) {
	try {
		await mediaUser(req);
		const body = await req.json().catch(() => undefined);
		const query = body && typeof body === 'object' && typeof body.query === 'string' ? body.query : '';
		const results = await searchExaWeb(query);
		if (results === undefined) {
			throw new BudgetError('search_unconfigured', 'Web search is unavailable.', 503);
		}
		return NextResponse.json({ results }, { headers: { 'Cache-Control': 'private, no-store' } });
	} catch (error) {
		const known = error instanceof BudgetError;
		return NextResponse.json(
			{ error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Web search failed.' } },
			{ status: known ? error.status : 500, headers: { 'Cache-Control': 'private, no-store' } },
		);
	}
}
