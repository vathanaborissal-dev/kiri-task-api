/**
 * The permission catalogue.
 *
 * Roles are data (rows in the `Role` table) and hold an array of these keys, so
 * administrators can invent any role they like. The catalogue itself lives in
 * code because every permission needs an enforcement point.
 *
 * `scope`:
 *  - GLOBAL  — only meaningful on an organisation-wide role.
 *  - PROJECT — only meaningful on a project role (checked per project).
 *  - BOTH    — can be granted globally (applies to every project) or per project.
 */

export const WILDCARD = '*' as const;

export type PermissionScope = 'GLOBAL' | 'PROJECT' | 'BOTH';

export type PermissionDefinition = {
  key: string;
  label: string;
  description: string;
  group: string;
  scope: PermissionScope;
};

const def = (
  key: string,
  label: string,
  description: string,
  group: string,
  scope: PermissionScope,
): PermissionDefinition => ({ key, label, description, group, scope });

export const PERMISSIONS: PermissionDefinition[] = [
  // --- Organisation ---------------------------------------------------------
  def('org:manage_settings', 'Manage workspace settings', 'Change workspace-wide configuration.', 'Organisation', 'GLOBAL'),
  def('audit:view', 'View audit log', 'Read the workspace-wide activity and security log.', 'Organisation', 'GLOBAL'),

  // --- Users ----------------------------------------------------------------
  def('user:view', 'View people', 'See the team directory and member profiles.', 'People', 'GLOBAL'),
  def('user:invite', 'Invite people', 'Send invitations to new team members.', 'People', 'GLOBAL'),
  def('user:update', 'Edit people', 'Edit profiles, job titles and responsibilities.', 'People', 'GLOBAL'),
  def('user:manage_status', 'Activate / deactivate people', 'Enable or disable account access.', 'People', 'GLOBAL'),
  def('user:assign_role', 'Assign workspace roles', 'Change which workspace role a person holds.', 'People', 'GLOBAL'),
  def('user:delete', 'Delete people', 'Permanently remove an account.', 'People', 'GLOBAL'),

  // --- Roles ----------------------------------------------------------------
  def('role:view', 'View roles', 'See roles and their permissions.', 'Roles & permissions', 'GLOBAL'),
  def('role:create', 'Create roles', 'Create new custom roles.', 'Roles & permissions', 'GLOBAL'),
  def('role:update', 'Edit roles', 'Rename roles and change their permissions.', 'Roles & permissions', 'GLOBAL'),
  def('role:delete', 'Delete roles', 'Remove custom roles.', 'Roles & permissions', 'GLOBAL'),

  // --- Projects -------------------------------------------------------------
  def('project:view_all', 'View all projects', 'See every project, including ones you are not a member of.', 'Projects', 'GLOBAL'),
  def('project:create', 'Create projects', 'Start a new project.', 'Projects', 'GLOBAL'),
  def('project:view', 'View project', 'Open the project and read its contents.', 'Projects', 'BOTH'),
  def('project:update', 'Edit project', 'Change name, description, dates and status.', 'Projects', 'BOTH'),
  def('project:archive', 'Archive project', 'Archive or restore a project.', 'Projects', 'BOTH'),
  def('project:delete', 'Delete project', 'Permanently delete a project and all of its data.', 'Projects', 'BOTH'),
  def('project:manage_members', 'Manage project members', 'Add or remove members and set their project role.', 'Projects', 'BOTH'),
  def('project:manage_settings', 'Manage project settings', 'Configure statuses, phases, labels and milestones.', 'Projects', 'BOTH'),

  // --- Tasks ----------------------------------------------------------------
  def('task:view', 'View tasks', 'Read tasks and subtasks.', 'Tasks', 'BOTH'),
  def('task:create', 'Create tasks', 'Create tasks, subtasks and checklists.', 'Tasks', 'BOTH'),
  def('task:update', 'Edit tasks', 'Change title, description, priority, labels and effort.', 'Tasks', 'BOTH'),
  def('task:delete', 'Delete tasks', 'Delete tasks and subtasks.', 'Tasks', 'BOTH'),
  def('task:assign', 'Assign tasks', 'Assign or unassign tasks to other people.', 'Tasks', 'BOTH'),
  def('task:change_status', 'Change task status', 'Move tasks between statuses on the board.', 'Tasks', 'BOTH'),
  def('task:manage_deadline', 'Manage task deadlines', 'Set or change start dates and deadlines.', 'Tasks', 'BOTH'),
  def('task:manage_phase', 'Move tasks between phases', 'Promote work through Development → UAT → Pilot → Production.', 'Tasks', 'BOTH'),
  def('task:manage_qa', 'Update testing status', 'Record QA outcomes (passed, failed, in testing).', 'Tasks', 'BOTH'),

  // --- Issues ---------------------------------------------------------------
  def('issue:view', 'View issues', 'Read reported issues and bugs.', 'Issues', 'BOTH'),
  def('issue:create', 'Report issues', 'Report a new issue or bug.', 'Issues', 'BOTH'),
  def('issue:update', 'Edit issues', 'Edit issue details, severity and priority.', 'Issues', 'BOTH'),
  def('issue:delete', 'Delete issues', 'Delete issues.', 'Issues', 'BOTH'),
  def('issue:assign', 'Assign issues', 'Assign issues to team members.', 'Issues', 'BOTH'),
  def('issue:change_status', 'Change issue status', 'Move issues through the workflow.', 'Issues', 'BOTH'),
  def('issue:close', 'Close issues', "Mark an issue closed or won't fix.", 'Issues', 'BOTH'),
  def('issue:reopen', 'Reopen issues', 'Reopen an issue that was resolved, closed or dismissed.', 'Issues', 'BOTH'),

  // --- Releases & hotfixes --------------------------------------------------
  def('release:view', 'View releases', 'See releases, versions and deployment history.', 'Releases', 'BOTH'),
  def('release:create', 'Create releases', 'Create release versions.', 'Releases', 'BOTH'),
  def('release:update', 'Edit releases', 'Edit release details and release notes.', 'Releases', 'BOTH'),
  def('release:delete', 'Delete releases', 'Delete a release.', 'Releases', 'BOTH'),
  def('release:deploy', 'Record deployments', 'Record a deployment of a release to a phase.', 'Releases', 'BOTH'),
  def('hotfix:view', 'View hotfixes', 'See hotfix requests and their progress.', 'Releases', 'BOTH'),
  def('hotfix:create', 'Request hotfixes', 'Raise an urgent production hotfix.', 'Releases', 'BOTH'),
  def('hotfix:update', 'Edit hotfixes', 'Edit and progress a hotfix.', 'Releases', 'BOTH'),
  def('hotfix:approve', 'Approve hotfixes', 'Approve or reject a hotfix request.', 'Releases', 'BOTH'),
  def('hotfix:delete', 'Delete hotfixes', 'Delete a hotfix record.', 'Releases', 'BOTH'),

  // --- Collaboration --------------------------------------------------------
  def('comment:create', 'Comment', 'Post comments and @mention team members.', 'Collaboration', 'BOTH'),
  def('comment:moderate', "Edit / delete others' comments", 'Moderate comments written by other people.', 'Collaboration', 'BOTH'),
  def('attachment:upload', 'Upload attachments', 'Attach images and files.', 'Collaboration', 'BOTH'),
  def('attachment:delete', 'Delete attachments', 'Remove attachments uploaded by anyone.', 'Collaboration', 'BOTH'),

  // --- Daily plans ----------------------------------------------------------
  def('standup:view_team', "See the team's day", 'Read what other people are working on today and what is blocking them.', 'Daily plans', 'BOTH'),

  // --- Reporting ------------------------------------------------------------
  def('report:view', 'View reports', 'See dashboards, progress and workload reports.', 'Reporting', 'BOTH'),
  def('activity:view', 'View activity history', 'Read activity timelines.', 'Reporting', 'BOTH'),
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
const PERMISSION_SET = new Set<string>(PERMISSION_KEYS);
const BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));

export const isValidPermission = (key: string): boolean => key === WILDCARD || PERMISSION_SET.has(key);

export const getPermission = (key: string): PermissionDefinition | undefined => BY_KEY.get(key);

export const globalPermissionKeys = PERMISSIONS.filter((p) => p.scope !== 'PROJECT').map((p) => p.key);
export const projectPermissionKeys = PERMISSIONS.filter((p) => p.scope !== 'GLOBAL').map((p) => p.key);

/** Grouped catalogue for the role editor UI. */
export const permissionGroups = (): { group: string; permissions: PermissionDefinition[] }[] => {
  const order: string[] = [];
  const map = new Map<string, PermissionDefinition[]>();
  for (const p of PERMISSIONS) {
    if (!map.has(p.group)) {
      map.set(p.group, []);
      order.push(p.group);
    }
    map.get(p.group)!.push(p);
  }
  return order.map((group) => ({ group, permissions: map.get(group)! }));
};

/** Convenience type alias — kept loose so custom roles stay data-driven. */
export type PermissionKey = string;
