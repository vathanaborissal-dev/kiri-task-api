/**
 * Shows — and optionally repairs — where Telegram is delivering this bot.
 *
 *   npm run telegram:webhook           # what is Telegram doing right now?
 *   npm run telegram:webhook -- --fix  # point it back at this deployment
 *
 * Run it against production by pointing the environment at production:
 *
 *   npx vercel env pull .env.production --environment=production
 *   node --env-file=.env.production node_modules/.bin/tsx scripts/telegram-webhook.ts --fix
 *
 * A bot token has exactly one delivery mode, so this is the thing to check
 * first whenever the bot stops answering: polling anywhere — a laptop running
 * `npm run dev` — removes the deployed webhook, and nothing reports that.
 */
import { Bot } from 'grammy';
import { env } from '../src/config/env.js';

const token = env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set — nothing to inspect.');
  process.exit(1);
}

const expected = env.TELEGRAM_WEBHOOK_URL
  ? `${env.TELEGRAM_WEBHOOK_URL.replace(/\/$/, '')}/api/telegram/webhook`
  : null;

const bot = new Bot(token);
const me = await bot.api.getMe();
const info = await bot.api.getWebhookInfo();

console.log(`bot            @${me.username}`);
console.log(`delivering to  ${info.url || '(nothing — long polling)'}`);
console.log(`expected       ${expected ?? '(TELEGRAM_WEBHOOK_URL is not set)'}`);
console.log(`pending        ${info.pending_update_count}`);
if (info.last_error_message) {
  const when = info.last_error_date
    ? new Date(info.last_error_date * 1000).toISOString()
    : 'unknown time';
  console.log(`last error     ${info.last_error_message} (${when})`);
}

if (info.url === expected) {
  console.log('\n✅ Telegram is delivering to this deployment.');
  process.exit(0);
}

if (!expected) {
  console.log('\n⚠️  No webhook configured here, so there is nothing to repair.');
  process.exit(0);
}

if (!process.argv.includes('--fix')) {
  console.log('\n⚠️  Telegram is not delivering here. Re-run with --fix to repair it.');
  process.exit(1);
}

await bot.api.setWebhook(expected, {
  ...(env.TELEGRAM_WEBHOOK_SECRET ? { secret_token: env.TELEGRAM_WEBHOOK_SECRET } : {}),
  drop_pending_updates: false,
});
console.log(`\n✅ Webhook set to ${expected}`);
if (!env.TELEGRAM_WEBHOOK_SECRET) {
  console.log(
    '⚠️  TELEGRAM_WEBHOOK_SECRET is not set, so the endpoint cannot tell a real '
      + 'update from a forged one. Set it and run this again.',
  );
}
