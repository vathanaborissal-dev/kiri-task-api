import { prisma } from '../lib/prisma.js';
import type { AuthContext } from '../services/authContext.js';

/**
 * Looking something up by the key people already say out loud.
 *
 * Keys are how this team refers to work in every other channel — "did ACS-12
 * ship", "ESHOP-I3 is back". Typing one at the bot used to earn "I was not
 * expecting anything just now", which is a strange answer to the most natural
 * thing someone could send.
 */

export type ItemKind = 'task' | 'issue' | 'hotfix';

/**
 * `ACS-12` is a task, `ACS-I3` an issue, `ACS-HF1` a hotfix — the same shapes
 * the key generator produces. Matched anywhere in the message, because people
 * write "what about ACS-12?" as readily as the bare key.
 */
const KEY_PATTERN = /\b([A-Za-z][A-Za-z0-9]{0,9})-(HF|I)?(\d{1,6})\b/;

export type ParsedKey = { key: string; kind: ItemKind };

export const parseItemKey = (text: string): ParsedKey | null => {
  const match = KEY_PATTERN.exec(text);
  if (!match) return null;

  const [, project, marker, number] = match;
  const kind: ItemKind = marker === 'HF' ? 'hotfix' : marker === 'I' ? 'issue' : 'task';
  return { key: `${project!.toUpperCase()}-${marker ?? ''}${number}`, kind };
};

export type FoundItem =
  | { found: true; kind: ItemKind; id: string }
  /** The key is well formed but there is no such item, or none they may see. */
  | { found: false };

/**
 * Resolves a key to an item the caller is allowed to open.
 *
 * A key they cannot see is reported as missing rather than forbidden: telling
 * someone that ACS-12 exists but is none of their business still tells them
 * ACS-12 exists.
 */
export const findByKey = async (
  auth: AuthContext,
  parsed: ParsedKey,
): Promise<FoundItem> => {
  const { key, kind } = parsed;

  if (kind === 'task') {
    const task = await prisma.task.findUnique({
      where: { key },
      select: { id: true, projectId: true },
    });
    if (!task || !(await auth.canInProject(task.projectId, 'task:view'))) return { found: false };
    return { found: true, kind, id: task.id };
  }

  if (kind === 'issue') {
    const issue = await prisma.issue.findUnique({
      where: { key },
      select: { id: true, projectId: true },
    });
    if (!issue || !(await auth.canInProject(issue.projectId, 'issue:view'))) return { found: false };
    return { found: true, kind, id: issue.id };
  }

  const hotfix = await prisma.hotfix.findUnique({
    where: { key },
    select: { id: true, projectId: true },
  });
  if (!hotfix || !(await auth.canInProject(hotfix.projectId, 'hotfix:view'))) return { found: false };
  return { found: true, kind, id: hotfix.id };
};
