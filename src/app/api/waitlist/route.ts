import { NextRequest, NextResponse } from 'next/server';
import { decryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';

// Лист ожидания тарифа Pro. Пользователь определяется по токену Arni, поэтому
// кнопке «Сообщить о запуске» ничего спрашивать не нужно. Если у аккаунта нет
// настоящей почты (VK без email), клиент может передать контакт: почту или Telegram.

const MAX_CONTACT_LENGTH = 200;

async function authorizedUserId(req: NextRequest): Promise<string | undefined> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return undefined;
  }
  try {
    const payload = await decryptJWT(authHeader.slice('Bearer '.length));
    return typeof payload.userId === 'string' ? payload.userId : undefined;
  } catch {
    return undefined;
  }
}

/** Настоящая почта, а не заглушка для VK-аккаунтов без email. */
function hasRealEmail(email: string): boolean {
  return !email.endsWith('.invalid');
}

export async function GET(req: NextRequest) {
  const userId = await authorizedUserId(req);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }
  return NextResponse.json({
    joined: user.proWaitlistAt !== null,
    needsContact: !hasRealEmail(user.email) && !user.proWaitlistContact,
  });
}

export async function POST(req: NextRequest) {
  try {
    const userId = await authorizedUserId(req);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const contact = typeof body?.contact === 'string' ? body.contact.trim().slice(0, MAX_CONTACT_LENGTH) : '';

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        // Первое нажатие важнее для очереди, повторное его не сдвигает.
        proWaitlistAt: user.proWaitlistAt ?? new Date(),
        ...(contact ? { proWaitlistContact: contact } : {}),
      },
    });

    return NextResponse.json({
      joined: true,
      needsContact: !hasRealEmail(updated.email) && !updated.proWaitlistContact,
    });
  } catch (error) {
    console.error('Waitlist error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
