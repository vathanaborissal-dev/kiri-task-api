import { env } from '../src/config/env.js';
import { DEFAULT_TASK_STATUSES } from '../src/config/projectDefaults.js';
import { hashPassword } from '../src/lib/password.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Seeds the workspace with the real team and the two live projects.
 *
 *   npm run db:seed:team
 *
 * Re-runnable: it deletes the ESHOP and ACS projects first, then rebuilds them.
 * People are upserted, so their passwords and any Telegram link survive.
 *
 * Addresses use the reserved `.test` TLD, which can never resolve — so nothing
 * here can ever send mail to a real inbox.
 */

const DEV_PASSWORD = 'KiriTask2026!';

const log = (...args: unknown[]) => console.log('[team]', ...args);

/** Job titles are the company ladder; app roles are about permissions. */
const PEOPLE = [
  {
    email: 'sem.chitra@kiri.test',
    name: 'Sem Chitra',
    jobTitle: 'Senior Software Engineer',
    responsibilities: 'Project lead for E-Shop and ACS Trade App. Owns scope, priorities and releases.',
    globalRoleKey: 'administrator',
    projectRoleKey: 'project-manager',
  },
  {
    email: 'boreth.boris@kiri.test',
    name: 'Boreth Boris',
    jobTitle: 'Senior Software Engineer',
    responsibilities: 'Technical lead. Architecture, code review and the Spring Boot services.',
    globalRoleKey: 'workspace-manager',
    projectRoleKey: 'team-lead',
  },
  {
    email: 'san.visal@kiri.test',
    name: 'San Visal',
    jobTitle: 'Programmer',
    responsibilities: 'Angular front ends — merchant portal and backoffice.',
    globalRoleKey: 'member',
    projectRoleKey: 'developer',
  },
  {
    email: (env.SEED_ADMIN_EMAIL ?? env.EMAIL_FROM_ADDRESS ?? 'hov.vathana@kiri.test').toLowerCase(),
    name: 'Hov Vathana',
    jobTitle: 'Programmer',
    responsibilities: 'Spring Boot services and the APIs the mobile team consumes.',
    globalRoleKey: 'administrator',
    projectRoleKey: 'developer',
  },
  {
    email: 'lionel.messi@kiri.test',
    name: 'Lionel Messi',
    jobTitle: 'Staff of Middleware',
    responsibilities: 'Kafka, Redis and service integration. OpenShift and Jenkins pipelines.',
    globalRoleKey: 'member',
    projectRoleKey: 'developer',
  },
  {
    email: 'chan.sophea@kiri.test',
    name: 'Chan Sophea',
    jobTitle: 'Head of Department',
    responsibilities:
      'Oversight across every project. Reads portfolio health, progress and reports; does not run the day-to-day.',
    globalRoleKey: 'head-of-department',
    projectRoleKey: 'viewer',
  },
] as const;

/** The company's four environments, with the GitLab split recorded. */
const PHASES = [
  {
    key: 'development',
    name: 'Development',
    description: 'Built and unit tested by the team. GitLab A.',
    color: '#3b82f6',
  },
  {
    key: 'uat',
    name: 'UAT',
    description: 'User acceptance testing with the business. GitLab A.',
    color: '#f59e0b',
  },
  {
    key: 'pilot',
    name: 'Pilot',
    description: 'Limited live release to real users. GitLab B.',
    color: '#8b5cf6',
  },
  {
    key: 'production',
    name: 'Production',
    description: 'Live for everyone. GitLab B.',
    color: '#22c55e',
    isProduction: true,
  },
];

const LABELS = [
  { name: 'angular', color: '#dd0031' },
  { name: 'spring-boot', color: '#6db33f' },
  { name: 'kafka', color: '#231f20' },
  { name: 'redis', color: '#d82c20' },
  { name: 'openshift', color: '#ee0000' },
  { name: 'jenkins', color: '#d24939' },
  { name: 'api', color: '#6366f1' },
  { name: 'backoffice', color: '#0ea5e9' },
  { name: 'database', color: '#fb923c' },
  { name: 'security', color: '#ef4444' },
  { name: 'performance', color: '#14b8a6' },
];

const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

/**
 * How long ago a seeded row was created. Everything used to land in the same
 * second, which made the activity feed read as a dozen "26 seconds ago" lines
 * and squeezed the throughput chart into a single week. Spread the backlog over
 * the last twelve weeks instead, oldest first, and skew by status: finished work
 * is older than work nobody has started.
 */
const spreadAge = (index: number, total: number, status?: string) => {
  const oldest = 84;
  const newest = 4;
  const base = oldest - (index / Math.max(total - 1, 1)) * (oldest - newest);
  const skew = status === 'done' ? 12 : status === 'todo' ? -3 : 0;
  return Math.max(2, Math.round(base + skew));
};

type Person = (typeof PEOPLE)[number];

const seedPeople = async () => {
  const roles = await prisma.role.findMany();
  const roleByKey = new Map(roles.map((role) => [role.key, role]));
  const passwordHash = await hashPassword(DEV_PASSWORD);
  const people = new Map<string, { id: string; name: string }>();

  for (const person of PEOPLE) {
    const globalRole = roleByKey.get(person.globalRoleKey);
    if (!globalRole) throw new Error(`Missing role ${person.globalRoleKey} — run db:seed first.`);

    const existing = await prisma.user.findUnique({ where: { email: person.email } });

    // Note the update branch sets no passwordHash: re-seeding must never
    // reset the password of somebody who already has an account, least of all
    // the administrator running the seed.
    const saved = await prisma.user.upsert({
      where: { email: person.email },
      update: {
        name: person.name,
        jobTitle: person.jobTitle,
        responsibilities: person.responsibilities,
        globalRoleId: globalRole.id,
        isActive: true,
      },
      create: {
        email: person.email,
        name: person.name,
        jobTitle: person.jobTitle,
        responsibilities: person.responsibilities,
        globalRoleId: globalRole.id,
        passwordHash,
        timezone: 'Asia/Phnom_Penh',
      },
    });

    people.set(person.email, saved);
    // Vathana signs in with whatever SEED_ADMIN_EMAIL says, but the work below
    // refers to him by the canonical address — register both keys.
    if (person.name === 'Hov Vathana') people.set('hov.vathana@kiri.test', saved);
    log(`${existing ? 'updated' : 'created'} ${person.name} <${person.email}>`);
  }

  return people;
};

