import type { StatusCategory } from '../generated/prisma/enums.js';

export type StatusSeed = {
  key: string;
  name: string;
  category: StatusCategory;
  color: string;
  isDefault?: boolean;
};

/** Board columns created with every new project; fully editable afterwards. */
export const DEFAULT_TASK_STATUSES: StatusSeed[] = [
  { key: 'backlog', name: 'Backlog', category: 'TODO', color: '#94a3b8' },
  { key: 'todo', name: 'To Do', category: 'TODO', color: '#64748b', isDefault: true },
  { key: 'in-progress', name: 'In Progress', category: 'IN_PROGRESS', color: '#3b82f6' },
  { key: 'in-review', name: 'In Review', category: 'IN_REVIEW', color: '#a855f7' },
  { key: 'blocked', name: 'Blocked', category: 'BLOCKED', color: '#ef4444' },
  { key: 'done', name: 'Done', category: 'DONE', color: '#22c55e' },
  { key: 'canceled', name: 'Canceled', category: 'CANCELED', color: '#71717a' },
];

export type PhaseSeed = {
  key: string;
  name: string;
  description: string;
  color: string;
  isProduction?: boolean;
};

/** Development → UAT → Pilot → Production. Projects can add or rename phases. */
export const DEFAULT_PHASES: PhaseSeed[] = [
  {
    key: 'development',
    name: 'Development',
    description: 'Being built and tested by the development team.',
    color: '#3b82f6',
  },
  {
    key: 'uat',
    name: 'UAT',
    description: 'Awaiting or undergoing user acceptance testing.',
    color: '#f59e0b',
  },
  {
    key: 'pilot',
    name: 'Pilot',
    description: 'Released to a limited group of real users.',
    color: '#8b5cf6',
  },
  {
    key: 'production',
    name: 'Production',
    description: 'Live for all users.',
    color: '#22c55e',
    isProduction: true,
  },
];

export const DEFAULT_LABELS = [
  { name: 'frontend', color: '#38bdf8' },
  { name: 'backend', color: '#a78bfa' },
  { name: 'database', color: '#fb923c' },
  { name: 'infra', color: '#64748b' },
  { name: 'design', color: '#f472b6' },
  { name: 'documentation', color: '#2dd4bf' },
  { name: 'urgent', color: '#ef4444' },
];
