import { randomBytes } from 'node:crypto';
import { env } from '../src/config/env.js';
import { isValidPermission } from '../src/config/permissions.js';
import {
  DEFAULT_LABELS,
  DEFAULT_PHASES,
  DEFAULT_TASK_STATUSES,
} from '../src/config/projectDefaults.js';
import { ADMIN_ROLE_KEY, LATER_GRANTS, SYSTEM_ROLES } from '../src/config/systemRoles.js';
import { hashPassword } from '../src/lib/password.js';
import { prisma } from '../src/lib/prisma.js';

const log = (...args: unknown[]) => console.log('[seed]', ...args);

const seedRoles = async () => {
  for (const role of SYSTEM_ROLES) {
    const invalid = role.permissions.filter((p) => !isValidPermission(p));
    if (invalid.length) throw new Error(`Role ${role.key} has unknown permissions: ${invalid}`);

    await prisma.role.upsert({
      where: { key: role.key },
      // Permissions on existing system roles are left alone so admin edits stick.
      update: { name: role.name, description: role.description, scope: role.scope, isSystem: true },
      create: {
        key: role.key,
        name: role.name,
        description: role.description,
        scope: role.scope,
        permissions: role.permissions,
        isSystem: true,
        isDefault: role.isDefault ?? false,
      },
    });
  }
  // Permissions added in a later version never reach an existing workspace,
  // because the upsert above protects admin edits. Grant those explicitly.
  let granted = 0;
  for (const grant of LATER_GRANTS) {
    const role = await prisma.role.findUnique({
      where: { key: grant.roleKey },
      select: { id: true, permissions: true, grantedLater: true },
    });
    if (!role) continue;
    if (role.permissions.includes(grant.permission)) continue;
    if (role.grantedLater.includes(grant.permission)) continue;

    await prisma.role.update({
      where: { id: role.id },
      data: {
        permissions: { push: grant.permission },
        grantedLater: { push: grant.permission },
      },
    });
    granted += 1;
  }

  log(`${SYSTEM_ROLES.length} roles ready${granted ? `, ${granted} new permission(s) granted` : ''}`);
};

const seedAdmin = async () => {
  const email = (env.SEED_ADMIN_EMAIL ?? env.EMAIL_FROM_ADDRESS ?? 'admin@kiri.local').toLowerCase();
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: ADMIN_ROLE_KEY } });

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    log(`admin already exists: ${email}`);
    return existing;
  }

  const password = env.SEED_ADMIN_PASSWORD ?? `${randomBytes(9).toString('base64url')}A1`;
  const admin = await prisma.user.create({
    data: {
      email,
      name: env.SEED_ADMIN_NAME ?? 'Workspace Admin',
      passwordHash: await hashPassword(password),
      globalRoleId: adminRole.id,
      jobTitle: 'Administrator',
      mustChangePassword: !env.SEED_ADMIN_PASSWORD,
    },
  });

  log('─'.repeat(58));
  log(`Administrator created`);
  log(`  email:    ${email}`);
  log(`  password: ${password}`);
  if (!env.SEED_ADMIN_PASSWORD) log('  (you will be asked to change this on first sign-in)');
  log('─'.repeat(58));
  return admin;
};

const seedProjectScaffold = async (projectId: string) => {
  await prisma.taskStatus.createMany({
    data: DEFAULT_TASK_STATUSES.map((s, index) => ({ ...s, order: index, projectId })),
    skipDuplicates: true,
  });
  await prisma.projectPhase.createMany({
    data: DEFAULT_PHASES.map((p, index) => ({
      projectId,
      key: p.key,
      name: p.name,
      description: p.description,
      color: p.color,
      order: index,
      isProduction: p.isProduction ?? false,
    })),
    skipDuplicates: true,
  });
  await prisma.label.createMany({
    data: DEFAULT_LABELS.map((l) => ({ ...l, projectId })),
    skipDuplicates: true,
  });
};

const seedDemoProjects = async (adminId: string) => {
  const pmRole = await prisma.role.findUniqueOrThrow({ where: { key: 'project-manager' } });

  const projects = [
    {
      key: 'KIRI',
      name: 'Kiri Task Platform',
      description: 'The internal project and task management platform for the team.',
      color: '#6366f1',
    },
    {
      key: 'DRIVE',
      name: 'Kiri Drive',
      description: 'File storage and sharing product.',
      color: '#0ea5e9',
    },
  ];

  for (const p of projects) {
    const existing = await prisma.project.findUnique({ where: { key: p.key } });
    if (existing) {
      log(`project ${p.key} already exists`);
      continue;
    }
    const project = await prisma.project.create({
      data: {
        ...p,
        ownerId: adminId,
        createdById: adminId,
        status: 'ACTIVE',
        startDate: new Date(),
        members: { create: { userId: adminId, roleId: pmRole.id, responsibilities: 'Project owner' } },
      },
    });
    await seedProjectScaffold(project.id);
    log(`project ${p.key} created`);
  }
};

const main = async () => {
  await seedRoles();
  const admin = await seedAdmin();
  if (env.SEED_DEMO_DATA) await seedDemoProjects(admin.id);
  log('done');
};

main()
  .catch((error) => {
    console.error('[seed] failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
