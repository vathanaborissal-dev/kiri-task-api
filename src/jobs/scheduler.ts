import { schedule, type ScheduledTask } from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { pruneRefreshTokens } from '../modules/auth/auth.service.js';
import { heartbeat } from '../services/realtime.js';
import { runDeadlineSweep } from './deadlines.js';

let tasks: ScheduledTask[] = [];

export const startScheduler = () => {
  tasks.push(
    schedule(
      env.REMINDER_CRON,
      async () => {
        try {
          const result = await runDeadlineSweep();
          logger.info(result, 'Deadline sweep finished');
        } catch (error) {
          logger.error({ error }, 'Deadline sweep failed');
        }
      },
      { timezone: env.SCHEDULER_TIMEZONE },
    ),
  );

  // Nightly housekeeping: drop expired refresh tokens.
  tasks.push(
    schedule(
      '30 3 * * *',
      async () => {
        try {
          const removed = await pruneRefreshTokens();
          logger.info({ removed }, 'Pruned expired refresh tokens');
        } catch (error) {
          logger.error({ error }, 'Token pruning failed');
        }
      },
      { timezone: env.SCHEDULER_TIMEZONE },
    ),
  );

  // Keeps SSE connections from being closed by intermediaries.
  tasks.push(schedule('*/1 * * * *', () => heartbeat()));

  logger.info(
    { reminders: env.REMINDER_CRON, timezone: env.SCHEDULER_TIMEZONE },
    'Scheduler started',
  );
};

export const stopScheduler = () => {
  for (const task of tasks) void task.stop();
  tasks = [];
};
