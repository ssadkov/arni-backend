-- Markup settings and Sheremetev payment notices.
-- Safe to run again. Does not change existing balances.
-- Apply before the API that reads these columns is deployed.
BEGIN;

ALTER TABLE "AccountBudget" ADD COLUMN IF NOT EXISTS "limitsEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "BudgetEntry" ADD COLUMN IF NOT EXISTS "rubKopecks" INTEGER;
ALTER TABLE "BudgetEntry" ADD COLUMN IF NOT EXISTS "rubPerUsd" DOUBLE PRECISION;
ALTER TABLE "BudgetEntry" ADD COLUMN IF NOT EXISTS "externalId" TEXT;

ALTER TABLE "BudgetReservation" ADD COLUMN IF NOT EXISTS "providerCostMicros" INTEGER;
ALTER TABLE "BudgetReservation" ADD COLUMN IF NOT EXISTS "markupPercent" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "UsageLog" ADD COLUMN IF NOT EXISTS "providerCostMicros" INTEGER;
ALTER TABLE "UsageLog" ADD COLUMN IF NOT EXISTS "markupPercent" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "BillingMarkup" (
  "id" TEXT NOT NULL,
  "percent" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingMarkup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PaymentNotice" (
  "idAccount" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accountNumber" TEXT,
  "idRate" TEXT NOT NULL,
  "accountStatus" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "amountKopecks" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'RUB',
  "rubPerUsd" DOUBLE PRECISION,
  "creditedMicros" INTEGER NOT NULL DEFAULT 0,
  "paymentSystem" TEXT,
  "provider" TEXT,
  "email" TEXT,
  "goods" JSONB,
  "dateOfOrder" TIMESTAMP(3),
  "dateOfPayment" TIMESTAMP(3),
  "eventAt" TIMESTAMP(3) NOT NULL,
  "testMode" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentNotice_pkey" PRIMARY KEY ("idAccount")
);

CREATE INDEX IF NOT EXISTS "PaymentNotice_userId_createdAt_idx" ON "PaymentNotice" ("userId", "createdAt");

COMMIT;
