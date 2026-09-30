import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

// Лист ожидания Pro для лендинга: без входа, только контакт. Вызывается формой
// на /waitlist и напрямую с arnion.ru, поэтому отвечает с CORS-заголовками.

const MAX_CONTACT_LENGTH = 200;
const ALLOWED_ORIGINS = new Set(['https://arnion.ru', 'https://www.arnion.ru']);

// Почта или ник в Telegram (@name либо t.me/name).
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEGRAM = /^(@|(https?:\/\/)?t\.me\/)[A-Za-z0-9_]{4,32}$/;

function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return {};
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export async function POST(req: NextRequest) {
  const headers = corsHeaders(req);
  try {
    const body = await req.json().catch(() => ({}));

    // Поле-приманка: люди его не видят, боты заполняют. Отвечаем как при успехе.
    if (typeof body?.website === 'string' && body.website !== '') {
      return NextResponse.json({ joined: true }, { headers });
    }

    const contact = typeof body?.contact === 'string' ? body.contact.trim() : '';
    if (!contact || contact.length > MAX_CONTACT_LENGTH || !(EMAIL.test(contact) || TELEGRAM.test(contact))) {
      return NextResponse.json({
        error: { code: 'invalid_contact', message: 'Укажите почту или ник в Telegram, например name@example.ru или @username.' },
      }, { status: 400, headers });
    }

    const source = typeof body?.source === 'string' ? body.source.trim().slice(0, 40) : '';
    const normalized = EMAIL.test(contact) ? contact.toLowerCase() : contact;
    await prisma.waitlistEntry.upsert({
      where: { contact: normalized },
      update: {},
      create: { contact: normalized, ...(source ? { source } : {}) },
    });

    return NextResponse.json({ joined: true }, { headers });
  } catch (error) {
    console.error('Public waitlist error:', error);
    return NextResponse.json({ error: { code: 'server_error', message: 'Не получилось записаться. Попробуйте позже.' } }, { status: 500, headers });
  }
}
