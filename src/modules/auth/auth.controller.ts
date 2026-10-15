import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { DEFAULT_GLOBAL_ROLE_KEY } from '../../config/systemRoles.js';
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from '../../lib/cookies.js';
import { sha256 } from '../../lib/crypto.js';
import { badRequest } from '../../lib/errors.js';
import { passwordResetEmail, sendEmail } from '../../lib/email.js';
import { logger } from '../../lib/logger.js';
import { hashPassword } from '../../lib/password.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { logActivity } from '../../services/activity.js';
import { AuthContext } from '../../services/authContext.js';
import * as service from './auth.service.js';

export const postLogin = async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };
  const tokens = await service.login(email, password, req);
  setAuthCookies(res, tokens);
  const auth = await AuthContext.forUserId((await currentUserIdFromEmail(email)) ?? '');
  res.json({ user: auth?.toPublic() ?? null, csrfToken: tokens.csrfToken });
};

const currentUserIdFromEmail = async (email: string) => {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  return user?.id ?? null;
};

export const postRefresh = async (req: Request, res: Response) => {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (!raw) {
    clearAuthCookies(res);
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Your session has expired' } });
    return;
  }
  try {
    const tokens = await service.rotateRefreshToken(raw, req);
    setAuthCookies(res, tokens);
    res.json({ csrfToken: tokens.csrfToken });
  } catch (error) {
    // A refresh token that cannot be rotated is spent — revoked, expired or
    // replayed. Leaving it in the browser traps the user: the proxy routes on
    // the cookie's presence, so it keeps sending them back into the app, where
    // every request 401s and bounces them to /login again.
    clearAuthCookies(res);
    throw error;
  }
};

export const postLogout = async (req: Request, res: Response) => {
  await service.revokeRefreshToken(req.cookies?.[REFRESH_COOKIE]);
  clearAuthCookies(res);
  res.status(204).end();
};

export const getMe = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const [memberships, unread] = await Promise.all([
    prisma.projectMember.findMany({
      where: { userId: auth.id, project: { archivedAt: null } },
      select: {
        projectId: true,
        responsibilities: true,
        project: { select: { id: true, key: true, name: true, color: true, status: true } },
        role: { select: { id: true, key: true, name: true, permissions: true } },
      },
      orderBy: { project: { name: 'asc' } },
    }),
    prisma.notification.count({ where: { userId: auth.id, readAt: null } }),
  ]);

  res.json({
    user: auth.toPublic(),
    unreadNotifications: unread,
    projects: memberships.map((m) => ({
      ...m.project,
      role: { id: m.role.id, key: m.role.key, name: m.role.name },
      responsibilities: m.responsibilities,
      permissions: [...new Set([...auth.globalPermissions, ...m.role.permissions])],
    })),
  });
};

/**
 * Marks the "What's new" list or the getting-started guide as read. Stored on
 * the account rather than in the browser so the dot does not come back on the
 * next machine.
 */
export const markSeen = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as { changelog?: boolean; guide?: boolean };
  const now = new Date();

  await prisma.user.update({
    where: { id: auth.id },
    data: {
      ...(body.changelog ? { changelogSeenAt: now } : {}),
      ...(body.guide ? { guideSeenAt: now } : {}),
    },
  });

  const updated = await AuthContext.forUserId(auth.id);
  res.json({ user: updated?.toPublic() });
};

export const patchProfile = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as Record<string, unknown>;
  await prisma.user.update({ where: { id: auth.id }, data: body });
  const updated = await AuthContext.forUserId(auth.id);
  res.json({ user: updated?.toPublic() });
};

export const postChangePassword = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { currentPassword, newPassword } = req.body as {
    currentPassword: string;
    newPassword: string;
  };
  await service.changePassword(auth.id, currentPassword, newPassword);
  clearAuthCookies(res);
  res.json({ ok: true, message: 'Password updated. Please sign in again.' });
};

