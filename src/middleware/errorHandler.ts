import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { Prisma } from '../generated/prisma/client.js';

type ErrorBody = {
  error: { code: string; message: string; details?: unknown; requestId?: string };
};

const prismaMessage = (error: Prisma.PrismaClientKnownRequestError): AppError => {
  switch (error.code) {
    case 'P2002': {
      const target = (error.meta?.target as string[] | string | undefined) ?? 'field';
      const fields = Array.isArray(target) ? target.join(', ') : String(target);
      return new AppError(409, 'CONFLICT', `That ${fields} is already taken`, { fields });
    }
    case 'P2003':
      return new AppError(409, 'CONFLICT', 'That change would break a related record');
    case 'P2025':
      return new AppError(404, 'NOT_FOUND', 'Not found');
    case 'P2014':
      return new AppError(409, 'CONFLICT', 'That change would break a required relation');
    default:
      return new AppError(400, 'DATABASE_ERROR', 'The database rejected that request', {
        code: error.code,
      });
  }
};

export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` },
  } satisfies ErrorBody);
};

export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof ZodError) {
    appError = new AppError(
      422,
      'VALIDATION_ERROR',
      'Some fields need attention',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    appError = prismaMessage(err);
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    appError = new AppError(400, 'BAD_REQUEST', 'The request data was not valid');
  } else if (err instanceof MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large' : 'That upload was rejected';
    appError = new AppError(400, 'UPLOAD_ERROR', message, { code: err.code });
  } else if (typeof err === 'object' && err !== null && 'status' in err) {
    const e = err as { status?: number; code?: string; message?: string };
    appError = new AppError(e.status ?? 500, e.code ?? 'INTERNAL_ERROR', e.message ?? 'Unexpected error');
  } else {
    appError = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong');
  }

  if (appError.status >= 500) {
    logger.error({ err, path: req.originalUrl, method: req.method }, 'Unhandled API error');
  } else {
    logger.debug({ code: appError.code, path: req.originalUrl }, appError.message);
  }

  const body: ErrorBody = {
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
    },
  };

  if (!env.isProduction && appError.status >= 500 && err instanceof Error) {
    body.error.details = { stack: err.stack };
  }

  res.status(appError.status).json(body);
};
