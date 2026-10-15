import { Bot, GrammyError, HttpError, InlineKeyboard, webhookCallback } from 'grammy';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { registerTelegramSender, type TelegramMessage } from '../services/channels.js';
import { registerActions } from './actions.js';
import { miniAppUrl } from './format.js';
import { registerCommands } from './commands.js';
import { prunePending } from './state.js';

let bot: Bot | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
let pollingRetryTimer: NodeJS.Timeout | null = null;
let pollingRetryDelayMs = 2_000;
let receivingUpdates = false;

const MAX_POLLING_RETRY_MS = 30_000;

export const getBot = (): Bot | null => bot;
export const telegramReceivingUpdates = () => receivingUpdates;

/** Builds a fully wired bot without starting it — the test harness uses this. */
export const createBot = (token = env.TELEGRAM_BOT_TOKEN!): Bot => {
  const instance = new Bot(token);

  registerCommands(instance);
  registerActions(instance);

  instance.catch((error) => {
    const e = error.error;
    if (e instanceof GrammyError) {
      logger.warn({ description: e.description, method: e.method }, 'Telegram API error');
    } else if (e instanceof HttpError) {
      logger.warn({ error: e.message }, 'Could not reach Telegram');
    } else {
      logger.error({ error: e }, 'Unhandled error in Telegram handler');
    }
  });

  return instance;
};

const toKeyboard = (buttons: TelegramMessage['buttons']): InlineKeyboard | undefined => {
  if (!buttons?.length) return undefined;
  const keyboard = new InlineKeyboard();
  buttons.forEach((row, rowIndex) => {
    if (rowIndex > 0) keyboard.row();
    for (const button of row) {
      if (button.webApp) keyboard.webApp(button.text, button.webApp);
      else if (button.url) keyboard.url(button.text, button.url);
      else if (button.callbackData) keyboard.text(button.text, button.callbackData);
    }
  });
  return keyboard;
};

/** Registered as the outbound Telegram transport for the notification service. */
const send = async (message: TelegramMessage) => {
  if (!bot) return;
  await bot.api.sendMessage(Number(message.chatId), message.text, {
    parse_mode: 'MarkdownV2',
    link_preview_options: { is_disabled: true },
    ...(toKeyboard(message.buttons) ? { reply_markup: toKeyboard(message.buttons) } : {}),
  });
};

/**
 * Long polling can briefly conflict with the previous process during a dev
 * restart. Telegram ends one poller with a 409, so retry with backoff instead
 * of leaving the bot alive but unable to receive commands.
 */
const startPolling = (instance: Bot) => {
  if (bot !== instance || instance.isRunning()) return;

  void instance
    .start({
      onStart: (info) => {
        receivingUpdates = true;
        pollingRetryDelayMs = 2_000;
        logger.info({ username: info.username }, 'Telegram bot polling');
      },
    })
    .catch((error) => {
      if (bot !== instance) return;

      receivingUpdates = false;
      const retryInMs = pollingRetryDelayMs;
      pollingRetryDelayMs = Math.min(pollingRetryDelayMs * 2, MAX_POLLING_RETRY_MS);
      logger.warn({ error, retryInMs }, 'Telegram polling stopped; retrying');

      pollingRetryTimer = setTimeout(() => {
        pollingRetryTimer = null;
        startPolling(instance);
      }, retryInMs);
      pollingRetryTimer.unref();
    });
};

export const startBot = async (): Promise<void> => {
  if (!env.telegramEnabled) {
    logger.info('TELEGRAM_BOT_TOKEN is not set — the Telegram bot is disabled');
    return;
  }
  if (bot) return;

  bot = createBot();
  registerTelegramSender(send);
  pruneTimer = setInterval(() => {
    void prunePending().catch((error) => logger.error({ error }, 'Failed to prune bot drafts'));
  }, 5 * 60 * 1000);
  pruneTimer.unref();

  await bot.api.setMyCommands([
    { command: 'mytasks', description: 'My open tasks' },
    { command: 'today', description: "Today's work and deadlines" },
    { command: 'overdue', description: 'Overdue tasks and issues' },
    { command: 'issues', description: 'Issues assigned to me' },
    { command: 'projects', description: 'Projects I can access' },
    { command: 'report', description: 'Report an issue' },
    { command: 'app', description: 'Open Kiri Task' },
    { command: 'me', description: 'My account' },
    { command: 'help', description: 'Show available commands' },
  ]);

  // The blue button next to the message box opens Kiri Task inside Telegram.
  // Telegram only accepts an https origin for a Mini App, so a local
  // development URL quietly keeps the default menu instead.
  if (miniAppUrl()) {
    await bot.api
      .setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: 'Kiri Task',
          web_app: { url: miniAppUrl()! },
        },
      })
      .catch((error) => logger.warn({ error }, 'Could not set the Telegram menu button'));
  } else {
    logger.info(
      { webAppUrl: env.WEB_APP_URL },
      'WEB_APP_URL is not https — the Telegram Mini App button is disabled',
    );
  }

  if (env.TELEGRAM_WEBHOOK_URL) {
    const url = `${env.TELEGRAM_WEBHOOK_URL.replace(/\/$/, '')}/api/telegram/webhook`;
    await bot.api.setWebhook(url, {
      ...(env.TELEGRAM_WEBHOOK_SECRET ? { secret_token: env.TELEGRAM_WEBHOOK_SECRET } : {}),
      drop_pending_updates: false,
    });
    receivingUpdates = true;
    logger.info({ url }, 'Telegram bot running in webhook mode');
  } else {
    await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => undefined);
    startPolling(bot);
  }
};

export const stopBot = async (): Promise<void> => {
  if (pruneTimer) clearInterval(pruneTimer);
  if (pollingRetryTimer) clearTimeout(pollingRetryTimer);
  pollingRetryTimer = null;
  pollingRetryDelayMs = 2_000;
  receivingUpdates = false;
  if (!bot) return;
  const current = bot;
  bot = null;
  try {
    await current.stop();
  } catch {
    /* already stopped */
  }
};

/** Express handler for webhook mode. */
export const telegramWebhookHandler = () => {
  if (!bot) throw new Error('Telegram bot is not running');
  return webhookCallback(bot, 'express', {
    secretToken: env.TELEGRAM_WEBHOOK_SECRET,
  });
};
