import { z } from 'zod';
import { paginationSchema } from '../../lib/http.js';

/** Exactly one target must be supplied. */
const target = {
  taskId: z.string().optional(),
  issueId: z.string().optional(),
  releaseId: z.string().optional(),
  hotfixId: z.string().optional(),
  projectId: z.string().optional(),
};

const exactlyOneTarget = (value: Record<string, unknown>) =>
  ['taskId', 'issueId', 'releaseId', 'hotfixId', 'projectId'].filter((k) => value[k]).length === 1;

export const listCommentsQuery = paginationSchema.extend(target);

export const createCommentSchema = z
  .object({
    ...target,
    body: z.string().trim().min(1, 'Write something first').max(20000),
    parentId: z.string().optional(),
    mentionUserIds: z.array(z.string().min(1)).max(30).optional(),
    attachmentIds: z.array(z.string().min(1)).max(10).optional(),
  })
  .refine(exactlyOneTarget, { message: 'Attach the comment to exactly one item' });

export const updateCommentSchema = z.object({
  body: z.string().trim().min(1).max(20000),
  mentionUserIds: z.array(z.string().min(1)).max(30).optional(),
});
