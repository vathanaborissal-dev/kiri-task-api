import app from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { startBot, stopBot } from './telegram/bot.js';

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, webApp: env.WEB_APP_URL },
    'Kiri Task API listening',
  );
});

// Password reset is the one flow with no manual fallback: an invitation hands
// the admin an acceptUrl to pass on by hand, but "forgot password" just mails
// the link or silently does nothing. Say so loudly at boot.
if (!env.emailEnabled) {
  logger.warn(
    'Email is not configured (BREVO_API_KEY + EMAIL_FROM_ADDRESS) — invitations and password resets will not be delivered.',
  );
}

if (env.ENABLE_SCHEDULER) startScheduler();
if (env.telegramEnabled && env.TELEGRAM_BOT_IN_PROCESS) void startBot();

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down');
  stopScheduler();
  await stopBot();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
