BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "UsageLog"
    ADD COLUMN "generationId" TEXT,
    ADD COLUMN "finishReason" TEXT,
    ADD COLUMN "streamError" TEXT;

COMMIT;
