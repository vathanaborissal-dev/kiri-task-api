import { env } from '../config/env.js';
import { formatDate } from '../lib/dates.js';
import type { InlineKeyboard } from 'grammy';
import { COMMAND_GROUPS } from './catalog.js';

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
    `   ${esc(humanStatus(issue.status))}${issue.phase ? ` · ${esc(issue.phase.name)}` : ''}${due}`
  );
};

export const sectionHeader = (title: string, count?: number) =>
  `*${esc(title)}*${count !== undefined ? esc(` (${count})`) : ''}`;

/**
 * `/help`, built from the one command list so it cannot fall behind the bot.
 *
 * Escaped at the edges rather than written pre-escaped: a description is
 * ordinary prose and should read like it in the source.
 */
export const helpText = (): string => {
  const sections = COMMAND_GROUPS.flatMap((group) => {
    const visible = group.commands.filter((command) => !command.hidden);
    if (visible.length === 0) return [];
    return [
      [
        ...(group.heading ? [`*${esc(group.heading)}*`] : []),
        ...visible.map((command) => `/${command.name} \u2014 ${esc(command.description)}`),
      ].join('\n'),
    ];
  });

  return [
    '*Kiri Task bot*',
    ...sections,
    esc('Send a key like ACS-12, ACS-I3 or ACS-HF1 and I will pull that item up.'),
    esc(
      'Buttons on a notification let you start a task, mark it done, comment, or open it in the web app. Everything you do here follows the same permissions as the website.',
    ),
  ].join('\n\n');
};

/**
 * Says what a capped list left out.
 *
 * The lists take a fixed number of rows so a phone can scan them, and the
 * header counts everything that matched — without this line the two disagree
 * and the list quietly looks like the whole truth.
 */
export const truncationNote = (shown: number, total: number): string | null =>
  total > shown ? esc(`Showing ${shown} of ${total} — open Kiri Task for the rest.`) : null;

export type HotfixLine = {
  key: string;
  title: string;
  severity: string;
  status: string;
};

export const hotfixLine = (hotfix: HotfixLine): string =>
  `${SEVERITY_ICON[hotfix.severity] ?? '•'} *${esc(hotfix.key)}* ${esc(hotfix.title)}\n` +
  `   ${esc(hotfix.status.replace(/_/g, ' ').toLowerCase())}`;

/**
 * An enum name as a person would write it.
 *
 * `WONT_FIX` lowercases to "wont fix", which reads as a typo rather than a
 * status, so the one value that needs an apostrophe gets one.
 */
export const humanStatus = (value: string): string =>
  value === 'WONT_FIX' ? "won't fix" : value.replace(/_/g, ' ').toLowerCase();