const buildProject = async (
  spec: {
    key: string;
    name: string;
    description: string;
    color: string;
    startDate: Date;
    targetDate: Date | null;
  },
  people: Map<string, { id: string }>,
) => {
  // Tasks need a status and deployments need a phase, and Postgres gives no
  // ordering guarantee between the cascades that remove those — so the
  // dependants go first, the same way the API deletes a project.
  const existing = await prisma.project.findUnique({
    where: { key: spec.key },
    select: { id: true },
  });

  if (existing) {
    await prisma.$transaction(async (tx) => {
      await tx.deployment.deleteMany({ where: { release: { projectId: existing.id } } });
      await tx.task.deleteMany({ where: { projectId: existing.id } });
      await tx.project.delete({ where: { id: existing.id } });
    });
  }

  const lead = people.get('sem.chitra@kiri.test')!;

  const project = await prisma.project.create({
    data: {
      key: spec.key,
      name: spec.name,
      description: spec.description,
      color: spec.color,
      status: 'ACTIVE',
      startDate: spec.startDate,
      targetDate: spec.targetDate,
      ownerId: lead.id,
      createdById: lead.id,
    },
  });

  await prisma.taskStatus.createMany({
    data: DEFAULT_TASK_STATUSES.map((status, order) => ({
      projectId: project.id,
      key: status.key,
      name: status.name,
      category: status.category,
      color: status.color,
      order,
      isDefault: status.isDefault ?? false,
    })),
  });

  await prisma.projectPhase.createMany({
    data: PHASES.map((phase, order) => ({
      projectId: project.id,
      key: phase.key,
      name: phase.name,
      description: phase.description,
      color: phase.color,
      order,
      isProduction: phase.isProduction ?? false,
    })),
  });

  await prisma.label.createMany({
    data: LABELS.map((label) => ({ ...label, projectId: project.id })),
  });

  const roles = await prisma.role.findMany({ where: { scope: 'PROJECT' } });
  const roleByKey = new Map(roles.map((role) => [role.key, role.id]));

  await prisma.projectMember.createMany({
    data: PEOPLE.map((person) => ({
      projectId: project.id,
      userId: people.get(person.email)!.id,
      roleId: roleByKey.get(person.projectRoleKey)!,
      responsibilities: person.responsibilities,
    })),
  });

  const [statuses, phases, labels] = await Promise.all([
    prisma.taskStatus.findMany({ where: { projectId: project.id } }),
    prisma.projectPhase.findMany({ where: { projectId: project.id } }),
    prisma.label.findMany({ where: { projectId: project.id } }),
  ]);

  return {
    project,
    status: (key: string) => statuses.find((s) => s.key === key)!.id,
    phase: (key: string) => phases.find((p) => p.key === key)!.id,
    label: (name: string) => labels.find((l) => l.name === name)!.id,
  };
};

export { PEOPLE, DEV_PASSWORD, days, seedPeople, buildProject, log };

// ---------------------------------------------------------------------------
// The work itself
// ---------------------------------------------------------------------------

type TaskSpec = {
  title: string;
  description?: string;
  type?: 'TASK' | 'FEATURE' | 'BUG' | 'IMPROVEMENT' | 'CHORE' | 'HOTFIX';
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: string;
  phase?: string;
  qa?: 'NOT_REQUIRED' | 'PENDING' | 'IN_TESTING' | 'PASSED' | 'FAILED';
  assignees?: string[];
  labels?: string[];
  due?: number;
  estimate?: number;
  spent?: number;
  checklist?: string[];
  /** Milestone name, as declared in MILESTONES below. */
  milestone?: string;
};

const ESHOP_TASKS: TaskSpec[] = [
  {
    title: 'Merchant bulk product upload (CSV)',
    milestone: 'SME menu fully in production',
    description:
      'Merchants with large catalogues cannot add products one at a time. Accept a CSV, validate it row by row and report the failures back with line numbers.',
    type: 'FEATURE',
    priority: 'HIGH',
    status: 'in-progress',
    phase: 'development',
    qa: 'PENDING',
    assignees: ['san.visal@kiri.test'],
    labels: ['angular', 'spring-boot'],
    due: 6,
    estimate: 24,
    spent: 11,
    checklist: ['CSV template and column spec', 'Row validation service', 'Error report screen', 'Upload progress'],
  },
  {
    title: 'Settlement report export for merchants',
    milestone: 'SME menu fully in production',
    description: 'Daily and monthly settlement, exportable to Excel. Finance asked for the same columns the core banking report uses.',
    type: 'FEATURE',
    priority: 'MEDIUM',
    status: 'in-review',
    phase: 'uat',
    qa: 'IN_TESTING',
    assignees: ['san.visal@kiri.test', 'boreth.boris@kiri.test'],
    labels: ['angular', 'backoffice'],
    due: 3,
    estimate: 16,
    spent: 15,
  },
  {
    title: 'Order refund flow end to end',
    milestone: 'SME menu fully in production',
    description: 'Partial and full refunds, with the reversal posted back to the core banking account. Needs an approval step in backoffice.',
    type: 'FEATURE',
    priority: 'CRITICAL',
    status: 'in-progress',
    phase: 'development',
    qa: 'PENDING',
    assignees: ['hov.vathana@kiri.test'],
    labels: ['spring-boot', 'api', 'security'],
    due: 9,
    estimate: 32,
    spent: 18,
    checklist: ['Refund API', 'Approval in backoffice', 'Core banking reversal', 'Reconciliation report'],
  },
  {
    title: 'SME merchant onboarding approval queue',
    milestone: 'SME menu fully in production',
    description: 'Backoffice reviewers approve or reject SME merchant applications, with the reason returned to the applicant.',
    type: 'FEATURE',
    priority: 'HIGH',
    status: 'done',
    phase: 'production',
    qa: 'PASSED',
    assignees: ['san.visal@kiri.test'],
    labels: ['backoffice', 'angular'],
    estimate: 20,
    spent: 22,
  },
  {
    title: 'POS offline sync queue',
    milestone: 'POS phase 2',
    description:
      'The POS terminal has to keep taking payments when the network drops, then replay them in order once it is back. Kafka handles the replay.',
    type: 'FEATURE',
    priority: 'CRITICAL',
    status: 'in-progress',
    phase: 'development',
    qa: 'PENDING',
    assignees: ['lionel.messi@kiri.test', 'hov.vathana@kiri.test'],
    labels: ['kafka', 'spring-boot', 'performance'],
    due: 12,
    estimate: 40,
    spent: 9,
    checklist: ['Local queue on the terminal', 'Idempotent replay endpoint', 'Conflict rules', 'Load test at 500 tx/min'],
  },
  {
    title: 'POS receipt printing for the new terminal model',
    milestone: 'POS phase 2',
    type: 'TASK',
    priority: 'MEDIUM',
    status: 'todo',
    phase: 'development',
    assignees: ['lionel.messi@kiri.test'],
    labels: ['api'],
    due: 14,
    estimate: 8,
  },
  {
    title: 'QR payment acceptance at POS',
    milestone: 'POS phase 2',
    description: 'KHQR acceptance, with the callback confirming settlement before the receipt prints.',
    type: 'FEATURE',
    priority: 'HIGH',
    status: 'done',
    phase: 'production',
    qa: 'PASSED',
    assignees: ['hov.vathana@kiri.test'],
    labels: ['api', 'spring-boot'],
    estimate: 24,
    spent: 26,
  },
  {
    title: 'Checkout API for the mobile team',
    description: 'Cart, address, payment method and confirm. Versioned under /v2 so the current app keeps working.',
    type: 'FEATURE',
    priority: 'HIGH',
    status: 'in-review',
    phase: 'uat',
    qa: 'IN_TESTING',
    assignees: ['hov.vathana@kiri.test'],
    labels: ['api', 'spring-boot'],
    due: 4,
    estimate: 28,
    spent: 25,
  },
  {
    title: 'Order tracking API',
    type: 'FEATURE',
    priority: 'MEDIUM',
    status: 'todo',
    phase: 'development',
    assignees: ['hov.vathana@kiri.test'],
    labels: ['api'],
    due: 18,
    estimate: 12,
  },
  {
    title: 'Redis cache for the product catalogue',
    description: 'Category and product listings are read far more than they are written. Cache them and invalidate on publish.',
    type: 'IMPROVEMENT',
    priority: 'MEDIUM',
    status: 'in-progress',
    phase: 'development',
    assignees: ['lionel.messi@kiri.test'],
    labels: ['redis', 'performance'],
    due: 10,
    estimate: 10,
    spent: 4,
  },
  {
    title: 'Move the merchant portal build to the new Jenkins agent',
    type: 'CHORE',
    priority: 'LOW',
    status: 'backlog',
    assignees: ['lionel.messi@kiri.test'],
    labels: ['jenkins', 'openshift'],
    estimate: 6,
  },
  {
    title: 'Commission configuration per merchant category',
    milestone: 'SME menu fully in production',
    type: 'FEATURE',
    priority: 'MEDIUM',
    status: 'blocked',
    phase: 'development',
    assignees: ['san.visal@kiri.test'],
    labels: ['backoffice'],
    due: -2,
    estimate: 14,
    spent: 6,
    description: 'Blocked: finance has not confirmed the rate card for the new SME tiers.',
  },
];

