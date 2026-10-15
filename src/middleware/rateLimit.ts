import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import { env } from '../config/env.js';

const common: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please slow down.' } },
  skip: () => env.NODE_ENV === 'test',
};

/** Broad protection for the whole API surface. */
export const apiLimiter = rateLimit({
  ...common,
  windowMs: 60_000,
  limit: 300,
});

/** Credential endpoints: strict, keyed by IP + submitted email. */
export const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: 20,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : '';
    return `${ipKeyGenerator(req.ip ?? 'unknown')}:${email}`;
  },
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many attempts. Please wait a few minutes before trying again.',
    },
  },
});

/**
 * Second gate on sign-in, keyed by IP alone.
 *
 * `authLimiter` buckets per IP *and* submitted email, which stops someone
 * brute-forcing one account but does nothing about credential stuffing: a list
 * of leaked pairs tried once each produces a new key every time and never trips
 * it. The budget here is deliberately generous so a shared office NAT is not
 * locked out — it only has to catch the thousands-of-emails case.
 *
 * Note this is only as good as `req.ip`: behind a proxy it needs TRUST_PROXY
 * set, or every client collapses into one bucket.
 */
export const authIpLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: 100,
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many sign-in attempts from this network. Please wait a few minutes.',
    },
  },
});

export const uploadLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 40 });

export const writeLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 120 });
