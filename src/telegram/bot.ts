import { Bot, GrammyError, HttpError, InlineKeyboard, webhookCallback } from 'grammy';
import type { Transformer } from 'grammy';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { registerTelegramSender, type TelegramMessage } from '../services/channels.js';
import { registerActions } from './actions.js';
import { menuCommands } from './catalog.js';
import { miniAppUrl } from './format.js';
import { registerCommands } from './commands.js';
import { prunePending } from './state.js';

let bot: Bot | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
let pollingRetryTimer: NodeJS.Timeout | null = null;
let pollingRetryDelayMs = 2_000;
let receivingUpdates = false;

const MAX_POLLING_RETRY_MS = 30_000;

/**
 * Telegram allows exactly one `getUpdates` consumer per bot token. A second
 * one ends the first with a 409, the first retries and ends the second, and
 * the pair trade the session back and forth — so the bot answers some messages
 * and silently drops others. It reads as "Telegram works sometimes".
 *
 * Retrying cannot win that fight, so say what is wrong once, in terms that
 * name the fix, and stop filling the log with the same warning.
 */
let conflictReported = false;

export const getBot = (): Bot | null => bot;
export const telegramReceivingUpdates = () => receivingUpdates;

/** Methods whose text Telegram parses, and will reject whole if it cannot. */
const FORMATTED_METHODS = new Set(['sendMessage', 'editMessageText']);

const PARSE_FAILURE = /can't parse entities/i;

/** Undoes MarkdownV2 escaping, so a fallback send reads as plain prose. */
const unescape = (value: string): string =>
  value.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');

/**
 * Sends the message anyway when Telegram rejects the formatting.
 *
 * One unescaped character makes Telegram refuse the entire message, so a
 * single stray dot in a reply does not come out unformatted — it does not come
 * out at all. From the chat that is indistinguishable from a bot that has
 * stopped working, and it is how four of these replies behaved for months.
 *
 * Formatting is never worth the message, so a parse failure is retried once as
 * plain text and logged loudly enough to be fixed properly.
 */
const sendAnywayOnParseFailure: Transformer = async (prev, method, payload, signal) => {
  const result = await prev(method, payload, signal);
  if (result.ok || !FORMATTED_METHODS.has(method)) return result;
  if (!PARSE_FAILURE.test(result.description ?? '')) return result;

  const text = (payload as { text?: string }).text;
  if (typeof text !== 'string') return result;

  logger.error(
    { method, description: result.description, text },
    'Telegram rejected the formatting of a message; resending it as plain text',
  );

  const { parse_mode: _parseMode, entities: _entities, ...rest } = payload as Record<string, unknown>;
  return prev(method, { ...rest, text: unescape(text) } as typeof payload, signal);
};

/** Builds a fully wired bot without starting it — the test harness uses this. */
export const createBot = (token = env.TELEGRAM_BOT_TOKEN!): Bot => {
  const instance = new Bot(token);
  instance.api.config.use(sendAnywayOnParseFailure);

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
        conflictReported = false;
        logger.info({ username: info.username }, 'Telegram bot polling');
      },
    })
    .catch((error) => {
      if (bot !== instance) return;

      receivingUpdates = false;

      const isConflict = error instanceof GrammyError && error.error_code === 409;
      if (isConflict) {
        // Another poller owns the session; back off to the ceiling rather than
        // hammering it every couple of seconds.
        pollingRetryDelayMs = MAX_POLLING_RETRY_MS;
        if (!conflictReported) {
          conflictReported = true;
          logger.error(
            'Another process is already polling this Telegram bot. Only one may run at a time: '
              + 'check for a second `npm run dev`, a stray `npm run bot`, or a deployed instance '
              + 'using the same TELEGRAM_BOT_TOKEN. Until then the bot will answer unreliably. '
              + 'Set TELEGRAM_WEBHOOK_URL in production, or TELEGRAM_BOT_IN_PROCESS=false here.',
          );
        }
      } else {
        conflictReported = false;
      }

      const retryInMs = pollingRetryDelayMs;
      if (!isConflict) {
        pollingRetryDelayMs = Math.min(pollingRetryDelayMs * 2, MAX_POLLING_RETRY_MS);
        logger.warn({ error, retryInMs }, 'Telegram polling stopped; retrying');
      }

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

  await bot.api.setMyCommands(menuCommands());

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