const ACS_TASKS: TaskSpec[] = [
  {
    title: 'CSX order placement integration',
    milestone: 'Pilot sign-off',
    description:
      'Place, amend and cancel orders against the CSX gateway. Every message is logged for the audit trail the regulator asks for.',
    type: 'FEATURE',
    priority: 'CRITICAL',
    status: 'done',
    phase: 'pilot',
    qa: 'PASSED',
    assignees: ['boreth.boris@kiri.test', 'hov.vathana@kiri.test'],
    labels: ['spring-boot', 'api', 'security'],
    estimate: 60,
    spent: 68,
  },
  {
    title: 'Market data feed from CSX',
    milestone: 'Pilot sign-off',
    description: 'Real-time prices fanned out over Kafka to the API and the backoffice dashboard.',
    type: 'FEATURE',
    priority: 'CRITICAL',
    status: 'done',
    phase: 'pilot',
    qa: 'PASSED',
    assignees: ['lionel.messi@kiri.test'],
    labels: ['kafka', 'redis', 'performance'],
    estimate: 40,
    spent: 44,
  },
  {
    title: 'Trade confirmation and contract note',
    milestone: 'Pilot sign-off',
    description: 'Generate the contract note after settlement and make it available through the API.',
    type: 'FEATURE',
    priority: 'HIGH',
    status: 'in-review',
    phase: 'uat',
    qa: 'IN_TESTING',
    assignees: ['hov.vathana@kiri.test'],
    labels: ['spring-boot', 'api'],
    due: 5,
    estimate: 20,
    spent: 17,
  },
  {
    title: 'Client account opening in backoffice',
    milestone: 'Pilot sign-off',
    description: 'KYC capture, document upload and the approval chain before a trading account goes live.',
    type: 'FEATURE',
    priority: 'HIGH',
    status: 'in-progress',
    phase: 'development',
    qa: 'PENDING',
    assignees: ['san.visal@kiri.test'],
    labels: ['backoffice', 'angular', 'security'],
    due: 8,
    estimate: 36,
    spent: 20,
    checklist: ['KYC form', 'Document upload to storage', 'Maker-checker approval', 'Account activation'],
  },
  {
    title: 'Margin monitoring and alerts',
    milestone: 'Public launch',
    type: 'FEATURE',
    priority: 'HIGH',
    status: 'todo',
    phase: 'development',
    assignees: ['boreth.boris@kiri.test'],
    labels: ['spring-boot', 'kafka'],
    due: 20,
    estimate: 30,
  },
  {
    title: 'Portfolio and watchlist API',
    type: 'FEATURE',
    priority: 'MEDIUM',
    status: 'in-review',
    phase: 'uat',
    qa: 'PASSED',
    assignees: ['hov.vathana@kiri.test'],
    labels: ['api'],
    due: 2,
    estimate: 16,
    spent: 16,
  },
  {
    title: 'Order book API for the mobile team',
    type: 'FEATURE',
    priority: 'MEDIUM',
    status: 'in-progress',
    phase: 'development',
    assignees: ['hov.vathana@kiri.test'],
    labels: ['api', 'redis'],
    due: 11,
    estimate: 18,
    spent: 7,
  },
  {
    title: 'Broker commission calculation',
    milestone: 'Public launch',
    type: 'FEATURE',
    priority: 'MEDIUM',
    status: 'todo',
    phase: 'development',
    assignees: ['san.visal@kiri.test'],
    labels: ['backoffice', 'database'],
    due: 16,
    estimate: 22,
  },
  {
    title: 'Split the pipeline so Pilot deploys from GitLab B',
    milestone: 'Pilot sign-off',
    description:
      'Dev and UAT stay on GitLab A. Pilot and Production build from GitLab B, with the image promoted through Quay rather than rebuilt.',
    type: 'CHORE',
    priority: 'HIGH',
    status: 'done',
    phase: 'pilot',
    qa: 'NOT_REQUIRED',
    assignees: ['lionel.messi@kiri.test'],
    labels: ['jenkins', 'openshift'],
    estimate: 16,
    spent: 19,
  },
  {
    title: 'Pilot feedback: order screen loads slowly on 3G',
    milestone: 'Pilot sign-off',
    type: 'IMPROVEMENT',
    priority: 'HIGH',
    status: 'in-progress',
    phase: 'pilot',
    qa: 'PENDING',
    assignees: ['hov.vathana@kiri.test', 'lionel.messi@kiri.test'],
    labels: ['performance', 'api'],
    due: 4,
    estimate: 12,
    spent: 5,
  },
];

