import type { NextFunction, Request, Response } from 'express';
import { badRequest } from '../lib/errors.js';
import { getAuth } from './auth.js';

/** Workspace-level permission gate. */
export const requirePermission =
  (permission: string) => (req: Request, _res: Response, next: NextFunction) => {
    try {
      getAuth(req).assert(permission);
      next();
    } catch (error) {
      next(error);
    }
  };

/** Passes when the user holds the permission on *any* accessible project. */
export const requireAnyProjectPermission =
  (permission: string) => async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const auth = getAuth(req);
      if (auth.can(permission)) return next();
      const ids = await auth.projectIdsWith(permission);
      if (ids.length === 0) {
        return next(
          Object.assign(new Error(`Missing permission: ${permission}`), {
            status: 403,
            code: 'FORBIDDEN',
          }),
        );
      }
      next();
    } catch (error) {
      next(error);
    }
  };

/**
 * Project-scoped gate. Resolves `:projectId` (id or key) from the route params
 * and stores the resolved access on the request for the handler to reuse.
 */
export const requireProjectPermission =
  (permission: string, param = 'projectId') =>
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const auth = getAuth(req);
      const value = req.params[param];
      if (typeof value !== 'string' || value.length === 0) {
        throw badRequest(`Missing route parameter: ${param}`);
      }
      await auth.requireProject(value, permission);
      next();
    } catch (error) {
      next(error);
    }
  };
