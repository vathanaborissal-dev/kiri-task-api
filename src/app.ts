import { randomUUID } from 'node:crypto';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import * as helmetModule from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { safeEqual } from './lib/crypto.js';
import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { apiRouter } from './routes.js';
import { pruneRefreshTokens } from './modules/auth/auth.service.js';
import { runDeadlineSweep } from './jobs/deadlines.js';
import { ensureWebhook, getBot, startBot, telegramWebhookHandler } from './telegram/bot.js';

/**
 * Helmet, resolved at runtime rather than by the type-checker.
 *
 * Helmet is dual-published and its `exports` map declares no `types`
 * condition, so checkers disagree about whether the module *is* the middleware
 * factory or merely *contains* it. `tsc` with this project's config sees the
 * ESM declarations and a callable default; Vercel's Express builder, which
 * type-checks `src/app.ts` with its own settings, sees a namespace with
 * neither — so `helmet(...)` and `{ default as helmet }` both failed to build
 * there while passing locally.
 *
 * Both shapes are correct at runtime: helmet's CJS entry ends with
 * `module.exports.default = module.exports`, so the module and its `default`
 * are the same function. Picking whichever is callable sidesteps the
 * disagreement entirely. The cost is that helmet's own `HelmetOptions` type no
 * longer guards the call, so the options below are checked by hand.
 */
type HelmetOptions = Record<string, unknown>;
type HelmetFactory = (options?: HelmetOptions) => RequestHandler;

const helmet: HelmetFactory = (() => {
  const candidate = helmetModule as unknown as { default?: unknown };
  return (typeof candidate.default === 'function'
    ? candidate.default
    : helmetModule) as HelmetFactory;
})();

export const createApp = (): Express => {
  const app = express();

  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: false, // The API serves JSON only; the web app sets its own CSP.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
        callback(new AppError(403, 'CORS_REJECTED', `Origin ${origin} is not allowed`));
      },
      credentials: true,
      exposedHeaders: ['X-Request-Id'],
    }),
  );

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/api/notifications/stream',
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), version: '1.0.0' });
  });

  // Vercel Cron calls this once a day. Long-running in-process timers are not
  // reliable in serverless functions, so production uses this protected route.
  app.get('/api/cron/daily', async (req, res) => {
    const presented = req.headers.authorization ?? '';
    if (!env.CRON_SECRET || !safeEqual(presented, `Bearer ${env.CRON_SECRET}`)) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid cron secret' } });
      return;
    }

    // Re-assert the Telegram webhook while we are here. A cold start registers
    // it too, but a deployment that nobody visits never cold-starts — which is
    // the exact case where the bot appears to have gone to sleep.
    const [reminders, removedRefreshTokens, webhook] = await Promise.all([
      runDeadlineSweep(),
      pruneRefreshTokens(),
      ensureWebhook().catch((error) => {
        logger.error({ error }, 'Could not confirm the Telegram webhook');
        return null;
      }),
    ]);
    res.json({ ok: true, reminders, removedRefreshTokens, webhook });
  });

  // Telegram's webhook is authenticated by its own secret token and must sit
  // outside the session/CSRF middleware.
  app.post('/api/telegram/webhook', (req, res, next) => {
    if (!getBot()) {
      res.status(503).json({ error: { code: 'BOT_OFFLINE', message: 'Telegram bot is not running' } });
      return;
    }
    void Promise.resolve(telegramWebhookHandler()(req, res)).catch(next);
  });

  // CSRF is applied per-router: the public auth endpoints predate any session.
  app.use('/api', apiLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

// Vercel detects src/app.ts and runs this Express app as one Function.
const app = createApp();

// A webhook survives serverless restarts; long polling does not. Initializing
// here also registers the outbound Telegram sender before API routes use it.
if (env.telegramEnabled && env.TELEGRAM_BOT_IN_PROCESS && env.TELEGRAM_WEBHOOK_URL) {
  void startBot().catch((error) => logger.error({ error }, 'Failed to start Telegram webhook'));
}

export default app;
