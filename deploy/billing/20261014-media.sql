-- AlterTable
ALTER TABLE "ModelRequest" ADD COLUMN     "operation" TEXT NOT NULL DEFAULT 'chat',
ADD COLUMN     "region" TEXT,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "requestedModel" TEXT,
ADD COLUMN     "source" TEXT;

-- AlterTable
ALTER TABLE "UsageLog" ADD COLUMN     "costBasis" TEXT,
ADD COLUMN     "imageCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "inputPerMillion" DOUBLE PRECISION,
ADD COLUMN     "operation" TEXT NOT NULL DEFAULT 'chat',
ADD COLUMN     "outputPerMillion" DOUBLE PRECISION,
ADD COLUMN     "region" TEXT,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "requestedModel" TEXT,
ADD COLUMN     "unitPriceMicros" INTEGER;

-- AlterTable
ALTER TABLE "BudgetReservation" ADD COLUMN     "imageCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "operation" TEXT NOT NULL DEFAULT 'chat',
ADD COLUMN     "region" TEXT,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "requestedModel" TEXT,
ADD COLUMN     "unitPriceMicros" INTEGER;

-- CreateTable
CREATE TABLE "MediaGeneration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reservationId" TEXT,
    "image" BYTEA,
    "mimeType" TEXT,
    "seed" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaGeneration_reservationId_key" ON "MediaGeneration"("reservationId");

-- CreateIndex
CREATE INDEX "MediaGeneration_userId_createdAt_idx" ON "MediaGeneration"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaGeneration_userId_requestKey_key" ON "MediaGeneration"("userId", "requestKey");

-- CreateIndex
CREATE INDEX "ModelRequest_requestId_idx" ON "ModelRequest"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageLog_requestId_key" ON "UsageLog"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetReservation_requestId_key" ON "BudgetReservation"("requestId");

-- AddForeignKey
ALTER TABLE "MediaGeneration" ADD CONSTRAINT "MediaGeneration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
