import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { encryptJWT } from '@/lib/jwt';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { provider, token } = body;

    if (!provider || !token) {
      return NextResponse.json({ error: 'Missing provider or token' }, { status: 400 });
    }

    if (provider === 'yandex') {
      // 1. Validate Yandex token
      const yandexRes = await fetch('https://login.yandex.ru/info?format=json', {
        headers: {
          Authorization: `OAuth ${token}`,
        },
      });

      if (!yandexRes.ok) {
        return NextResponse.json({ error: 'Invalid Yandex token' }, { status: 401 });
      }

      const yandexUser = await yandexRes.json();
      const email = yandexUser.default_email || yandexUser.emails?.[0];
      const yandexId = yandexUser.id;

      if (!email || !yandexId) {
        return NextResponse.json({ error: 'Incomplete user data from Yandex' }, { status: 400 });
      }

      // 2. Find or create user
      let user = await prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        user = await prisma.user.create({
          data: {
            email,
            identities: {
              create: {
                provider: 'yandex',
                providerId: yandexId,
              },
            },
          },
        });
      } else {
        // Ensure identity is linked
        const identity = await prisma.identity.findUnique({
          where: {
            provider_providerId: {
              provider: 'yandex',
              providerId: yandexId,
            },
          },
        });

        if (!identity) {
          await prisma.identity.create({
            data: {
              userId: user.id,
              provider: 'yandex',
              providerId: yandexId,
            },
          });
        }
      }

      // 3. Generate Arni JWT
      const sessionJwt = await encryptJWT({
        userId: user.id,
        email: user.email,
        plan: user.plan,
      });

      return NextResponse.json({ token: sessionJwt, user: { email: user.email, plan: user.plan, balance: user.tokenBalance } });
    }

    return NextResponse.json({ error: 'Unsupported provider' }, { status: 400 });
  } catch (error) {
    console.error('Auth Exchange Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
