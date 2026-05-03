/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import nodemailer from 'nodemailer';
import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const SMTP_HOST = process.env.SMTP_HOST?.trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || '587');
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER?.trim();
const SMTP_PASS = process.env.SMTP_PASS?.trim();
const SMTP_FROM = process.env.SMTP_FROM?.trim();

const smtpTransport = SMTP_HOST && SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    })
  : null;

const FROM = SMTP_FROM || process.env.RORCA_EMAIL_FROM || 'Rorca <no-reply@rorca.ai>';
const BASE_URL = process.env.RORCA_BASE_URL || 'http://localhost:5210';

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (smtpTransport) {
    await smtpTransport.sendMail({
      from: FROM,
      to,
      subject,
      html,
    });
    return;
  }

  if (resend) {
    await resend.emails.send({
      from: FROM,
      to,
      subject,
      html,
    });
    return;
  }

  throw new Error('No email transport configured. Set SMTP_* for Google Workspace/Gmail SMTP or RESEND_API_KEY for Resend.');
}

export async function sendVerificationEmail(email: string, confirmationUrl: string): Promise<void> {
  await sendEmail(
    email,
    'Verify your Rorca account',
    `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h1 style="font-size:24px;font-weight:700;color:#0f172a;margin-bottom:8px">Verify your email</h1>
        <p style="color:#475569;margin-bottom:24px">
          Click the button below to verify your email address and activate your Rorca account.
        </p>
        <a href="${confirmationUrl}"
           style="display:inline-block;background:#0ea5e9;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:6px;text-decoration:none">
          Verify email
        </a>
        <p style="color:#94a3b8;font-size:12px;margin-top:32px">
          If you didn't create a Rorca account, you can safely ignore this email.
        </p>
      </div>
    `,
  );
}

export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<void> {
  await sendEmail(
    email,
    'Reset your Rorca password',
    `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h1 style="font-size:24px;font-weight:700;color:#0f172a;margin-bottom:8px">Reset your password</h1>
        <p style="color:#475569;margin-bottom:24px">
          Click the button below to reset your Rorca password. This link expires in 1 hour.
        </p>
        <a href="${resetUrl}"
           style="display:inline-block;background:#0ea5e9;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:6px;text-decoration:none">
          Reset password
        </a>
        <p style="color:#94a3b8;font-size:12px;margin-top:32px">
          If you didn't request a password reset, you can safely ignore this email.
        </p>
      </div>
    `,
  );
}

export async function sendTeamInviteEmail(
  email: string,
  inviterName: string,
  teamName: string,
  inviteUrl: string,
): Promise<void> {
  await sendEmail(
    email,
    `${inviterName} invited you to join ${teamName} on Rorca`,
    `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h1 style="font-size:24px;font-weight:700;color:#0f172a;margin-bottom:8px">You're invited</h1>
        <p style="color:#475569;margin-bottom:24px">
          <strong>${inviterName}</strong> has invited you to join the <strong>${teamName}</strong> team on Rorca.
        </p>
        <a href="${inviteUrl}"
           style="display:inline-block;background:#0ea5e9;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:6px;text-decoration:none">
          Accept invitation
        </a>
        <p style="color:#94a3b8;font-size:12px;margin-top:32px">
          If you weren't expecting this invitation, you can safely ignore this email.
        </p>
      </div>
    `,
  );
}

export async function sendRunCompleteEmail(
  email: string,
  specTitle: string,
  passed: number,
  total: number,
  runUrl: string,
): Promise<void> {
  const allPassed = passed === total;
  const statusColor = allPassed ? '#22c55e' : '#f59e0b';
  const statusText = allPassed ? 'Completed' : 'Completed with failures';

  await sendEmail(
    email,
    `Run ${allPassed ? 'completed' : 'finished with failures'}: ${specTitle}`,
    `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h1 style="font-size:24px;font-weight:700;color:#0f172a;margin-bottom:8px">Pipeline run finished</h1>
        <p style="color:#475569;margin-bottom:8px">
          <strong>${specTitle}</strong>
        </p>
        <p style="margin-bottom:24px">
          <span style="color:${statusColor};font-weight:600">${statusText}</span>
          &nbsp;—&nbsp;${passed}/${total} stories passed
        </p>
        <a href="${runUrl}"
           style="display:inline-block;background:#0ea5e9;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:6px;text-decoration:none">
          View run
        </a>
      </div>
    `,
  );
}