export const postForgotPassword = async (req: Request, res: Response) => {
  const { email } = req.body as { email: string };
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, passwordHash: true, isActive: true },
  });

  if (user?.isActive) {
    const token = service.createPasswordResetToken(user.id, user.passwordHash);
    await sendEmail({
      to: [{ email: user.email, name: user.name }],
      subject: 'Reset your Kiri Task password',
      html: passwordResetEmail({
        name: user.name,
        resetUrl: `${env.WEB_APP_URL}/reset-password?token=${encodeURIComponent(token)}`,
      }),
    });
  }

  // Nothing was sent, and the caller is told the same thing either way, so this
  // is the only place the gap becomes visible to whoever runs the service.
  if (user?.isActive && !env.emailEnabled) {
    logger.error(
      { userId: user.id },
      'Password reset requested but email is not configured — the user received nothing',
    );
  }

  // Always the same response — no account enumeration.
  res.json({ ok: true, message: 'If that email is registered, a reset link is on its way.' });
};

export const postResetPassword = async (req: Request, res: Response) => {
  const { token, password } = req.body as { token: string; password: string };
  await service.resetPassword(token, password);
  res.json({ ok: true, message: 'Password updated. You can sign in now.' });
};

export const getInvitation = async (req: Request, res: Response) => {
  const token = String(req.query.token ?? '');
  if (!token) throw badRequest('Missing invitation token');
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: sha256(token) },
    select: {
      email: true,
      name: true,
      status: true,
      expiresAt: true,
      role: { select: { name: true } },
      invitedBy: { select: { name: true } },
    },
  });

  if (!invitation || invitation.status !== 'PENDING' || invitation.expiresAt < new Date()) {
    throw badRequest('This invitation is no longer valid');
  }

  res.json({
    email: invitation.email,
    name: invitation.name,
    roleName: invitation.role.name,
    invitedBy: invitation.invitedBy.name,
  });
};

export const postAcceptInvitation = async (req: Request, res: Response) => {
  const { token, name, password } = req.body as { token: string; name?: string; password: string };

  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: sha256(token) },
    include: { role: true },
  });

  if (!invitation || invitation.status !== 'PENDING' || invitation.expiresAt < new Date()) {
    throw badRequest('This invitation is no longer valid');
  }

  const existing = await prisma.user.findUnique({ where: { email: invitation.email } });
  if (existing) throw badRequest('An account with that email already exists. Please sign in.');

  const fallbackRole = await prisma.role.findUnique({ where: { key: DEFAULT_GLOBAL_ROLE_KEY } });
  const grants = Array.isArray(invitation.projectGrants)
    ? (invitation.projectGrants as { projectId: string; roleId: string }[])
    : [];

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: invitation.email,
        name: name ?? invitation.name ?? invitation.email.split('@')[0]!,
        passwordHash: await hashPassword(password),
        globalRoleId: invitation.role.scope === 'GLOBAL' ? invitation.roleId : fallbackRole!.id,
      },
    });

    if (grants.length > 0) {
      await tx.projectMember.createMany({
        data: grants.map((g) => ({
          projectId: g.projectId,
          userId: created.id,
          roleId: g.roleId,
        })),
        skipDuplicates: true,
      });
    }

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });

    return created;
  });

  await logActivity({
    actorId: user.id,
    action: 'user.joined',
    entityType: 'USER',
    entityId: user.id,
    meta: { invitedBy: invitation.invitedById },
  });

  const tokens = await service.issueTokens(user, req);
  setAuthCookies(res, tokens);
  const auth = await AuthContext.forUserId(user.id);
  res.status(201).json({ user: auth?.toPublic(), csrfToken: tokens.csrfToken });
};

export const getSessions = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  res.json({ data: await service.listSessions(auth.id, req.cookies?.[REFRESH_COOKIE]) });
};

export const deleteSession = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  await service.revokeSession(auth.id, String(req.params.sessionId));
  res.status(204).end();
};

export const deleteAllSessions = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  await service.revokeAllSessions(auth.id);
  clearAuthCookies(res);
  res.status(204).end();
};
