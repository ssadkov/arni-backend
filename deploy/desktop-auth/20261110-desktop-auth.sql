-- Desktop sign-in challenges for Arni Lite. Apply once to the existing Postgres. Do not use db push.
-- deviceCodeHash is the only copy of the client secret. The JWT is not stored.

CREATE TABLE "DesktopAuthRequest" (
    "id" TEXT NOT NULL,
    "deviceCodeHash" TEXT NOT NULL,
    "userCodeHash" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "userId" TEXT,
    "clientIpHash" TEXT,
    "pollIntervalSec" INTEGER NOT NULL DEFAULT 5,
    "lastPolledAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesktopAuthRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DesktopAuthRequest_deviceCodeHash_key" ON "DesktopAuthRequest"("deviceCodeHash");
CREATE INDEX "DesktopAuthRequest_expiresAt_idx" ON "DesktopAuthRequest"("expiresAt");
CREATE INDEX "DesktopAuthRequest_clientIpHash_createdAt_idx" ON "DesktopAuthRequest"("clientIpHash", "createdAt");

ALTER TABLE "DesktopAuthRequest" ADD CONSTRAINT "DesktopAuthRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
