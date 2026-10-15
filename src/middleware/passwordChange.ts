import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';
import { getAuth } from './auth.js';

/**
 * Blocks the app for somebody still on a password that was generated for them.
 *
 * `mustChangePassword` used to be advisory: the client read it and redirected,
 * but the API served every request regardless, so navigating straight to a page
 * — or using the API directly — kept a console-printed temporary password
 * working indefinitely.
 *
 * Mounted above the resource routers only. The `/auth` router stays open so the
 * session can still read `/auth/me`, change the password, refresh and log out.
 */
export const requirePasswordChanged = (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (getAuth(req).user.mustChangePassword) {
      throw new AppError(
        403,
        'PASSWORD_CHANGE_REQUIRED',
        'Choose your own password before continuing.',
      );
    }
    next();
  } catch (error) {
    next(error);
  }
};
