import type { Request, Response } from 'express';
import { permissionGroups } from '../../config/permissions.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { q } from '../../middleware/validate.js';
import { logActivity } from '../../services/activity.js';

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

export const getCatalogue = (_req: Request, res: Response) => {
  res.json({ groups: permissionGroups() });
};

export const listRoles = async (req: Request, res: Response) => {
  const { scope } = q<{ scope?: 'GLOBAL' | 'PROJECT' }>(req);
  const roles = await prisma.role.findMany({
    where: scope ? { scope } : {},
    orderBy: [{ scope: 'asc' }, { isSystem: 'desc' }, { name: 'asc' }],
    include: {
      _count: { select: { users: true, projectMembers: true } },
    },
  });

  res.json({
    data: roles.map((role) => ({
      ...role,
      usageCount: role._count.users + role._count.projectMembers,
      _count: undefined,
    })),
  });
};

export const getRole = async (req: Request, res: Response) => {
  const role = await prisma.role.findUnique({
    where: { id: String(req.params.roleId) },
    include: {
      users: { select: { id: true, name: true, email: true, avatarUrl: true }, take: 50 },
      projectMembers: {
        select: {
          user: { select: { id: true, name: true, avatarUrl: true } },
          project: { select: { id: true, key: true, name: true } },
        },
        take: 100,
      },
    },
  });
  if (!role) throw notFound('Role not found');
  res.json({ data: role });
};

export const createRole = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as {
    name: string;
    description?: string | null;
    scope: 'GLOBAL' | 'PROJECT';
    permissions: string[];
  };

  let key = slugify(body.name);
  if (!key) throw badRequest('That name cannot be turned into a role key');
  if (await prisma.role.findUnique({ where: { key } })) key = `${key}-${Date.now().toString(36)}`;

  const role = await prisma.role.create({
    data: {
      key,
      name: body.name,
      description: body.description ?? null,
      scope: body.scope,
      permissions: body.permissions,
      isSystem: false,
    },
  });

  await logActivity({
    actorId: auth.id,
    action: 'role.created',
    entityType: 'ROLE',
    entityId: role.id,
    meta: { name: role.name, scope: role.scope, permissions: role.permissions.length },
  });

  res.status(201).json({ data: role });
};

export const updateRole = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const roleId = String(req.params.roleId);
  const existing = await prisma.role.findUnique({ where: { id: roleId } });
  if (!existing) throw notFound('Role not found');

  const body = req.body as {
    name?: string;
    description?: string | null;
    permissions?: string[];
    isDefault?: boolean;
  };

  // The administrator role must keep full access or the workspace can be locked out.
  if (existing.key === 'administrator' && body.permissions && !body.permissions.includes('*')) {
    throw badRequest('The Administrator role must keep full access');
  }

  const role = await prisma.$transaction(async (tx) => {
    if (body.isDefault) {
      await tx.role.updateMany({
        where: { scope: existing.scope, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.role.update({
      where: { id: roleId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
      },
    });
  });

  await logActivity({
    actorId: auth.id,
    action: 'role.updated',
    entityType: 'ROLE',
    entityId: role.id,
    meta: {
      name: role.name,
      ...(body.permissions
        ? {
            added: body.permissions.filter((p) => !existing.permissions.includes(p)),
            removed: existing.permissions.filter((p) => !body.permissions!.includes(p)),
          }
        : {}),
    },
  });

  res.json({ data: role });
};

export const deleteRole = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const roleId = String(req.params.roleId);
  const role = await prisma.role.findUnique({
    where: { id: roleId },
    include: { _count: { select: { users: true, projectMembers: true } } },
  });
  if (!role) throw notFound('Role not found');
  if (role.isSystem) throw badRequest('Built-in roles cannot be deleted. You can edit them instead.');

  const inUse = role._count.users + role._count.projectMembers;
  if (inUse > 0) {
    throw conflict(
      `${inUse} ${inUse === 1 ? 'person is' : 'people are'} still using this role. Move them to another role first.`,
    );
  }

  await prisma.role.delete({ where: { id: roleId } });
  await logActivity({
    actorId: auth.id,
    action: 'role.deleted',
    entityType: 'ROLE',
    entityId: roleId,
    meta: { name: role.name },
  });

  res.status(204).end();
};
