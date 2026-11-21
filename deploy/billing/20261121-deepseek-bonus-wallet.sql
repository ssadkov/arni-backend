BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "BudgetWallet" (
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "AccountBudget"("userId") ON DELETE CASCADE ON UPDATE CASCADE,
    "kind" TEXT NOT NULL,
    "models" TEXT[] NOT NULL,
    "grantedMicros" INTEGER NOT NULL CHECK ("grantedMicros" > 0),
    "balanceMicros" INTEGER NOT NULL CHECK ("balanceMicros" >= 0 AND "balanceMicros" <= "grantedMicros"),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "fiveHourLimitMicros" INTEGER NOT NULL,
    "weeklyLimitMicros" INTEGER NOT NULL,
    "fiveHourStartedAt" TIMESTAMP(3),
    "weeklyStartedAt" TIMESTAMP(3),
    "fiveHourUsedMicros" INTEGER NOT NULL DEFAULT 0,
    "weeklyUsedMicros" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BudgetWallet_userId_kind_key" UNIQUE ("userId", "kind")
);

ALTER TABLE "BudgetReservation"
    ADD COLUMN "walletId" TEXT REFERENCES "BudgetWallet"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
    ADD COLUMN "walletMicros" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "walletFiveHourStartedAt" TIMESTAMP(3),
    ADD COLUMN "walletWeeklyStartedAt" TIMESTAMP(3);

ALTER TABLE "UsageLog" ADD COLUMN "walletMicros" INTEGER NOT NULL DEFAULT 0;

COMMIT;
