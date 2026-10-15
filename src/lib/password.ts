import bcrypt from 'bcryptjs';

const ROUNDS = 12;

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, ROUNDS);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

/** Mirrors the rules enforced by the zod schemas, for reuse in the seed script. */
export const PASSWORD_MIN_LENGTH = 10;

export const describePasswordRules = () =>
  `At least ${PASSWORD_MIN_LENGTH} characters, including a letter and a number.`;

export const isStrongPassword = (value: string): boolean =>
  value.length >= PASSWORD_MIN_LENGTH && /[A-Za-z]/.test(value) && /\d/.test(value);
