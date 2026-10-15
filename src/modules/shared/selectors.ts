/** Shared Prisma selects, so every endpoint shapes users the same way. */
export const userSummary = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true,
  jobTitle: true,
  isActive: true,
} as const;

export const roleSummary = {
  id: true,
  key: true,
  name: true,
  scope: true,
} as const;

export const projectSummary = {
  id: true,
  key: true,
  name: true,
  color: true,
  status: true,
} as const;

export const statusSummary = {
  id: true,
  key: true,
  name: true,
  category: true,
  color: true,
  order: true,
  isDefault: true,
} as const;

export const phaseSummary = {
  id: true,
  key: true,
  name: true,
  color: true,
  order: true,
  isProduction: true,
} as const;

export const labelSummary = { id: true, name: true, color: true } as const;

/** Just enough of a task to render a link to it. */
export const taskRefSelect = {
  id: true,
  key: true,
  title: true,
  status: { select: statusSummary },
  project: { select: projectSummary },
} as const;
