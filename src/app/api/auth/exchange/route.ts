import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { encryptJWT } from '@/lib/jwt';
import { accountPayload } from '@/lib/freeSteps';
import { desktopCorsHeaders } from '@/lib/desktopCors';

async function exchange(req: NextRequest): Promise<NextResponse> {
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

      return NextResponse.json({ token: sessionJwt, user: accountPayload(user) });
    }

    if (provider === 'vk') {
      const clientId = process.env.VK_CLIENT_ID?.trim() || '54785916';
      const vkRes = await fetch('https://id.vk.ru/oauth2/user_info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, access_token: token }),
      });

      if (!vkRes.ok) {
        return NextResponse.json({ error: 'Invalid VK token' }, { status: 401 });
      }

      const vkProfile = await vkRes.json();
      if (vkProfile.error) {
        return NextResponse.json({ error: 'Invalid VK token' }, { status: 401 });
      }

      const vkUser = vkProfile.user ?? vkProfile.response?.user ?? vkProfile;
      const providerId = String(vkUser.user_id ?? vkUser.id ?? '');
      const email = typeof vkUser.email === 'string' ? vkUser.email.trim().toLowerCase() : '';
      if (!providerId) {
        return NextResponse.json({ error: 'Incomplete user data from VK' }, { status: 400 });
      }

      const existingIdentity = await prisma.identity.findUnique({
        where: { provider_providerId: { provider: 'vk', providerId } },
        include: { user: true },
      });
      let user = existingIdentity?.user;
      if (!user) {
        const userEmail = email || `vk-${providerId}@accounts.arni.invalid`;
        const matchingUser = await prisma.user.upsert({
          where: { email: userEmail },
          update: {},
          create: { email: userEmail },
        });
        const identity = await prisma.identity.upsert({
          where: { provider_providerId: { provider: 'vk', providerId } },
          update: {},
          create: { userId: matchingUser.id, provider: 'vk', providerId },
          include: { user: true },
        });
        user = identity.user;
      }

      const sessionJwt = await encryptJWT({ userId: user.id, email: user.email, plan: user.plan });
      return NextResponse.json({ token: sessionJwt, user: accountPayload(user) });
    }
    if (provider === 'google') {
      // tokeninfo reports which OAuth client the token was issued to. Only tokens
      // issued to our own web or desktop clients are accepted, so a token from
      // another Google app cannot be replayed here.
      const allowedClients = [process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_DESKTOP_CLIENT_ID]
        .map(value => value?.trim())
        .filter((value): value is string => !!value);
      if (allowedClients.length === 0) {
        return NextResponse.json({ error: 'Google sign-in is not configured' }, { status: 503 });
      }
      const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
      if (!googleRes.ok) {
        return NextResponse.json({ error: 'Invalid Google token' }, { status: 401 });
      }
      const googleInfo = await googleRes.json() as { aud?: string; azp?: string; sub?: string; email?: string; email_verified?: string | boolean };
      const audience = googleInfo.aud || googleInfo.azp || '';
      if (!allowedClients.includes(audience)) {
        return NextResponse.json({ error: 'Invalid Google token' }, { status: 401 });
      }
      const providerId = String(googleInfo.sub ?? '');
      const email = typeof googleInfo.email === 'string' ? googleInfo.email.trim().toLowerCase() : '';
      const emailVerified = googleInfo.email_verified === true || googleInfo.email_verified === 'true';
      if (!providerId || !email || !emailVerified) {
        return NextResponse.json({ error: 'Incomplete user data from Google' }, { status: 400 });
      }

      const existingIdentity = await prisma.identity.findUnique({
        where: { provider_providerId: { provider: 'google', providerId } },
        include: { user: true },
      });
      let user = existingIdentity?.user;
      if (!user) {
        const matchingUser = await prisma.user.upsert({
          where: { email },
          update: {},
          create: { email },
        });
        const identity = await prisma.identity.upsert({
          where: { provider_providerId: { provider: 'google', providerId } },
          update: {},
          create: { userId: matchingUser.id, provider: 'google', providerId },
          include: { user: true },
        });
        user = identity.user;
      }

      const sessionJwt = await encryptJWT({ userId: user.id, email: user.email, plan: user.plan });
      return NextResponse.json({ token: sessionJwt, user: accountPayload(user) });
    }
    return NextResponse.json({ error: 'Unsupported provider' }, { status: 400 });
  } catch (error) {
    console.error('Auth Exchange Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/** The Agents window calls this from the renderer, so the response carries CORS for its origin. */
export async function POST(req: NextRequest) {
  const response = await exchange(req);
  for (const [name, value] of Object.entries(desktopCorsHeaders(req))) {
    response.headers.set(name, value);
  }
  return response;
}

export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: desktopCorsHeaders(req) });
}