const createTasks = async (
  ctx: Awaited<ReturnType<typeof buildProject>>,
  specs: TaskSpec[],
  people: Map<string, { id: string }>,
  reporterEmail: string,
  milestones: Map<string, string>,
) => {
  const created: { id: string; key: string; title: string }[] = [];

  for (const [index, spec] of specs.entries()) {
    const age = spreadAge(index, specs.length, spec.status);
    const createdAt = days(-age);
    // Done somewhere in the last third of its life, never before it existed.
    const completedAt = days(-Math.max(1, Math.round(age * 0.3)));
    const next = await prisma.project.update({
      where: { id: ctx.project.id },
      data: { taskCounter: { increment: 1 } },
      select: { key: true, taskCounter: true },
    });

    const task = await prisma.task.create({
      data: {
        key: `${next.key}-${next.taskCounter}`,
        projectId: ctx.project.id,
        title: spec.title,
        description: spec.description ?? null,
        type: spec.type ?? 'TASK',
        priority: spec.priority ?? 'MEDIUM',
        statusId: ctx.status(spec.status),
        phaseId: spec.phase ? ctx.phase(spec.phase) : null,
        qaStatus: spec.qa ?? 'NOT_REQUIRED',
        reporterId: people.get(reporterEmail)!.id,
        milestoneId: spec.milestone ? (milestones.get(spec.milestone) ?? null) : null,
        dueDate: spec.due === undefined ? null : days(spec.due),
        startDate: spec.spent ? days(-Math.max(1, Math.round(age * 0.8))) : null,
        completedAt: spec.status === 'done' ? completedAt : null,
        createdAt,
        updatedAt: spec.status === 'done' ? completedAt : days(-Math.max(1, Math.round(age / 2))),
        estimateHours: spec.estimate ?? null,
        spentHours: spec.spent ?? null,
        position: created.length * 1000,
        assignees: {
          create: (spec.assignees ?? []).map((email) => ({ userId: people.get(email)!.id })),
        },
        labels: { create: (spec.labels ?? []).map((name) => ({ labelId: ctx.label(name) })) },
        checklist: {
          create: (spec.checklist ?? []).map((title, order) => ({
            title,
            order,
            isDone: order === 0 && spec.status !== 'todo',
            completedAt:
              order === 0 && spec.status !== 'todo'
                ? days(-Math.max(1, Math.round(age * 0.6)))
                : null,
          })),
        },
        watchers: { create: { userId: people.get(reporterEmail)!.id } },
      },
      select: { id: true, key: true, title: true },
    });

    await prisma.activityLog.create({
      data: {
        actorId: people.get(reporterEmail)!.id,
        action: 'task.created',
        entityType: 'TASK',
        entityId: task.id,
        projectId: ctx.project.id,
        taskId: task.id,
        meta: { key: task.key, title: task.title },
        createdAt,
      },
    });

    created.push(task);
  }

  return created;
};

type IssueSpec = {
  title: string;
  description?: string;
  steps?: string;
  expected?: string;
  actual?: string;
  severity: 'MINOR' | 'MAJOR' | 'CRITICAL' | 'BLOCKER';
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status:
    | 'OPEN'
    | 'ASSIGNED'
    | 'IN_PROGRESS'
    | 'READY_FOR_TESTING'
    | 'RESOLVED'
    | 'CLOSED'
    | 'REOPENED';
  phase: string;
  reporter: string;
  assignee?: string;
  due?: number;
};

const ESHOP_ISSUES: IssueSpec[] = [
  {
    title: 'Payment callback times out during the evening peak',
    description:
      'Between 19:00 and 21:00 a share of callbacks exceed the 30s timeout. The order is paid but stays Pending until the reconciliation job catches it.',
    steps: '1. Place an order around 19:30\n2. Pay with the bank app\n3. Watch the order status',
    expected: 'The order moves to Paid within a few seconds',
    actual: 'It stays Pending for up to 15 minutes',
    severity: 'CRITICAL',
    priority: 'CRITICAL',
    status: 'IN_PROGRESS',
    phase: 'production',
    reporter: 'sem.chitra@kiri.test',
    assignee: 'hov.vathana@kiri.test',
    due: 2,
  },
  {
    title: 'Duplicate settlement row for refunded orders',
    description: 'A refunded order appears twice in the daily settlement export — once as a sale and once as a reversal with the same reference.',
    severity: 'MAJOR',
    priority: 'HIGH',
    status: 'ASSIGNED',
    phase: 'production',
    reporter: 'boreth.boris@kiri.test',
    assignee: 'san.visal@kiri.test',
    due: 7,
  },
  {
    title: 'POS printer driver fails on the new terminal firmware',
    steps: '1. Update the terminal to firmware 2.3\n2. Complete a sale\n3. The receipt does not print',
    severity: 'MAJOR',
    priority: 'HIGH',
    status: 'OPEN',
    phase: 'pilot',
    reporter: 'lionel.messi@kiri.test',
  },
  {
    title: 'Product images lose their aspect ratio in the merchant portal',
    severity: 'MINOR',
    priority: 'LOW',
    status: 'OPEN',
    phase: 'uat',
    reporter: 'san.visal@kiri.test',
  },
  {
    title: 'Merchant cannot upload a logo larger than 1 MB',
    severity: 'MINOR',
    status: 'RESOLVED',
    phase: 'production',
    reporter: 'sem.chitra@kiri.test',
    assignee: 'san.visal@kiri.test',
  },
];

