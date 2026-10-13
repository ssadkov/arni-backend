import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { importBedrockCatalog } from '@/lib/llm/bedrockAccess';

export async function POST(req: NextRequest) {
	const denied = requireAdmin(req);
	if (denied) {
		return denied;
	}

	try {
		const count = await importBedrockCatalog();
		return NextResponse.json({ imported: count });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Import failed';
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
