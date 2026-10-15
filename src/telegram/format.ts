import { env } from '../config/env.js';
import { formatDate } from '../lib/dates.js';
import type { InlineKeyboard } from 'grammy';

/** Telegram MarkdownV2 requires every reserved character to be escaped. */
export const esc = (value: string | null | undefined): string =>
  (value ?? '').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');

export const webUrl = (path: string) =>
  `${env.WEB_APP_URL.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;

const publicWebUrl = (path: string): string | null => {
  const value = webUrl(path);
  try {
    const { hostname, protocol } = new URL(value);
    const privateHost =
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname.endsWith('.local') ||
      hostname.startsWith('127.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
    return !privateHost && (protocol === 'http:' || protocol === 'https:') ? value : null;
  } catch {
    return null;
  }
};

/**
 * The Mini App URL for a path, or null when Kiri Task is not reachable over
 * https — Telegram refuses a `web_app` button for anything else, and a local
 * development server is exactly that case.
 */
export const miniAppUrl = (path = '/dashboard'): string | null => {
  const url = webUrl(path);
  return url.startsWith('https://') ? url : null;
};

/**
 * "Open" as a Mini App when Telegram will take one, otherwise as a plain link.
 * Both land on the same page; the Mini App just keeps people inside Telegram.
 */
export const openButton = (text: string, path: string) => {
  const inside = miniAppUrl(path);
  const outside = publicWebUrl(path);
  return inside ? { text, webApp: inside } : outside ? { text, url: outside } : null;
};

/** Adds a valid web button, or a Telegram action when the app is only local. */
export const addOpenButton = (
  keyboard: InlineKeyboard,
  text: string,
  path: string,
  fallbackCallbackData?: string,
) => {
  const button = openButton(text, path);
  if (button?.webApp) keyboard.webApp(text, button.webApp);
  else if (button?.url) keyboard.url(text, button.url);
  else if (fallbackCallbackData) keyboard.text('View details', fallbackCallbackData);
  return keyboard;
};

export const PRIORITY_ICON: Record<string, string> = {
  CRITICAL: '🔴',
  HIGH: '🟠',
  MEDIUM: '🟡',
  LOW: '⚪️',
};

export const SEVERITY_ICON: Record<string, string> = {
  BLOCKER: '⛔️',
  CRITICAL: '🔴',
  MAJOR: '🟠',
  MINOR: '🟡',
};

export const CATEGORY_ICON: Record<string, string> = {
  TODO: '○',
  IN_PROGRESS: '◐',
  IN_REVIEW: '👀',
  BLOCKED: '🚧',
  DONE: '✅',
  CANCELED: '✖️',
};

export type TaskLine = {
  key: string;
  title: string;
  priority: string;
  dueDate: Date | null;
  status: { name: string; category: string };
  project: { key: string };
  phase?: { name: string } | null;
};

export const taskLine = (task: TaskLine, timezone?: string): string => {
  const overdue = task.dueDate && task.dueDate < new Date();
  const due = task.dueDate
    ? ` · ${overdue ? '⚠️ ' : ''}${esc(formatDate(task.dueDate, timezone))}`
    : '';
  return (
    `${PRIORITY_ICON[task.priority] ?? '•'} *${esc(task.key)}* ${esc(task.title)}\n` +
    `   ${CATEGORY_ICON[task.status.category] ?? '•'} ${esc(task.status.name)}` +
    `${task.phase ? ` · ${esc(task.phase.name)}` : ''}${due}`
  );
};

export type IssueLine = {
  key: string;
  title: string;
  severity: string;
  status: string;
  dueDate: Date | null;
  project: { key: string };
  phase?: { name: string } | null;
};

export const issueLine = (issue: IssueLine, timezone?: string): string => {
  const due = issue.dueDate ? ` · ${esc(formatDate(issue.dueDate, timezone))}` : '';
  return (
    `${SEVERITY_ICON[issue.severity] ?? '•'} *${esc(issue.key)}* ${esc(issue.title)}\n` +
    `   ${esc(issue.status.replace(/_/g, ' '))}${issue.phase ? ` · ${esc(issue.phase.name)}` : ''}${due}`
  );
};

export const sectionHeader = (title: string, count?: number) =>
  `*${esc(title)}*${count !== undefined ? esc(` (${count})`) : ''}`;

export const HELP_TEXT = [
  '*Kiri Task bot*',
  '',
  'Commands:',
  '/mytasks — your open tasks',
  '/today — what is due today',
  '/overdue — anything past its deadline',
  '/issues — issues assigned to you',
  '/projects — projects you can access',
  '/report — report an issue, with an optional screenshot',
  '/app — open Kiri Task',
  '/me — your account and notification status',
  '/help — show this message',
  '',
  'Buttons on a notification let you start a task, mark it done, comment, or open it in the web app\\. Everything you do here follows the same permissions as the website\\.',
].join('\n');