const ACS_ISSUES: IssueSpec[] = [
  {
    title: 'Order rejected by CSX when the symbol has a trailing space',
    description: 'The gateway returns INVALID_SYMBOL. The mobile app is sending the symbol untrimmed; we should trim defensively on our side too.',
    severity: 'MAJOR',
    priority: 'HIGH',
    status: 'READY_FOR_TESTING',
    phase: 'pilot',
    reporter: 'boreth.boris@kiri.test',
    assignee: 'hov.vathana@kiri.test',
    due: 3,
  },
  {
    title: 'Market data stops updating after a CSX session restart',
    description: 'When CSX restarts the session mid-day our consumer keeps the old connection and silently stops receiving ticks. It needs a heartbeat and a reconnect.',
    steps: '1. Wait for the CSX midday session break\n2. Watch the price on the dashboard',
    expected: 'Prices resume when the session reopens',
    actual: 'Prices stay frozen until the service is restarted',
    severity: 'BLOCKER',
    priority: 'CRITICAL',
    status: 'IN_PROGRESS',
    phase: 'pilot',
    reporter: 'sem.chitra@kiri.test',
    assignee: 'lionel.messi@kiri.test',
    due: 1,
  },
  {
    title: 'Pilot user reports the portfolio total is off by the unsettled amount',
    severity: 'MAJOR',
    priority: 'HIGH',
    status: 'ASSIGNED',
    phase: 'pilot',
    reporter: 'sem.chitra@kiri.test',
    assignee: 'boreth.boris@kiri.test',
    due: 5,
  },
  {
    title: 'Backoffice session expires while a long KYC form is being filled in',
    severity: 'MINOR',
    priority: 'MEDIUM',
    status: 'OPEN',
    phase: 'uat',
    reporter: 'san.visal@kiri.test',
  },
];

const createIssues = async (
  ctx: Awaited<ReturnType<typeof buildProject>>,
  specs: IssueSpec[],
  people: Map<string, { id: string }>,
) => {
  const created: { id: string; key: string; title: string }[] = [];

  for (const [index, spec] of specs.entries()) {
    // Reported over the last few weeks, not all at once, and the same on every
    // run — Math.random() here made two seedings impossible to compare.
    const age = Math.max(2, Math.round(spreadAge(index, specs.length) / 3));
    const createdAt = days(-age);
    const next = await prisma.project.update({
      where: { id: ctx.project.id },
      data: { issueCounter: { increment: 1 } },
      select: { key: true, issueCounter: true },
    });

    const issue = await prisma.issue.create({
      data: {
        key: `${next.key}-I${next.issueCounter}`,
        projectId: ctx.project.id,
        title: spec.title,
        description: spec.description ?? null,
        stepsToReproduce: spec.steps ?? null,
        expectedResult: spec.expected ?? null,
        actualResult: spec.actual ?? null,
        severity: spec.severity,
        priority: spec.priority ?? 'MEDIUM',
        status: spec.status,
        phaseId: ctx.phase(spec.phase),
        reporterId: people.get(spec.reporter)!.id,
        assigneeId: spec.assignee ? people.get(spec.assignee)!.id : null,
        dueDate: spec.due === undefined ? null : days(spec.due),
        resolvedAt: spec.status === 'RESOLVED' ? days(-Math.max(1, Math.round(age / 3))) : null,
        createdAt,
        updatedAt: days(-Math.max(1, Math.round(age / 2))),
        watchers: { create: { userId: people.get(spec.reporter)!.id } },
      },
      select: { id: true, key: true, title: true },
    });

    await prisma.activityLog.create({
      data: {
        actorId: people.get(spec.reporter)!.id,
        action: 'issue.reported',
        entityType: 'ISSUE',
        entityId: issue.id,
        projectId: ctx.project.id,
        issueId: issue.id,
        meta: { key: issue.key, title: issue.title, severity: spec.severity },
        createdAt,
      },
    });

    created.push(issue);
  }

  return created;
};

/**
 * Work that already shipped. Kept in its own list so the backlogs above stay
 * about what the team is doing now, then interleaved into them — a project that
 * has been live for a year should have a throughput chart with history in it,
 * not two bars.
 */
const ESHOP_SHIPPED: TaskSpec[] = [
  {
    title: 'Merchant login, session and device binding',
    description: 'Shared session with the bank app, with the device bound on first sign-in.',
    type: 'FEATURE',
    priority: 'HIGH',
    status: 'done',
    phase: 'production',
    qa: 'PASSED',
    assignees: ['boreth.boris@kiri.test'],
    labels: ['security', 'spring-boot'],
    estimate: 24,
    spent: 27,
    milestone: 'SME menu fully in production',
  },
  {
    title: 'Product catalogue CRUD in the merchant portal',
    type: 'FEATURE',
    priority: 'MEDIUM',
    status: 'done',
    phase: 'production',
    qa: 'PASSED',
    assignees: ['san.visal@kiri.test'],
    labels: ['angular', 'backoffice'],
    estimate: 32,
    spent: 30,
    milestone: 'SME menu fully in production',
  },
  {
    title: 'Order placement API for the bank app',
    type: 'FEATURE',
    priority: 'CRITICAL',
    status: 'done',
    phase: 'production',
    qa: 'PASSED',
    assignees: ['hov.vathana@kiri.test'],
    labels: ['api', 'spring-boot'],
    estimate: 28,
    spent: 34,
    milestone: 'SME menu fully in production',
  },
  {
    title: 'Nightly settlement batch and the merchant statement',
    type: 'FEATURE',
    priority: 'HIGH',
    status: 'done',
    phase: 'production',
    qa: 'PASSED',
    assignees: ['boreth.boris@kiri.test', 'hov.vathana@kiri.test'],
    labels: ['spring-boot', 'database'],
    estimate: 40,
    spent: 44,
  },
  {
    title: 'Backoffice user and role management',
    type: 'FEATURE',
    priority: 'MEDIUM',
    status: 'done',
    phase: 'production',
    qa: 'PASSED',
    assignees: ['san.visal@kiri.test'],
    labels: ['angular', 'security'],
    estimate: 20,
    spent: 18,
  },
  {
    title: 'POS terminal registration and key exchange',
    type: 'FEATURE',
    priority: 'HIGH',
    status: 'done',
    phase: 'pilot',
    qa: 'PASSED',
    assignees: ['lionel.messi@kiri.test'],
    labels: ['security', 'api'],
    estimate: 26,
    spent: 29,
    milestone: 'POS phase 2',
  },
  {
    title: 'Merchant KYC document upload',
    type: 'FEATURE',
    priority: 'MEDIUM',
    status: 'done',
    phase: 'uat',
    qa: 'PASSED',
    assignees: ['san.visal@kiri.test'],
    labels: ['angular', 'api'],
    estimate: 14,
    spent: 16,
    milestone: 'SME menu fully in production',
  },
  {
    title: 'Kafka topic for order events, with a dead-letter queue',
    type: 'CHORE',
    priority: 'HIGH',
    status: 'done',
    phase: 'production',
    qa: 'NOT_REQUIRED',
    assignees: ['lionel.messi@kiri.test'],
    labels: ['kafka', 'openshift'],
    estimate: 18,
    spent: 21,
  },
];

