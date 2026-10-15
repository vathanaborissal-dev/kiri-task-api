import { WILDCARD } from '../config/permissions.js';
import { forbidden, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  jobTitle: string | null;
  timezone: string;
  isActive: boolean;
  mustChangePassword: boolean;
  changelogSeenAt: Date | null;
  guideSeenAt: Date | null;
  telegramChatId: bigint | null;
  telegramUsername: string | null;
  globalRole: { id: string; key: string; name: string; permissions: string[] };
};

export type ProjectAccess = {
  projectId: string;
  projectKey: string;
  isMember: boolean;
  /** Project role, when the user is a member. */
  role: { id: string; key: string; name: string } | null;
  permissions: Set<string>;
};

const userSelect = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  jobTitle: true,
  timezone: true,
  isActive: true,
  mustChangePassword: true,
  changelogSeenAt: true,
  guideSeenAt: true,
  telegramChatId: true,
  telegramUsername: true,
  globalRole: { select: { id: true, key: true, name: true, permissions: true } },
} as const;

/**
 * Everything authorisation needs for one request, resolved lazily.
 *
 * Effective project permissions are the union of the workspace role's
 * permissions and the project role's permissions, so somebody can be a Project
 * Manager on one project and a Viewer on another.
 */
export class AuthContext {
  readonly user: AuthUser;
  readonly globalPermissions: Set<string>;
  readonly isSuperAdmin: boolean;
  private readonly projectCache = new Map<string, ProjectAccess | null>();
  private accessibleIds: string[] | null = null;

  constructor(user: AuthUser) {
    this.user = user;
    this.globalPermissions = new Set(user.globalRole.permissions);
    this.isSuperAdmin = this.globalPermissions.has(WILDCARD);
  }

  static async forUserId(userId: string): Promise<AuthContext | null> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: userSelect });
    if (!user || !user.isActive) return null;
    return new AuthContext(user as AuthUser);
  }

  get id(): string {
    return this.user.id;
  }

  /** Workspace-level check. */
  can(permission: string): boolean {
    return this.isSuperAdmin || this.globalPermissions.has(permission);
  }

  assert(permission: string, message?: string): void {
    if (!this.can(permission)) throw forbidden(message ?? `Missing permission: ${permission}`);
  }

  /** Resolves (and caches) the user's access to one project. */
  async project(projectIdOrKey: string): Promise<ProjectAccess | null> {
    const cached = this.projectCache.get(projectIdOrKey);
    if (cached !== undefined) return cached;

    const project = await prisma.project.findFirst({
      where: { OR: [{ id: projectIdOrKey }, { key: projectIdOrKey.toUpperCase() }] },
      select: {
        id: true,
        key: true,
        members: {
          where: { userId: this.user.id },
          select: { role: { select: { id: true, key: true, name: true, permissions: true } } },
        },
      },
    });

    if (!project) {
      this.projectCache.set(projectIdOrKey, null);
      return null;
    }

    const membership = project.members[0];
    const permissions = new Set<string>(this.globalPermissions);
    if (membership) for (const p of membership.role.permissions) permissions.add(p);

    // Workspace-wide visibility for admins / auditors even without membership.
    if (this.isSuperAdmin || this.globalPermissions.has('project:view_all')) {
      permissions.add('project:view');
    }

    const hasAnyAccess = this.isSuperAdmin || Boolean(membership) || permissions.has('project:view');

    const access: ProjectAccess | null = hasAnyAccess
      ? {
          projectId: project.id,
          projectKey: project.key,
          isMember: Boolean(membership),
          role: membership
            ? { id: membership.role.id, key: membership.role.key, name: membership.role.name }
            : null,
          permissions,
        }
      : null;

    this.projectCache.set(projectIdOrKey, access);
    if (access) this.projectCache.set(project.id, access);
    return access;
  }

  async canInProject(projectIdOrKey: string, permission: string): Promise<boolean> {
    if (this.isSuperAdmin) return true;
    const access = await this.project(projectIdOrKey);
    if (!access) return false;
    return access.permissions.has(permission);
  }

  /**
   * Resolves a project the user may act on, or throws.
   * 404 (not 403) when the project is invisible, so we never leak its existence.
   */
  async requireProject(projectIdOrKey: string, permission: string): Promise<ProjectAccess> {
    const access = await this.project(projectIdOrKey);
    if (!access) throw notFound('Project not found');
    if (!this.isSuperAdmin && !access.permissions.has(permission)) {
      throw forbidden(`Missing permission: ${permission}`);
    }
    return access;
  }

  /** Project ids the user can read, for cross-project queries. */
  async accessibleProjectIds(): Promise<string[]> {
    if (this.accessibleIds) return this.accessibleIds;

    if (this.isSuperAdmin || this.globalPermissions.has('project:view_all')) {
      const all = await prisma.project.findMany({ select: { id: true } });
      this.accessibleIds = all.map((p) => p.id);
      return this.accessibleIds;
    }

    const memberships = await prisma.projectMember.findMany({
      where: { userId: this.user.id },
      select: { projectId: true },
    });
    this.accessibleIds = memberships.map((m) => m.projectId);
    return this.accessibleIds;
  }

  /** Subset of accessible projects where the user holds `permission`. */
  async projectIdsWith(permission: string): Promise<string[]> {
    if (this.isSuperAdmin || this.globalPermissions.has(permission)) {
      return this.accessibleProjectIds();
    }
    const memberships = await prisma.projectMember.findMany({
      where: { userId: this.user.id },
      select: { projectId: true, role: { select: { permissions: true } } },
    });
    return memberships
      .filter((m) => m.role.permissions.includes(permission) || m.role.permissions.includes(WILDCARD))
      .map((m) => m.projectId);
  }

  toPublic() {
    return {
      id: this.user.id,
      email: this.user.email,
      name: this.user.name,
      avatarUrl: this.user.avatarUrl,
      jobTitle: this.user.jobTitle,
      timezone: this.user.timezone,
      mustChangePassword: this.user.mustChangePassword,
      // The client compares these against its own changelog and guide, so it
      // can show the "new" dot without another round trip.
      changelogSeenAt: this.user.changelogSeenAt,
      guideSeenAt: this.user.guideSeenAt,
      telegramLinked: this.user.telegramChatId !== null,
      telegramUsername: this.user.telegramUsername,
      globalRole: {
        id: this.user.globalRole.id,
        key: this.user.globalRole.key,
        name: this.user.globalRole.name,
      },
      permissions: [...this.globalPermissions],
    };
  }
}

export const authUserSelect = userSelect;
