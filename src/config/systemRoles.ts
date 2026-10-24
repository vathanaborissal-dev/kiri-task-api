import { WILDCARD, globalPermissionKeys, projectPermissionKeys } from './permissions.js';

export type SystemRoleSeed = {
  key: string;
  name: string;
  description: string;
  scope: 'GLOBAL' | 'PROJECT';
  permissions: string[];
  isDefault?: boolean;
};

const READ_ONLY_PROJECT = [
  'project:view',
  'task:view',
  'issue:view',
  'release:view',
  'hotfix:view',
  'report:view',
  'activity:view',
];

const CONTRIBUTOR_PROJECT = [
  ...READ_ONLY_PROJECT,
  'task:create',
  'task:update',
  'task:change_status',
  'task:manage_phase',
  'issue:create',
  'issue:update',
  'issue:change_status',
  'comment:create',
  'attachment:upload',
];

/**
 * Seeded starting points. Every one of these can be renamed, re-scoped or
 * re-permissioned from the UI, and admins can add as many custom roles as they
 * want — nothing in the code branches on a role name.
 */
export const SYSTEM_ROLES: SystemRoleSeed[] = [
  {
    key: 'administrator',
    name: 'Administrator',
    description: 'Full access to everything in the workspace.',
    scope: 'GLOBAL',
    permissions: [WILDCARD],
  },
  {
    key: 'member',
    name: 'Member',
    description:
      'Default workspace role. Can see the team directory and work on the projects they are a member of.',
    scope: 'GLOBAL',
    permissions: ['user:view', 'role:view'],
    isDefault: true,
  },
  {
    key: 'workspace-manager',
    name: 'Workspace Manager',
    description: 'Creates projects and manages people, without workspace settings access.',
    scope: 'GLOBAL',
    permissions: [
      'user:view',
      'user:invite',
      'user:update',
      'user:manage_status',
      'role:view',
      'project:create',
      'project:view_all',
      'report:view',
      'activity:view',
      'standup:view_team',
    ],
  },
  {
    key: 'head-of-department',
    name: 'Head of Department',
    description:
      'Runs the department: full access to every project, plus people and role administration.',
    scope: 'GLOBAL',
    // Every permission in the catalogue, spelled out rather than WILDCARD.
    // The two are equivalent in power — each enforcement point is
    // `isSuperAdmin || permissions.has(key)`, and every key is present — but an
    // enumerated role renders in the role editor with each box ticked, so an
    // administrator can withdraw one later. A wildcard role shows nothing to
    // withdraw and silently short-circuits every check.
    permissions: [...globalPermissionKeys],
  },
  {
    key: 'guest',
    name: 'Guest',
    description: 'Read-only workspace access; project access is granted per project.',
    scope: 'GLOBAL',
    permissions: ['user:view'],
  },

  // --- Project roles --------------------------------------------------------
  {
    key: 'project-manager',
    name: 'Project Manager',
    description: 'Runs the project: members, planning, deadlines, releases and reports.',
    scope: 'PROJECT',
    permissions: projectPermissionKeys.filter((p) => p !== 'project:delete'),
  },
  {
    key: 'team-lead',
    name: 'Team Lead',
    description: 'Plans and assigns work, manages deadlines, releases and hotfixes.',
    scope: 'PROJECT',
    permissions: [
      ...CONTRIBUTOR_PROJECT,
      'task:assign',
      'task:manage_deadline',
      'task:manage_qa',
      'task:delete',
      'issue:assign',
      'issue:close',
      'issue:reopen',
      'release:create',
      'release:update',
      'release:deploy',
      'hotfix:create',
      'hotfix:update',
      'hotfix:approve',
      'attachment:delete',
      'comment:moderate',
      'project:manage_settings',
      'standup:view_team',
    ],
  },
  {
    key: 'developer',
    name: 'Developer',
    description: 'Works on tasks, reports issues, moves work through the phases.',
    scope: 'PROJECT',
    permissions: [...CONTRIBUTOR_PROJECT, 'task:manage_qa', 'hotfix:update'],
    isDefault: true,
  },
  {
    key: 'qa',
    name: 'QA / Tester',
    description: 'Tests work, records QA outcomes and reports issues.',
    scope: 'PROJECT',
    permissions: [
      ...READ_ONLY_PROJECT,
      'task:change_status',
      'task:manage_qa',
      'issue:create',
      'issue:update',
      'issue:change_status',
      'issue:reopen',
      'comment:create',
      'attachment:upload',
      'hotfix:create',
    ],
  },
  {
    key: 'issue-manager',
    name: 'Issue Manager',
    description:
      'Owns the issue queue: triages, assigns, closes and reopens issues without running the rest of the project.',
    scope: 'PROJECT',
    permissions: [
      ...READ_ONLY_PROJECT,
      'issue:create',
      'issue:update',
      'issue:delete',
      'issue:assign',
      'issue:change_status',
      'issue:close',
      'issue:reopen',
      'task:create',
      'task:assign',
      'task:manage_deadline',
      'comment:create',
      'comment:moderate',
      'attachment:upload',
      'attachment:delete',
      'standup:view_team',
    ],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access to the project.',
    scope: 'PROJECT',
    permissions: READ_ONLY_PROJECT,
  },
];

/**
 * Permissions introduced after the first release.
 *
 * `seedRoles` deliberately leaves an existing role's permissions alone so that
 * administrator edits survive an upgrade — which also means a brand-new
 * permission would never reach a workspace that has already been seeded. These
 * pairs are granted once, and only when the key is missing, so removing one by
 * hand afterwards stays removed.
 */
export const LATER_GRANTS: { roleKey: string; permission: string }[] = [
  { roleKey: 'workspace-manager', permission: 'standup:view_team' },
  { roleKey: 'project-manager', permission: 'standup:view_team' },
  { roleKey: 'team-lead', permission: 'standup:view_team' },
  // Closing and reopening were carved out of `issue:change_status`. Without
  // these, an existing workspace's leads would lose an ability they had.
  { roleKey: 'project-manager', permission: 'issue:close' },
  { roleKey: 'project-manager', permission: 'issue:reopen' },
  { roleKey: 'team-lead', permission: 'issue:close' },
  { roleKey: 'team-lead', permission: 'issue:reopen' },
  { roleKey: 'qa', permission: 'issue:reopen' },
  { roleKey: 'head-of-department', permission: 'issue:close' },
  { roleKey: 'head-of-department', permission: 'issue:reopen' },
];

export const DEFAULT_GLOBAL_ROLE_KEY = 'member';
export const DEFAULT_PROJECT_ROLE_KEY = 'developer';
export const ADMIN_ROLE_KEY = 'administrator';

export const systemGlobalPermissionCatalogue = globalPermissionKeys;
