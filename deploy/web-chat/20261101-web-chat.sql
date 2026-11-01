-- Browser chat tables. Apply once to the existing Postgres. Do not use db push.
-- Message text is not written to UsageLog.

CREATE TABLE "WebChat" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebChat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebMessage" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'complete',
    "sources" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebMemory" (
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebMemory_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "WebImage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT,
    "mediaType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebImage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebLoginCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebLoginCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebChat_userId_updatedAt_idx" ON "WebChat"("userId", "updatedAt");
CREATE INDEX "WebMessage_chatId_createdAt_idx" ON "WebMessage"("chatId", "createdAt");
CREATE INDEX "WebImage_userId_idx" ON "WebImage"("userId");
CREATE INDEX "WebLoginCode_expiresAt_idx" ON "WebLoginCode"("expiresAt");

ALTER TABLE "WebChat" ADD CONSTRAINT "WebChat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebMessage" ADD CONSTRAINT "WebMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "WebChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebMemory" ADD CONSTRAINT "WebMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebImage" ADD CONSTRAINT "WebImage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebImage" ADD CONSTRAINT "WebImage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "WebMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebLoginCode" ADD CONSTRAINT "WebLoginCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
