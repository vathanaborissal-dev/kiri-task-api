import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

// The app talks to Postgres through Supabase's transaction-mode pooler
// (pgbouncer). Migrations use DIRECT_URL — see prisma.config.ts.
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  max: env.isProduction ? 10 : 5,
});

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: env.isDevelopment ? ['warn', 'error'] : ['error'],
  });

if (env.isDevelopment) globalForPrisma.prisma = prisma;

export type { PrismaClient };
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
