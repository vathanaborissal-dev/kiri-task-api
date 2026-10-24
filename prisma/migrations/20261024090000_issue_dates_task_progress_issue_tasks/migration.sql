-- Issue gains a start date; `dueDate` is the end date the forms already collect.
ALTER TABLE "Issue" ADD COLUMN "startDate" TIMESTAMP(3);

-- Self-reported completion on a task, 0-100.
ALTER TABLE "Task" ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0;

-- One issue can have many tasks. `Issue.taskId` stays as the primary fix task.
ALTER TABLE "Task" ADD COLUMN "issueId" TEXT;

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_issueId_fkey" FOREIGN KEY ("issueId")
  REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Task_issueId_idx" ON "Task"("issueId");

-- Backfill: every task an issue already nominates becomes one of that issue's tasks.
UPDATE "Task" t
   SET "issueId" = i."id"
  FROM "Issue" i
 WHERE i."taskId" = t."id"
   AND t."issueId" IS NULL;

-- Tasks already parked in a DONE column are complete.
UPDATE "Task" t
   SET "progress" = 100
  FROM "TaskStatus" s
 WHERE t."statusId" = s."id"
   AND s."category" = 'DONE';
