import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer auto-loads .env; Node's built-in loader keeps this dependency-free.
if (existsSync('.env')) loadEnvFile('.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // Migrations and introspection run over the session-mode pooler (port 5432).
    // The application itself connects through the transaction pooler (see src/lib/prisma.ts).
    url: env('DIRECT_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
