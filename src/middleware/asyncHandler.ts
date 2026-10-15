import type { NextFunction, Request, RequestHandler, Response } from 'express';

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

/** Express 5 forwards rejected promises already, but this keeps types tidy. */
export const asyncHandler =
  (fn: Handler): RequestHandler =>
  (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