const ACS_SHIPPED: TaskSpec[] = [
  {
    title: 'CSX session login and heartbeat',
    description: 'Hold the CSX session open and re-authenticate before it lapses.',
    type: 'FEATURE',
    priority: 'CRITICAL',
    status: 'done',
    phase: 'pilot',
    qa: 'PASSED',
    assignees: ['lionel.messi@kiri.test'],
    labels: ['api', 'spring-boot'],
    estimate: 22,
    spent: 26,
    milestone: 'Pilot sign-off',
  },
  {
    title: 'Instrument master sync from CSX',
    type: 'FEATURE',
    priority: 'HIGH',
    status: 'done',
    phase: 'pilot',
    qa: 'PASSED',
    assignees: ['hov.vathana@kiri.test'],
    labels: ['database', 'spring-boot'],
    estimate: 16,
    spent: 15,
    milestone: 'Pilot sign-off',
  },
  {
    title: 'Backoffice authentication and maker-checker',
    type: 'FEATURE',
    priority: 'HIGH',
    status: 'done',
    phase: 'uat',
    qa: 'PASSED',
    assignees: ['boreth.boris@kiri.test'],
    labels: ['security', 'backoffice'],
    estimate: 30,
    spent: 33,
    milestone: 'Pilot sign-off',
  },
  {
    title: 'Cash and stock balance enquiry API',
    type: 'FEATURE',
    priority: 'MEDIUM',
    status: 'done',
    phase: 'pilot',
    qa: 'PASSED',
    assignees: ['hov.vathana@kiri.test'],
    labels: ['api', 'redis'],
    estimate: 18,
    spent: 17,
    milestone: 'Pilot sign-off',
  },
  {
    title: 'Audit trail for every order action',
    type: 'CHORE',
    priority: 'HIGH',
    status: 'done',
    phase: 'uat',
    qa: 'PASSED',
    assignees: ['san.visal@kiri.test'],
    labels: ['database', 'security'],
    estimate: 12,
    spent: 14,
  },
];

/** Spread the finished work evenly through the live backlog. */
const withHistory = (current: TaskSpec[], shipped: TaskSpec[]) => {
  const merged: TaskSpec[] = [];
  const every = Math.max(1, Math.round(current.length / (shipped.length + 1)));
  let next = 0;

  for (const [index, spec] of current.entries()) {
    if (next < shipped.length && index % every === 0) merged.push(shipped[next++]!);
    merged.push(spec);
  }
  while (next < shipped.length) merged.push(shipped[next++]!);

  return merged;
};

type MilestoneSpec = { name: string; description?: string; due: number };

const ESHOP_MILESTONES: MilestoneSpec[] = [
  {
    name: 'SME menu fully in production',
    description: 'Every SME merchant screen live, not just onboarding and settlement.',
    due: 45,
  },
  {
    name: 'POS phase 2',
    description: 'Offline sync, QR acceptance and the new terminal model.',
    due: 110,
  },
];

const ACS_MILESTONES: MilestoneSpec[] = [
  {
    name: 'Pilot sign-off',
    description: 'Close every blocker raised by pilot users and get the business sign-off.',
    due: 30,
  },
  { name: 'Public launch', due: 85 },
];

/**
 * Milestones come before tasks so a task can point at one. A milestone with no
 * tasks is a legitimate state — Public launch has nothing scoped yet — and the
 * report view says so rather than drawing an empty 0/0 bar.
 */
const createMilestones = async (
  ctx: Awaited<ReturnType<typeof buildProject>>,
  specs: MilestoneSpec[],
) => {
  const byName = new Map<string, string>();

  for (const [order, spec] of specs.entries()) {
    const milestone = await prisma.milestone.create({
      data: {
        projectId: ctx.project.id,
        name: spec.name,
        description: spec.description ?? null,
        dueDate: days(spec.due),
        order,
      },
      select: { id: true },
    });
    byName.set(spec.name, milestone.id);
  }

  return byName;
};

// ---------------------------------------------------------------------------

