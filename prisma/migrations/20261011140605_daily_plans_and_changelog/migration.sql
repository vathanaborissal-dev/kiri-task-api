-- CreateEnum
CREATE TYPE "DailyPlanItemKind" AS ENUM ('FOCUS', 'BLOCKER');

-- AlterEnum
ALTER TYPE "NotificationEvent" ADD VALUE 'STANDUP_BLOCKER';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "changelogSeenAt" TIMESTAMP(3),
ADD COLUMN     "guideSeenAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DailyPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyPlanItem" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "kind" "DailyPlanItemKind" NOT NULL DEFAULT 'FOCUS',
    "body" TEXT NOT NULL,
    "isDone" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "order" INTEGER NOT NULL DEFAULT 0,
    "taskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyPlanItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyPlan_date_idx" ON "DailyPlan"("date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyPlan_userId_date_key" ON "DailyPlan"("userId", "date");

-- CreateIndex
CREATE INDEX "DailyPlanItem_planId_idx" ON "DailyPlanItem"("planId");

-- CreateIndex
CREATE INDEX "DailyPlanItem_taskId_idx" ON "DailyPlanItem"("taskId");

-- AddForeignKey
ALTER TABLE "DailyPlan" ADD CONSTRAINT "DailyPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPlanItem" ADD CONSTRAINT "DailyPlanItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "DailyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyPlanItem" ADD CONSTRAINT "DailyPlanItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
