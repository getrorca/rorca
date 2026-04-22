import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = 'Rorca <no-reply@rorca.ai>';
const BASE_URL = process.env.RORCA_BASE_URL || 'http://localhost:5210';

export async function sendVerificationEmail(email: string, confirmationUrl: string): Promise<void> {
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Verify your Rorca account',
    html: `
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
  });
}

export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<void> {
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Reset your Rorca password',
    html: `
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
  });
}

export async function sendTeamInviteEmail(
  email: string,
  inviterName: string,
  teamName: string,
  inviteUrl: string,
): Promise<void> {
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: `${inviterName} invited you to join ${teamName} on Rorca`,
    html: `
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
  });
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

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: `Run ${allPassed ? 'completed' : 'finished with failures'}: ${specTitle}`,
    html: `
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
  });
}
