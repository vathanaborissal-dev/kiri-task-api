-- CreateTable
CREATE TABLE "TelegramPending" (
    "chatId" BIGINT NOT NULL,
    "action" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramPending_pkey" PRIMARY KEY ("chatId")
);

-- CreateIndex
CREATE INDEX "TelegramPending_expiresAt_idx" ON "TelegramPending"("expiresAt");
