import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

if (!process.env.DATABASE_URL && existsSync('.env')) {
  try {
    loadEnvFile('.env');
  } catch {
    /* ignore */
  }
}

const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      if (typeof v === 'boolean') return v;
      return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().optional(),

  APP_JWT_SECRET: z.string().min(32, 'APP_JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(1),

  WEB_APP_URL: z.string().url().default('http://localhost:3000'),
  /// Comma-separated list of allowed browser origins.
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: bool(false),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  TRUST_PROXY: bool(false),

  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default('kiri-task'),

  BREVO_API_KEY: z.string().optional(),
  EMAIL_FROM_ADDRESS: z.string().optional(),
  EMAIL_FROM_NAME: z.string().default('Kiri Task'),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  /// When set, the bot runs in webhook mode at `${TELEGRAM_WEBHOOK_URL}/telegram/webhook`.
  TELEGRAM_WEBHOOK_URL: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  /// Run the bot inside the API process (long polling) instead of a separate worker.
  TELEGRAM_BOT_IN_PROCESS: bool(true),

  ENABLE_SCHEDULER: bool(true),
  /// Protects the Vercel Cron endpoint. Vercel sends it as a Bearer token.
  CRON_SECRET: z.string().min(16).optional(),
  /// Cron for deadline reminders (default: 07:30 Monday-Saturday, local timezone).
  REMINDER_CRON: z.string().default('30 7 * * 1-6'),
  SCHEDULER_TIMEZONE: z.string().default('Asia/Phnom_Penh'),

  SEED_ADMIN_EMAIL: z.string().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_ADMIN_NAME: z.string().optional(),
  SEED_DEMO_DATA: bool(false),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const raw = parsed.data;

/**
 * Both of these default to off for local development, and both silently weaken
 * a deployment if they are missed: without COOKIE_SECURE the session cookies
 * go out without the `Secure` flag, and without TRUST_PROXY every request
 * behind the proxy shares one `req.ip`, which collapses both rate limiters into
 * a single global bucket. Neither failure is visible from the outside, so fail
 * the boot instead.
 */
if (raw.NODE_ENV === 'production') {
  const missing = [
    raw.COOKIE_SECURE ? null : 'COOKIE_SECURE must be true in production',
    raw.TRUST_PROXY ? null : 'TRUST_PROXY must be true in production (the app runs behind a proxy)',
  ].filter((m): m is string => m !== null);

  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`Unsafe production configuration:\n${missing.map((m) => `  - ${m}`).join('\n')}`);
    process.exit(1);
  }
}

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  corsOrigins: raw.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  cloudinaryEnabled: Boolean(
    raw.CLOUDINARY_CLOUD_NAME && raw.CLOUDINARY_API_KEY && raw.CLOUDINARY_API_SECRET,
  ),
  emailEnabled: Boolean(raw.BREVO_API_KEY && raw.EMAIL_FROM_ADDRESS),
  telegramEnabled: Boolean(raw.TELEGRAM_BOT_TOKEN),
};

export type Env = typeof env;
