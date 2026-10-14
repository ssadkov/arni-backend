import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';

export function middleware(req: NextRequest) {
  return requireAdmin(req) || NextResponse.next();
}

// Указываем Next.js, для каких путей запускать этот middleware
export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};
