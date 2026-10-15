import { env } from '../config/env.js';
import { logger } from './logger.js';

type SendArgs = {
  to: { email: string; name?: string }[];
  subject: string;
  html: string;
  text?: string;
};

/** Transactional email through Brevo's REST API (no SDK needed). */
export const sendEmail = async ({ to, subject, html, text }: SendArgs): Promise<boolean> => {
  if (!env.emailEnabled) {
    logger.warn({ subject, to: to.map((t) => t.email) }, 'Email not configured — skipping send');
    return false;
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY!,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: env.EMAIL_FROM_ADDRESS, name: env.EMAIL_FROM_NAME },
        to,
        subject,
        htmlContent: html,
        ...(text ? { textContent: text } : {}),
      }),
    });

    if (!response.ok) {
      logger.error(
        { status: response.status, body: await response.text().catch(() => '') },
        'Brevo rejected the email',
      );
      return false;
    }
    return true;
  } catch (error) {
    logger.error({ error }, 'Failed to send email');
    return false;
  }
};

const shell = (title: string, bodyHtml: string, cta?: { label: string; url: string }) => `
<!doctype html>
<html><body style="margin:0;background:#f4f4f5;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="font-weight:700;font-size:18px;color:#18181b;margin-bottom:24px">Kiri Task</div>
    <div style="background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:28px">
      <h1 style="margin:0 0 12px;font-size:19px;color:#18181b">${title}</h1>
      <div style="font-size:14px;line-height:1.65;color:#3f3f46">${bodyHtml}</div>
      ${
        cta
          ? `<div style="margin-top:24px"><a href="${cta.url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:11px 20px;border-radius:9px;font-size:14px;font-weight:600">${cta.label}</a></div>`
          : ''
      }
    </div>
    <div style="margin-top:20px;font-size:12px;color:#71717a">
      You are receiving this because you are a member of a Kiri Task workspace.
    </div>
  </div>
</body></html>`;

export const invitationEmail = (args: {
  inviterName: string;
  roleName: string;
  acceptUrl: string;
  expiresInDays: number;
}) =>
  shell(
    'You have been invited to Kiri Task',
    `<p><strong>${args.inviterName}</strong> invited you to join their team workspace as <strong>${args.roleName}</strong>.</p>
     <p>Accept the invitation to choose a password and get started. This link expires in ${args.expiresInDays} days.</p>`,
    { label: 'Accept invitation', url: args.acceptUrl },
  );

export const passwordResetEmail = (args: { name: string; resetUrl: string }) =>
  shell(
    'Reset your password',
    `<p>Hi ${args.name},</p><p>Use the button below to choose a new password. The link is valid for 1 hour. If you did not ask for this, you can ignore this email.</p>`,
    { label: 'Reset password', url: args.resetUrl },
  );

export const notificationEmail = (args: { title: string; body: string; url?: string }) =>
  shell(
    args.title,
    `<p>${args.body}</p>`,
    args.url ? { label: 'Open in Kiri Task', url: args.url } : undefined,
  );
