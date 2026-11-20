BEGIN;

CREATE TABLE "BudgetWallet" (
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "campaign" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "grantedMicros" INTEGER NOT NULL CHECK ("grantedMicros" > 0),
    "balanceMicros" INTEGER NOT NULL CHECK ("balanceMicros" >= 0 AND "balanceMicros" <= "grantedMicros"),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "BudgetWallet_userId_campaign_key" ON "BudgetWallet"("userId", "campaign");

ALTER TABLE "BudgetEntry"
    DROP CONSTRAINT "BudgetEntry_userId_fkey",
    ADD CONSTRAINT "BudgetEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD COLUMN "walletId" TEXT REFERENCES "BudgetWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BudgetReservation"
    DROP CONSTRAINT "BudgetReservation_userId_fkey",
    ADD CONSTRAINT "BudgetReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD COLUMN "walletId" TEXT REFERENCES "BudgetWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ALTER COLUMN "fiveHourStartedAt" DROP NOT NULL,
    ALTER COLUMN "weeklyStartedAt" DROP NOT NULL;

COMMIT;
