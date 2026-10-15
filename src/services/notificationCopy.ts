const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  description: 'description',
  type: 'work type',
  priority: 'priority',
  status: 'status',
  statusId: 'status',
  phaseId: 'phase',
  qaStatus: 'testing state',
  assigneeId: 'assignee',
  assigneeIds: 'assignees',
  labelIds: 'labels',
  milestoneId: 'milestone',
  releaseId: 'release',
  startDate: 'start date',
  dueDate: 'deadline',
  estimateHours: 'estimate',
  spentHours: 'time spent',
  stepsToReproduce: 'steps to reproduce',
  expectedResult: 'expected result',
  actualResult: 'actual result',
  severity: 'severity',
  taskId: 'linked task',
};

export const shortDescription = (description: string | null | undefined) => {
  const clean = description?.trim().replace(/\s+/g, ' ');
  if (!clean) return 'No description';
  return clean.length > 420 ? `${clean.slice(0, 420)}…` : clean;
};

export const changedFieldNames = (fields: string[]) => {
  const names = [...new Set(fields.map((field) => FIELD_LABELS[field] ?? field))];
  return names.length ? names.join(', ') : 'details';
};