const main = async () => {
  const people = await seedPeople();

  // --- E-Shop --------------------------------------------------------------
  const eshop = await buildProject(
    {
      key: 'ESHOP',
      name: 'E-Shop',
      description:
        'E-commerce inside the bank app, plus the POS terminals. We build the merchant portal, the backoffice portal and the services behind both. The mobile app belongs to another team — we provide the APIs. Parts of the SME and POS menus are already live in production.',
      color: '#6366f1',
      startDate: days(-540),
      targetDate: days(120),
    },
    people,
  );

  const eshopMilestones = await createMilestones(eshop, ESHOP_MILESTONES);
  const eshopTasks = await createTasks(
    eshop,
    withHistory(ESHOP_TASKS, ESHOP_SHIPPED),
    people,
    'sem.chitra@kiri.test',
    eshopMilestones,
  );
  const eshopIssues = await createIssues(eshop, ESHOP_ISSUES, people);
  log(`E-Shop: ${eshopTasks.length} tasks, ${eshopIssues.length} issues`);

  // --- ACS Trade App -------------------------------------------------------
  const acs = await buildProject(
    {
      key: 'ACS',
      name: 'ACS Trade App',
      description:
        'Acleda Securities trade app for the Cambodian stock market, integrated with CSX. We build the backoffice and the APIs; the mobile app belongs to another team. Recently entered Pilot. Development and UAT build from GitLab A, Pilot and Production from GitLab B.',
      color: '#0ea5e9',
      startDate: days(-300),
      targetDate: days(90),
    },
    people,
  );

  const acsMilestones = await createMilestones(acs, ACS_MILESTONES);
  const acsTasks = await createTasks(
    acs,
    withHistory(ACS_TASKS, ACS_SHIPPED),
    people,
    'sem.chitra@kiri.test',
    acsMilestones,
  );
  const acsIssues = await createIssues(acs, ACS_ISSUES, people);
  log(`ACS Trade App: ${acsTasks.length} tasks, ${acsIssues.length} issues`);

  // --- Releases and deployments -------------------------------------------
  const lead = people.get('sem.chitra@kiri.test')!;
  const middleware = people.get('lionel.messi@kiri.test')!;

  const eshopLive = await prisma.release.create({
    data: {
      projectId: eshop.project.id,
      version: '2.4.0',
      name: 'SME onboarding and QR at POS',
      releaseNotes:
        '- SME merchant onboarding approval queue in backoffice\n- KHQR acceptance at POS\n- Settlement export column fixes',
      status: 'RELEASED',
      phaseId: eshop.phase('production'),
      plannedDate: days(-20),
      releasedAt: days(-18),
      createdById: lead.id,
    },
  });

  const eshopNext = await prisma.release.create({
    data: {
      projectId: eshop.project.id,
      version: '2.5.0',
      name: 'Refunds and bulk upload',
      releaseNotes: '- Full and partial refunds with backoffice approval\n- Merchant bulk product upload\n- Catalogue caching',
      status: 'IN_DEVELOPMENT',
      phaseId: eshop.phase('uat'),
      plannedDate: days(21),
      createdById: lead.id,
    },
  });

  const acsPilot = await prisma.release.create({
    data: {
      projectId: acs.project.id,
      version: '1.0.0',
      name: 'Pilot release',
      releaseNotes:
        '- CSX order placement, amend and cancel\n- Real-time market data\n- Portfolio and watchlist APIs\n- Backoffice client management',
      status: 'RELEASED',
      phaseId: acs.phase('pilot'),
      plannedDate: days(-12),
      releasedAt: days(-9),
      isHotfix: false,
      createdById: lead.id,
    },
  });

  await prisma.deployment.createMany({
    data: [
      { releaseId: eshopLive.id, phaseId: eshop.phase('uat'), deployedById: middleware.id, deployedAt: days(-26), notes: 'UAT build from GitLab A.', status: 'SUCCEEDED' },
      { releaseId: eshopLive.id, phaseId: eshop.phase('pilot'), deployedById: middleware.id, deployedAt: days(-22), notes: 'Pilot with three merchants.', status: 'SUCCEEDED' },
      { releaseId: eshopLive.id, phaseId: eshop.phase('production'), deployedById: middleware.id, deployedAt: days(-18), notes: 'Released after the Friday change window.', status: 'SUCCEEDED' },
      { releaseId: eshopNext.id, phaseId: eshop.phase('uat'), deployedById: middleware.id, deployedAt: days(-2), notes: 'First UAT drop for business testing.', status: 'SUCCEEDED' },
      { releaseId: acsPilot.id, phaseId: acs.phase('uat'), deployedById: middleware.id, deployedAt: days(-16), notes: 'GitLab A build.', status: 'SUCCEEDED' },
      { releaseId: acsPilot.id, phaseId: acs.phase('pilot'), deployedById: middleware.id, deployedAt: days(-9), notes: 'Promoted the Quay image to GitLab B pipeline.', status: 'SUCCEEDED' },
    ],
  });

  // Tie finished work to the release that shipped it.
  const shipped = eshopTasks.filter((task) =>
    ['SME merchant onboarding approval queue', 'QR payment acceptance at POS'].includes(task.title),
  );
  await prisma.task.updateMany({
    where: { id: { in: shipped.map((t) => t.id) } },
    data: { releaseId: eshopLive.id },
  });

  const inUat = eshopTasks.filter((task) =>
    ['Settlement report export for merchants', 'Checkout API for the mobile team', 'Order refund flow end to end', 'Merchant bulk product upload (CSV)'].includes(
      task.title,
    ),
  );
  await prisma.task.updateMany({
    where: { id: { in: inUat.map((t) => t.id) } },
    data: { releaseId: eshopNext.id },
  });

  await prisma.task.updateMany({
    where: {
      id: {
        in: acsTasks
          .filter((task) =>
            ['CSX order placement integration', 'Market data feed from CSX', 'Split the pipeline so Pilot deploys from GitLab B'].includes(task.title),
          )
          .map((t) => t.id),
      },
    },
    data: { releaseId: acsPilot.id },
  });

  // --- Hotfixes ------------------------------------------------------------
  const paymentIssue = eshopIssues.find((issue) => issue.title.startsWith('Payment callback'))!;
  const refundTask = eshopTasks.find((task) => task.title.startsWith('Order refund'))!;

  const eshopCounter = await prisma.project.update({
    where: { id: eshop.project.id },
    data: { hotfixCounter: { increment: 1 } },
    select: { key: true, hotfixCounter: true },
  });

  await prisma.hotfix.create({
    data: {
      key: `${eshopCounter.key}-HF${eshopCounter.hotfixCounter}`,
      projectId: eshop.project.id,
      title: 'Raise the payment callback timeout and retry',
      description:
        'Orders sit in Pending during the evening peak because the callback exceeds 30s. Raise the timeout, add a bounded retry and make the handler idempotent.',
      status: 'IN_TESTING',
      severity: 'CRITICAL',
      priority: 'CRITICAL',
      issueId: paymentIssue.id,
      taskId: refundTask.id,
      requestedById: lead.id,
      assigneeId: people.get('hov.vathana@kiri.test')!.id,
      dueDate: days(1),
      createdAt: days(-3),
      approvedAt: days(-2),
      fixedAt: days(-1),
      rootCause: 'The callback handler did a synchronous core-banking call inside the request, and the gateway gave up at 30s.',
    },
  });

  const acsCounter = await prisma.project.update({
    where: { id: acs.project.id },
    data: { hotfixCounter: { increment: 1 } },
    select: { key: true, hotfixCounter: true },
  });

  const feedIssue = acsIssues.find((issue) => issue.title.startsWith('Market data stops'))!;

  await prisma.hotfix.create({
    data: {
      key: `${acsCounter.key}-HF${acsCounter.hotfixCounter}`,
      projectId: acs.project.id,
      title: 'Reconnect the CSX market data consumer after a session restart',
      description: 'Pilot users see frozen prices after the midday break. Add a heartbeat and reconnect rather than waiting for a manual restart.',
      status: 'REQUESTED',
      severity: 'BLOCKER',
      priority: 'CRITICAL',
      issueId: feedIssue.id,
      requestedById: people.get('sem.chitra@kiri.test')!.id,
      assigneeId: middleware.id,
      dueDate: days(1),
      createdAt: days(-1),
    },
  });

  // --- A little conversation ----------------------------------------------
  const refundComment = await prisma.comment.create({
    data: {
      body: 'Finance confirmed the reversal has to post on the same value date. That rules out the overnight batch — it needs the synchronous call.',
      entityType: 'TASK',
      authorId: people.get('boreth.boris@kiri.test')!.id,
      taskId: refundTask.id,
      projectId: eshop.project.id,
      createdAt: days(-2),
    },
  });

  await prisma.comment.create({
    data: {
      body: 'Understood. I will keep the approval step in backoffice so nothing posts without a second pair of eyes.',
      entityType: 'TASK',
      authorId: people.get('hov.vathana@kiri.test')!.id,
      taskId: refundTask.id,
      projectId: eshop.project.id,
      parentId: refundComment.id,
      createdAt: days(-1),
    },
  });

  await prisma.comment.create({
    data: {
      body: 'Reproduced on the pilot environment at 11:58 today. The consumer is alive but the CSX socket is half open, so nothing arrives and nothing errors.',
      entityType: 'ISSUE',
      authorId: middleware.id,
      issueId: feedIssue.id,
      projectId: acs.project.id,
      createdAt: days(-1),
    },
  });

  // --- Today -------------------------------------------------------------
  // Three days of standup notes, so the Today and team pages open with
  // something on them rather than an empty grid.
  const dayKey = (back: number) => days(-back).toISOString().slice(0, 10);

  type Bullet = { kind: 'FOCUS' | 'BLOCKER'; body: string; done?: boolean; taskKey?: string };
  type DaySpec = { email: string; back: number; note?: string; bullets: Bullet[] };

  const taskByKey = new Map(
    [...eshopTasks, ...acsTasks].map((task) => [task.key, task.id] as const),
  );

  const DAYS: DaySpec[] = [
    {
      email: 'hov.vathana@kiri.test',
      back: 0,
      note: 'On the refund flow most of the day. Free after 3pm if anyone needs a review.',
      bullets: [
        { kind: 'FOCUS', body: 'Core banking reversal call for the refund flow', taskKey: 'ESHOP-6' },
        { kind: 'FOCUS', body: 'Raise the payment callback timeout and ship the retry', done: true },
        { kind: 'FOCUS', body: 'Review Visal’s approval queue PR' },
        {
          kind: 'BLOCKER',
          body: 'Still no UAT test account from core banking — raised Monday, no reply',
          taskKey: 'ESHOP-6',
        },
      ],
    },
    {
      email: 'san.visal@kiri.test',
      back: 0,
      bullets: [
        { kind: 'FOCUS', body: 'SME onboarding approval queue — pagination and filters' },
        { kind: 'FOCUS', body: 'Fix the aspect ratio on merchant product images', done: true },
        { kind: 'FOCUS', body: 'Start the commission configuration screen', taskKey: 'ESHOP-20' },
        {
          kind: 'BLOCKER',
          body: 'Commission rules per merchant category are still not written down anywhere',
          taskKey: 'ESHOP-20',
        },
      ],
    },
    {
      email: 'lionel.messi@kiri.test',
      back: 0,
      note: 'Pipeline work today, back on the Kafka consumer tomorrow.',
      bullets: [
        { kind: 'FOCUS', body: 'Promote the 1.0.0 image from Quay into the GitLab B pilot pipeline' },
        { kind: 'FOCUS', body: 'Look at the CSX reconnect after the midday session break' },
        {
          kind: 'BLOCKER',
          body: 'No OpenShift access on the pilot cluster — ticket with infra since Thursday',
        },
      ],
    },
    {
      email: 'boreth.boris@kiri.test',
      back: 0,
      bullets: [
        { kind: 'FOCUS', body: 'Architecture review for the order book API', taskKey: 'ACS-11' },
        { kind: 'FOCUS', body: 'Settlement export: chase the duplicate refund row' },
        { kind: 'FOCUS', body: 'Pair with Visal on the backoffice maker-checker flow', done: true },
      ],
    },
    {
      email: 'sem.chitra@kiri.test',
      back: 0,
      note: 'Steering committee at 2pm — send me anything you want raised.',
      bullets: [
        { kind: 'FOCUS', body: 'Pilot sign-off checklist with the business' },
        { kind: 'FOCUS', body: 'Scope the 2.5.0 release with the merchant team' },
      ],
    },
    {
      email: 'hov.vathana@kiri.test',
      back: 1,
      bullets: [
        { kind: 'FOCUS', body: 'Idempotency on the payment callback handler', done: true },
        { kind: 'FOCUS', body: 'Write up the root cause for ESHOP-HF1', done: true },
      ],
    },
    {
      email: 'san.visal@kiri.test',
      back: 1,
      bullets: [
        { kind: 'FOCUS', body: 'Merchant settlement export screen', done: true },
        { kind: 'BLOCKER', body: 'Waiting for the final column list from finance' },
      ],
    },
  ];

  // Re-runnable: a plan is unique per person per day, so clear these people's
  // seeded days before writing them again.
  await prisma.dailyPlan.deleteMany({
    where: {
      userId: { in: [...new Set(DAYS.map((d) => people.get(d.email)!.id))] },
      date: { in: [...new Set(DAYS.map((d) => new Date(`${dayKey(d.back)}T00:00:00.000Z`)))] },
    },
  });

  let bulletCount = 0;

  for (const spec of DAYS) {
    const person = people.get(spec.email)!;
    await prisma.dailyPlan.create({
      data: {
        userId: person.id,
        date: new Date(`${dayKey(spec.back)}T00:00:00.000Z`),
        note: spec.note ?? null,
        createdAt: days(-spec.back),
        items: {
          create: spec.bullets.map((bullet, order) => ({
            kind: bullet.kind,
            body: bullet.body,
            order,
            isDone: bullet.kind === 'FOCUS' ? (bullet.done ?? false) : false,
            // Yesterday's blockers are shown as still open — that is the point
            // of them, and it gives the team page something to surface.
            taskId: bullet.taskKey ? (taskByKey.get(bullet.taskKey) ?? null) : null,
          })),
        },
      },
    });
    bulletCount += spec.bullets.length;
  }

  log(`Daily plans: ${DAYS.length} days, ${bulletCount} bullets`);

  log('─'.repeat(64));
  log('Team and projects seeded.');
  log('');
  log('Sign in with any of these — password for all except your own account:');
  log(`  ${DEV_PASSWORD}`);
  for (const person of PEOPLE) {
    log(`  ${person.email.padEnd(32)} ${person.name} · ${person.jobTitle}`);
  }
  log('');
  log('Your own account keeps the password you already use.');
  log('─'.repeat(64));
};

main()
  .catch((error) => {
    console.error('[team] failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
