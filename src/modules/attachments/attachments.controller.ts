import type { Request, Response } from 'express';
import multer from 'multer';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { destroyUpload, uploadBuffer } from '../../lib/cloudinary.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { logActivity } from '../../services/activity.js';
import type { EntityType } from '../../generated/prisma/enums.js';
import { userSummary } from '../shared/selectors.js';

const MAX_BYTES = 15 * 1024 * 1024;

const ALLOWED = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/json',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'video/mp4',
  'video/quicktime',
]);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      // A plain Error here would surface as a 500; this keeps it a 400 with a
      // message the person who picked the file can act on.
      cb(new AppError(400, 'UNSUPPORTED_FILE_TYPE', `${file.mimetype} files are not supported`));
      return;
    }
    cb(null, true);
  },
});

type Target = {
  taskId?: string;
  issueId?: string;
  releaseId?: string;
  hotfixId?: string;
  projectId?: string;
};

const resolveTarget = async (req: Request, body: Target) => {
  const auth = getAuth(req);

  if (body.taskId) {
    const task = await prisma.task.findFirst({
      where: { OR: [{ id: body.taskId }, { key: body.taskId.toUpperCase() }] },
      select: { id: true, projectId: true },
    });
    if (!task) throw notFound('Task not found');
    await auth.requireProject(task.projectId, 'attachment:upload');
    return {
      entityType: 'TASK' as EntityType,
      projectId: task.projectId,
      links: { taskId: task.id, projectId: task.projectId },
      folder: 'tasks',
    };
  }
  if (body.issueId) {
    const issue = await prisma.issue.findFirst({
      where: { OR: [{ id: body.issueId }, { key: body.issueId.toUpperCase() }] },
      select: { id: true, projectId: true },
    });
    if (!issue) throw notFound('Issue not found');
    await auth.requireProject(issue.projectId, 'attachment:upload');
    return {
      entityType: 'ISSUE' as EntityType,
      projectId: issue.projectId,
      links: { issueId: issue.id, projectId: issue.projectId },
      folder: 'issues',
    };
  }
  if (body.hotfixId) {
    const hotfix = await prisma.hotfix.findFirst({
      where: { OR: [{ id: body.hotfixId }, { key: body.hotfixId.toUpperCase() }] },
      select: { id: true, projectId: true },
    });
    if (!hotfix) throw notFound('Hotfix not found');
    await auth.requireProject(hotfix.projectId, 'attachment:upload');
    return {
      entityType: 'HOTFIX' as EntityType,
      projectId: hotfix.projectId,
      links: { hotfixId: hotfix.id, projectId: hotfix.projectId },
      folder: 'hotfixes',
    };
  }
  if (body.releaseId) {
    const release = await prisma.release.findUnique({
      where: { id: body.releaseId },
      select: { id: true, projectId: true },
    });
    if (!release) throw notFound('Release not found');
    await auth.requireProject(release.projectId, 'attachment:upload');
    return {
      entityType: 'RELEASE' as EntityType,
      projectId: release.projectId,
      links: { releaseId: release.id, projectId: release.projectId },
      folder: 'releases',
    };
  }
  if (body.projectId) {
    const access = await auth.requireProject(body.projectId, 'attachment:upload');
    return {
      entityType: 'PROJECT' as EntityType,
      projectId: access.projectId,
      links: { projectId: access.projectId },
      folder: 'projects',
    };
  }

  // No target: a standalone upload that a comment will claim on submit.
  return { entityType: 'COMMENT' as EntityType, projectId: null, links: {}, folder: 'comments' };
};

export const uploadAttachments = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) throw badRequest('Choose at least one file to upload');

  const target = await resolveTarget(req, req.body as Target);

  const created = await Promise.all(
    files.map(async (file) => {
      const uploaded = await uploadBuffer(file.buffer, {
        folder: target.folder,
        filename: file.originalname,
        mimeType: file.mimetype,
      });

      return prisma.attachment.create({
        data: {
          filename: uploaded.filename,
          url: uploaded.url,
          publicId: uploaded.publicId,
          mimeType: uploaded.mimeType,
          bytes: uploaded.bytes,
          width: uploaded.width ?? null,
          height: uploaded.height ?? null,
          resourceType: uploaded.resourceType,
          entityType: target.entityType,
          uploadedById: auth.id,
          ...target.links,
        },
        select: {
          id: true,
          filename: true,
          url: true,
          mimeType: true,
          bytes: true,
          width: true,
          height: true,
          createdAt: true,
          uploadedBy: { select: userSummary },
        },
      });
    }),
  );

  if (target.projectId) {
    await logActivity({
      actorId: auth.id,
      action: 'attachment.uploaded',
      entityType: target.entityType,
      entityId:
        target.links.taskId ??
        target.links.issueId ??
        target.links.hotfixId ??
        target.links.releaseId ??
        target.projectId,
      projectId: target.projectId,
      taskId: target.links.taskId ?? null,
      issueId: target.links.issueId ?? null,
      hotfixId: target.links.hotfixId ?? null,
      releaseId: target.links.releaseId ?? null,
      meta: { files: created.map((a) => a.filename) },
    });
  }

  res.status(201).json({ data: created });
};

export const deleteAttachment = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const id = String(req.params.attachmentId);

  const attachment = await prisma.attachment.findUnique({
    where: { id },
    select: {
      id: true,
      publicId: true,
      resourceType: true,
      uploadedById: true,
      projectId: true,
      filename: true,
    },
  });
  if (!attachment) throw notFound('Attachment not found');

  if (attachment.uploadedById !== auth.id) {
    if (!attachment.projectId) throw forbidden('You can only delete your own uploads');
    await auth.requireProject(attachment.projectId, 'attachment:delete');
  }

  await prisma.attachment.delete({ where: { id } });
  await destroyUpload(attachment.publicId, attachment.resourceType);
  res.status(204).end();
};

export const listAttachments = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const target = await resolveTarget(req, req.query as Target);
  if (!target.projectId) throw badRequest('Tell us which item to list attachments for');
  await auth.requireProject(target.projectId, 'project:view');

  const attachments = await prisma.attachment.findMany({
    where: target.links,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      filename: true,
      url: true,
      mimeType: true,
      bytes: true,
      width: true,
      height: true,
      createdAt: true,
      uploadedBy: { select: userSummary },
    },
  });
  res.json({ data: attachments });
};
