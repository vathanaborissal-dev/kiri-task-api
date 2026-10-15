import type { Request } from 'express';
import { env } from '../../config/env.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { badRequest, forbidden, unauthorized } from '../../lib/errors.js';
import { signAccessToken, signScopedToken, verifyScopedToken } from '../../lib/jwt.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { prisma } from '../../lib/prisma.js';
import { logActivity } from '../../services/activity.js';

export type IssuedTokens = { accessToken: string; refreshToken: string; csrfToken: string };

const refreshExpiry = () =>
  new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

const requestMeta = (req: Request) => ({
  userAgent: req.headers['user-agent']?.slice(0, 255) ?? null,
  ipAddress: req.ip ?? null,
});

export const issueTokens = async (
  user: { id: string; email: string },
  req: Request,
  familyId?: string,
): Promise<IssuedTokens> => {
  const refreshToken = randomToken(48);
  const family = familyId ?? randomToken(16);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refreshToken),
      familyId: family,
      expiresAt: refreshExpiry(),
      ...requestMeta(req),
    },
  });

  return {
    accessToken: signAccessToken({ sub: user.id, email: user.email, fam: family }),
    refreshToken,
    csrfToken: randomToken(24),
  };
};

/**
 * Is the session behind an access token still alive?
 *
 * Rotation revokes the old refresh row and writes a new one under the same
 * family, so a live session always has exactly one unrevoked, unexpired row.
 * Revoking a session (logout, password change, reset, "sign out everywhere")
 * leaves none — which is what makes a stateless access token stop working.
 */
export const sessionIsLive = async (familyId: string): Promise<boolean> => {
  const live = await prisma.refreshToken.findFirst({
    where: { familyId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return live !== null;
};

export const login = async (email: string, password: string, req: Request) => {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, passwordHash: true, isActive: true, name: true },
  });

  // Same error for unknown email and wrong password — no account enumeration.
  if (!user?.passwordHash) throw unauthorized('Incorrect email or password');
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) throw unauthorized('Incorrect email or password');
  if (!user.isActive) throw forbidden('This account has been deactivated');

  const tokens = await issueTokens(user, req);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await logActivity({
    actorId: user.id,
    action: 'auth.login',
    entityType: 'USER',
    entityId: user.id,
    meta: { ip: req.ip },
  });

  return tokens;
};

/**
 * Rotating refresh. Presenting an already-used token means the cookie leaked,
 * so the whole rotation family is revoked and the user must sign in again.
 */
export const rotateRefreshToken = async (rawToken: string, req: Request) => {
  const tokenHash = sha256(rawToken);
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, email: true, isActive: true } } },
  });

  if (!existing) throw unauthorized('Your session has expired');

  if (existing.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: existing.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await logActivity({
      actorId: existing.userId,
      action: 'auth.refresh_reuse_detected',
      entityType: 'USER',
      entityId: existing.userId,
      meta: { ip: req.ip },
    });
    throw unauthorized('Your session has expired');
  }

  if (existing.expiresAt < new Date()) throw unauthorized('Your session has expired');
  if (!existing.user.isActive) throw forbidden('This account has been deactivated');

  const tokens = await issueTokens(existing.user, req, existing.familyId);

  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date(), replacedBy: sha256(tokens.refreshToken) },
  });

  return tokens;
};

export const revokeRefreshToken = async (rawToken: string | undefined) => {
  if (!rawToken) return;
  await prisma.refreshToken.updateMany({
    where: { tokenHash: sha256(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

export const revokeAllSessions = async (userId: string) => {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

export const changePassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string,
) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user?.passwordHash) throw badRequest('This account has no password set');
  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) throw badRequest('Your current password is incorrect');

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
  });
  await revokeAllSessions(userId);
  await logActivity({
    actorId: userId,
    action: 'auth.password_changed',
    entityType: 'USER',
    entityId: userId,
  });
};

type ResetPayload = { sub: string; fp: string; typ: 'pwreset' };

/**
 * Stateless, single-use reset token: it carries a fingerprint of the current
 * password hash, so the link stops working the moment the password changes.
 */
export const createPasswordResetToken = (userId: string, passwordHash: string | null) =>
  signScopedToken(
    { sub: userId, fp: sha256(passwordHash ?? 'unset').slice(0, 24), typ: 'pwreset' },
    '1h',
  );

export const resetPassword = async (token: string, password: string) => {
  const payload = verifyScopedToken<ResetPayload>(token);
  if (payload.typ !== 'pwreset') throw badRequest('This link is not valid');

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, passwordHash: true, isActive: true },
  });
  if (!user) throw badRequest('This link is not valid');
  if (!user.isActive) throw forbidden('This account has been deactivated');
  if (sha256(user.passwordHash ?? 'unset').slice(0, 24) !== payload.fp) {
    throw badRequest('This link has already been used');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(password), mustChangePassword: false },
  });
  await revokeAllSessions(user.id);
  await logActivity({
    actorId: user.id,
    action: 'auth.password_reset',
    entityType: 'USER',
    entityId: user.id,
  });
};

export const listSessions = async (userId: string, currentRawToken?: string) => {
  const sessions = await prisma.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, tokenHash: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
  });
  const currentHash = currentRawToken ? sha256(currentRawToken) : null;
  return sessions.map(({ tokenHash, ...rest }) => ({
    ...rest,
    isCurrent: tokenHash === currentHash,
  }));
};

export const revokeSession = async (userId: string, sessionId: string) => {
  const result = await prisma.refreshToken.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) throw badRequest('That session is no longer active');
};

/** Housekeeping: drop expired / long-revoked rows. */
export const pruneRefreshTokens = async () => {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const { count } = await prisma.refreshToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }] },
  });
  return count;
};
