import { after, NextRequest, NextResponse } from 'next/server';
import { decryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import {
  FREE_DAILY_STEP_LIMIT,
  freeStepHeaders,
  freeStepSnapshot,
  releaseFreeStep,
  reserveFreeStep,
  type FreeStepSnapshot,
} from '@/lib/freeSteps';
import { completeWithBedrock } from '@/lib/llm/bedrock';
import { modelIdForUser } from '@/lib/llm/bedrockAccess';
import { completeWithOpenRouter } from '@/lib/llm/openrouter';
import { resolveLlmProvider } from '@/lib/llm/provider';
import { recordModelRequest } from '@/lib/modelRequests';
import { rememberUnavailable, routeFreeModel } from '@/lib/openRouterStatus';
import { BudgetError, reserveBudget, settleBudget } from '@/lib/budget';
import { budgetPrice, managedBody, type BudgetBody } from '@/lib/budgetPricing';
import { validUsage, type ReportedUsage } from '@/lib/budgetPolicy';
import { usageStream } from '@/lib/usageStream';
import { MAX_CHAT_BYTES, screenshotCount } from '@/lib/llm/vision';
import { costMicros } from '@/lib/budgetPolicy';

export const maxDuration = 300;

function freeLimitResponse(snapshot: FreeStepSnapshot) {
  return NextResponse.json({
    error: {
      code: 'free_daily_limit',
      message: `Дневной лимит бесплатных запросов исчерпан (${FREE_DAILY_STEP_LIMIT} шагов агента). Он обновится в ${snapshot.resetsAt.slice(11, 16)} UTC.`,
      freeSteps: snapshot,
    },
  }, {
    status: 429,
    headers: {
      ...freeStepHeaders(snapshot),
      'Retry-After': String(Math.max(1, Math.ceil((Date.parse(snapshot.resetsAt) - Date.now()) / 1000))),
    },
  });
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  let reservedUserId: string | null = null;
  let trackedUserId: string | undefined;
  let trackedModel = 'unknown';
  let routedFrom: string | null = null;
  let budgetReservationId: string | null = null;
  let upstreamDispatched = false;
  let requestedModel = 'unknown';
  let trackedSource: string | undefined;
  const track = (statusCode: number, error?: string | null, model = trackedModel) => {
    if (!trackedUserId) {
      return Promise.resolve();
    }
    return recordModelRequest({
      userId: trackedUserId,
      model,
      statusCode,
      durationMs: Date.now() - startedAt,
      error,
      routedFrom,
      requestId, requestedModel, source: trackedSource, region: trackedSource === 'bedrock' ? process.env.AWS_REGION || 'us-east-1' : undefined,
    });
  };
  try {
    // 1. Авторизация
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = authHeader.split(' ')[1];
    let jwtPayload;
    try {
      jwtPayload = await decryptJWT(token);
    } catch {
      return NextResponse.json({ error: 'Invalid Token' }, { status: 401 });
    }

    // 2. Получение пользователя и проверка баланса
    const user = await prisma.user.findUnique({
      where: { id: jwtPayload.userId },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    trackedUserId = user.id;

    if (user.isBanned) {
      await track(403, 'Account is blocked');
      return NextResponse.json({ error: 'Account is blocked' }, { status: 403 });
    }

    // OpenRouter's :free variants do not spend Arni's paid-model allowance.
    // Bedrock подменяет модель на inference profile Claude и не тратит квоту :free.
    let body;
    try {
      const raw = await req.text();
      if (Buffer.byteLength(raw) > MAX_CHAT_BYTES) { return NextResponse.json({ error: 'Request exceeds 3.8 MB; resize screenshots' }, { status: 413 }); }
      body = JSON.parse(raw);
    } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { return NextResponse.json({ error: 'Invalid request' }, { status: 400 }); }
    const budget = await prisma.accountBudget.findUnique({ where: { userId: user.id } });
    const provider = resolveLlmProvider(user.llmProvider);
    trackedSource = provider;
    requestedModel = typeof body.model === 'string' ? body.model.slice(0, 200) : 'unknown';
    if (budget) { body = managedBody(body as BudgetBody, provider === 'bedrock'); }
    const images = screenshotCount(body.messages || []);
    const isFreeModel = provider === 'openrouter' && typeof body.model === 'string' && body.model.endsWith(':free');
    trackedModel = typeof body.model === 'string' && body.model ? body.model : 'unknown';

    // Платные модели OpenRouter — только в тарифе Pro. Пока его нет, клиент предлагает
    // записаться в лист ожидания (POST /api/waitlist).
    if (!budget && provider === 'openrouter' && !isFreeModel && user.plan !== 'PRO') {
      const message = 'Эта модель будет доступна в тарифе Pro. Выберите бесплатную модель или нажмите «Сообщить о запуске», чтобы узнать, когда Pro откроется.';
      await track(402, message);
      return NextResponse.json({
        error: {
          code: 'pro_required',
          message,
        },
      }, { status: 402 });
    }

    if (!budget && provider === 'openrouter' && !isFreeModel && user.tokenBalance <= 0) {
      const message = 'На балансе закончились токены для платных моделей.';
      await track(402, message);
      return NextResponse.json({
        error: { code: 'insufficient_tokens', message },
      }, { status: 402 });
    }

    if (!budget && provider === 'bedrock' && user.tokenBalance <= 0) {
      const message = 'На балансе закончились токены для Claude через Bedrock.';
      await track(402, message);
      return NextResponse.json({
        error: { code: 'insufficient_tokens', message },
      }, { status: 402 });
    }

    let forcedBedrockModel: string | undefined;
    if (provider === 'bedrock' && (budget || await prisma.bedrockModel.count() > 0)) {
      const allowed = await modelIdForUser(user.id, user.bedrockModelId);
      if (!allowed) {
        const message = 'Для этого аккаунта не включена ни одна модель Bedrock.';
        await track(403, message);
        return NextResponse.json({
          error: { code: 'model_disabled', message },
        }, { status: 403 });
      }
      forcedBedrockModel = allowed;
      trackedModel = allowed;
    }

    let freeSteps: FreeStepSnapshot | null = null;
    if (isFreeModel && !budget) {
      freeSteps = await reserveFreeStep(user.id);
      if (!freeSteps) {
        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        await track(429, 'free_daily_limit');
        return freeLimitResponse(freeStepSnapshot(fresh ?? user));
      }
      reservedUserId = user.id;
    }

    // 3. Подготовка запроса для OpenRouter
    
    // Включаем встроенный подсчет токенов для стриминга (OpenAI совместимый параметр)
    if (body.stream) {
      body.stream_options = { include_usage: true };
    }

    // A red :free model is sent to the next green or yellow model in picker order.
    // Bedrock and paid models are left untouched.
    if (isFreeModel && typeof body.model === 'string') {
      const routed = await routeFreeModel(body.model);
      if (routed.routedFrom) {
        routedFrom = routed.routedFrom;
        body.model = routed.model;
        trackedModel = routed.model;
      }
    }

    // 4. Выбранный провайдер. Ответ всегда в формате OpenAI, чтобы редактор не менялся.
    if (budget) {
      const model = forcedBedrockModel || body.model;
      if (typeof model !== 'string' || !model) { throw new BudgetError('invalid_model', 'Выберите модель.', 400); }
      const price = await budgetPrice(body, provider, model);
      const reservation = await reserveBudget(user.id, model, provider, price.reservedMicros, price.input, price.output,
        { requestId, requestedModel, imageCount: images, region: provider === 'bedrock' ? process.env.AWS_REGION || 'us-east-1' : undefined });
      budgetReservationId = reservation.id;
    }
    const catalogPrice = provider === 'bedrock' && forcedBedrockModel
      ? await prisma.bedrockModel.findUnique({ where: { id: forcedBedrockModel } }) : null;
    upstreamDispatched = true;
    let response = provider === 'bedrock'
      ? await completeWithBedrock(body, forcedBedrockModel)
      : await completeWithOpenRouter(body);

    // One extra hop when OpenRouter refuses a free model. The failed attempt is logged,
    // then the next healthy free model is tried once.
    if (isFreeModel && (response.status === 502 || response.status === 503)) {
      const failedModel = trackedModel;
      const errorText = await response.text();
      await track(response.status, errorText, failedModel);
      rememberUnavailable(failedModel);
      const routed = await routeFreeModel(failedModel);
      if (routed.routedFrom && routed.model !== failedModel) {
        routedFrom = routed.routedFrom;
        body.model = routed.model;
        trackedModel = routed.model;
        response = await completeWithOpenRouter(body);
      } else {
        if (budgetReservationId) { await settleBudget(budgetReservationId, null); }
        if (reservedUserId) {
          freeSteps = await releaseFreeStep(reservedUserId);
          reservedUserId = null;
        }
        return new NextResponse(errorText, {
          status: response.status,
          headers: freeSteps ? freeStepHeaders(freeSteps) : undefined,
        });
      }
    }

    const servedModel = response.headers.get('X-Llm-Model') || forcedBedrockModel || body.model || trackedModel;

    if (!response.ok) {
      if (budgetReservationId) { await settleBudget(budgetReservationId, null, response.status >= 400 && response.status < 500 && response.status !== 408); }
      const errorText = await response.text();
      await track(response.status, errorText, servedModel);
      if (reservedUserId) {
        freeSteps = await releaseFreeStep(reservedUserId);
        reservedUserId = null;
      }
      return new NextResponse(errorText, {
        status: response.status,
        headers: freeSteps ? freeStepHeaders(freeSteps) : undefined,
      });
    }

    await track(response.status, null, servedModel);

    // Шаг уже зарезервирован: ответ OpenRouter принят, даже если поток оборвётся.
    reservedUserId = null;

    const recordUsage = async (usage: ReportedUsage | null) => {
      if (budgetReservationId) {
        await settleBudget(budgetReservationId, usage);
        return;
      }
      if (!usage) { return; }
      const promptTokens = usage.prompt_tokens;
      const completionTokens = usage.completion_tokens;
      const input = catalogPrice?.inputPerMillion; const output = catalogPrice?.outputPerMillion;
      const measuredCost = provider === 'openrouter' && usage.cost !== undefined ? Math.ceil(usage.cost * 1_000_000)
        : isFreeModel ? 0 : input != null && output != null ? costMicros(promptTokens, completionTokens, input, output) : null;
      const data = { userId: user.id, model: servedModel, requestedModel, requestId, promptTokens, completionTokens, source: provider,
        imageCount: images, region: provider === 'bedrock' ? process.env.AWS_REGION || 'us-east-1' : null,
        inputPerMillion: input, outputPerMillion: output, costMicros: measuredCost,
        accounting: 'legacy', costBasis: measuredCost == null ? null : provider === 'openrouter' ? 'provider' : 'catalog' };
      if (isFreeModel) { await prisma.usageLog.create({ data }); }
      else {
        await prisma.$transaction([
          prisma.user.update({ where: { id: user.id }, data: { tokenBalance: { decrement: promptTokens + completionTokens } } }),
          prisma.usageLog.create({ data }),
        ]);
      }
    };

    // 5. Обработка стриминга и перехват использования токенов
    if (body.stream) {
      if (!response.body) { await recordUsage(null); throw new Error('Empty upstream stream'); }
      const monitored = usageStream(response.body, recordUsage);
      after(() => monitored.completed);
      return new NextResponse(monitored.stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...(freeSteps ? freeStepHeaders(freeSteps) : {}),
        },
      });
    }

    // 6. Обработка обычного (не потокового) запроса
    const json = await response.json();
    await recordUsage(validUsage(json.usage));

    return NextResponse.json(json, {
      headers: freeSteps ? freeStepHeaders(freeSteps) : undefined,
    });

  } catch (error) {
    if (budgetReservationId) {
      try { await settleBudget(budgetReservationId, null, !upstreamDispatched); }
      catch { console.error('Budget remains pending; reconciliation required'); }
    }
    if (reservedUserId) {
      try {
        await releaseFreeStep(reservedUserId);
      } catch (releaseError) {
        console.error('Failed to release free step:', releaseError);
      }
    }
    if (error instanceof BudgetError) {
      await track(error.status, error.code);
      return NextResponse.json({ error: { code: error.code, message: error.message, resetsAt: error.resetsAt } }, {
        status: error.status,
        headers: error.resetsAt ? { 'Retry-After': String(Math.max(1, Math.ceil((Date.parse(error.resetsAt) - Date.now()) / 1000))) } : undefined,
      });
    }
    console.error('Chat completions failed');
    await track(500, error instanceof Error ? error.message : 'Internal Server Error');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
