import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const url = req.nextUrl;

  // Защищаем все роуты, начинающиеся с /admin
  if (url.pathname.startsWith('/admin')) {
    const basicAuth = req.headers.get('authorization');

    // Берем логин и пароль из переменных окружения (или используем дефолтные для локальных тестов)
    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminPass = process.env.ADMIN_PASS || 'arni2026';

    const expectedAuth = `Basic ${btoa(`${adminUser}:${adminPass}`)}`;

    if (basicAuth !== expectedAuth) {
      return new NextResponse('Authentication required', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="Secure Admin Area"',
        },
      });
    }
  }

  return NextResponse.next();
}

// Указываем Next.js, для каких путей запускать этот middleware
export const config = {
  matcher: ['/admin/:path*'],
};
