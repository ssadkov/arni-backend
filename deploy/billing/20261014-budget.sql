-- AlterTable
ALTER TABLE "UsageLog" ADD COLUMN     "accounting" TEXT,
ADD COLUMN     "costMicros" INTEGER;

-- CreateTable
CREATE TABLE "AccountBudget" (
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "balanceMicros" INTEGER NOT NULL DEFAULT 0,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "fiveHourLimitMicros" INTEGER NOT NULL DEFAULT 2000000,
    "weeklyLimitMicros" INTEGER NOT NULL DEFAULT 5000000,
    "fiveHourRequestLimit" INTEGER NOT NULL DEFAULT 150,
    "weeklyRequestLimit" INTEGER NOT NULL DEFAULT 1000,
    "fiveHourStartedAt" TIMESTAMP(3),
    "weeklyStartedAt" TIMESTAMP(3),
    "fiveHourUsedMicros" INTEGER NOT NULL DEFAULT 0,
    "weeklyUsedMicros" INTEGER NOT NULL DEFAULT 0,
    "fiveHourRequests" INTEGER NOT NULL DEFAULT 0,
    "weeklyRequests" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AccountBudget_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "BudgetEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "amountMicros" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "payloadHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetReservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reservedMicros" INTEGER NOT NULL,
    "inputPerMillion" DOUBLE PRECISION NOT NULL,
    "outputPerMillion" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "costMicros" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "fiveHourStartedAt" TIMESTAMP(3) NOT NULL,
    "weeklyStartedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BudgetEntry_key_key" ON "BudgetEntry"("key");

-- CreateIndex
CREATE INDEX "BudgetEntry_userId_createdAt_idx" ON "BudgetEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BudgetReservation_userId_status_idx" ON "BudgetReservation"("userId", "status");

-- AddForeignKey
ALTER TABLE "AccountBudget" ADD CONSTRAINT "AccountBudget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetEntry" ADD CONSTRAINT "BudgetEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AccountBudget"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetReservation" ADD CONSTRAINT "BudgetReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AccountBudget"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
