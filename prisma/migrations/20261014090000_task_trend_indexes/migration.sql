-- Portfolio trend groups tasks by completion / creation week across every
-- project, which was a sequential scan on Task before these.
CREATE INDEX "Task_projectId_completedAt_idx" ON "Task"("projectId", "completedAt");
CREATE INDEX "Task_projectId_createdAt_idx" ON "Task"("projectId", "createdAt");
