import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';

type Schemas = {
  body?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  params?: z.ZodTypeAny;
};

const formatIssues = (error: z.ZodError) =>
  error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));

/**
 * Validates and *replaces* the request parts with the parsed values, so
 * handlers only ever see coerced, trusted data.
 */
export const validate =
  (schemas: Schemas) => (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query);
        Object.defineProperty(req, 'validatedQuery', { value: parsed, configurable: true });
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new AppError(422, 'VALIDATION_ERROR', 'Some fields need attention', formatIssues(error)));
        return;
      }
      next(error);
    }
  };

/** Typed accessor for the parsed query (Express 5 makes req.query read-only). */
export const q = <T>(req: Request): T => (req as unknown as { validatedQuery: T }).validatedQuery;
