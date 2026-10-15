import { z } from 'zod';
import { PASSWORD_MIN_LENGTH } from '../../lib/password.js';

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: passwordSchema,
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password: passwordSchema,
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(10),
  name: z.string().trim().min(2).max(120).optional(),
  password: passwordSchema,
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  jobTitle: z.string().max(120).trim().nullish(),
  responsibilities: z.string().max(2000).trim().nullish(),
  timezone: z.string().max(64).optional(),
});
