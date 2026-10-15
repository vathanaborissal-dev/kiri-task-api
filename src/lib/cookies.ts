import type { CookieOptions, Response } from 'express';
import { env } from '../config/env.js';

export const ACCESS_COOKIE = 'kiri_at';
export const REFRESH_COOKIE = 'kiri_rt';
export const CSRF_COOKIE = 'kiri_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const base = (): CookieOptions => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAME_SITE,
  path: '/',
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
});

const ACCESS_MAX_AGE = 15 * 60 * 1000;

export const refreshMaxAge = () => env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

export const setAuthCookies = (
  res: Response,
  tokens: { accessToken: string; refreshToken: string; csrfToken: string },
) => {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...base(), maxAge: ACCESS_MAX_AGE });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...base(),
    maxAge: refreshMaxAge(),
    path: '/',
  });
  // Readable by the browser so the SPA can echo it back in the CSRF header.
  res.cookie(CSRF_COOKIE, tokens.csrfToken, {
    ...base(),
    httpOnly: false,
    maxAge: refreshMaxAge(),
  });
};

export const clearAuthCookies = (res: Response) => {
  const opts = { ...base(), maxAge: 0 };
  res.clearCookie(ACCESS_COOKIE, opts);
  res.clearCookie(REFRESH_COOKIE, opts);
  res.clearCookie(CSRF_COOKIE, { ...opts, httpOnly: false });
};
