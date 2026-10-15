import { logger } from '../lib/logger.js';

export type TelegramButton = {
  text: string;
  /** Opens in the user's browser. */
  url?: string;
  /** Opens as a Mini App inside Telegram. Requires an https origin. */
  webApp?: string;
  callbackData?: string;
};

export type TelegramMessage = {
  chatId: bigint;
  text: string;
  buttons?: TelegramButton[][];
};

type TelegramSender = (message: TelegramMessage) => Promise<void>;

let telegramSender: TelegramSender | null = null;

/**
 * The Telegram transport registers itself at boot. Keeping it behind this
 * registry means the notification service never imports the bot (and the bot
 * can run in a separate process without changing anything here).
 */
export const registerTelegramSender = (sender: TelegramSender) => {
  telegramSender = sender;
};

export const telegramAvailable = () => telegramSender !== null;

export const sendTelegramMessage = async (message: TelegramMessage): Promise<void> => {
  if (!telegramSender) return;
  try {
    await telegramSender(message);
  } catch (error) {
    logger.warn({ error, chatId: String(message.chatId) }, 'Telegram delivery failed');
  }
};
