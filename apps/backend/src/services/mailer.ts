import nodemailer from "nodemailer";

const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER?.trim();
const smtpPass = process.env.SMTP_PASS?.replace(/\s+/g, "");

let rawSmtpFrom = process.env.SMTP_FROM || (smtpUser ? `"Trenno" <${smtpUser}>` : '"Trenno Team" <noreply@trenno.local>');
if ((rawSmtpFrom.startsWith('"') && rawSmtpFrom.endsWith('"')) || (rawSmtpFrom.startsWith("'") && rawSmtpFrom.endsWith("'"))) {
  rawSmtpFrom = rawSmtpFrom.slice(1, -1).trim();
}
const smtpFrom = rawSmtpFrom;
const smtpSecure = process.env.SMTP_SECURE === "true" || smtpPort === 465;
const appUrl = process.env.APP_URL;

if (!smtpHost) {
  console.warn("[Mailer] SMTP_HOST is not set; emails will fail until SMTP_* is configured.");
}

export const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpSecure,
  auth: smtpUser && smtpPass ? { user: smtpUser, pass: smtpPass } : undefined,
});

export interface SendMailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

// Sends one email through the configured SMTP server. Errors are thrown to the caller.
export async function sendEmail({ to, subject, text, html }: SendMailOptions): Promise<void> {
  if (!smtpHost) {
    throw new Error("SMTP_HOST is not configured");
  }
  await transporter.sendMail({ from: smtpFrom, to, subject, text, html });
  console.log(`[Mailer] Sent email via SMTP (${smtpHost}) to ${to}`);
}

export async function sendVerificationEmail(to: string, rawToken: string, firstName: string): Promise<void> {
  const verifyUrl = `${appUrl}/verify?token=${rawToken}`;
  await sendEmail({
    to,
    subject: "Verify your Trenno account",
    text: `Hello ${firstName},\n\nPlease verify your email address by opening the following link in your browser:\n\n${verifyUrl}\n\nThis link is valid for 24 hours.\n\nBest,\nThe Trenno Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #18181b;">
        <div style="margin-bottom: 24px;">
          <h2 style="color: #4f46e5; margin: 0; font-size: 24px;">Trenno</h2>
        </div>
        <h3 style="margin-top: 0; color: #18181b;">Verify your email address</h3>
        <p>Hello ${firstName},</p>
        <p>Thank you for signing up for Trenno. Please confirm your email address by clicking the button below:</p>
        <div style="margin: 32px 0;">
          <a href="${verifyUrl}" style="background-color: #4f46e5; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Verify Email Address</a>
        </div>
        <p style="color: #71717a; font-size: 14px;">This link will expire in 24 hours. If you did not create a Trenno account, you can safely ignore this email.</p>
        <hr style="border: 0; border-top: 1px solid #e4e4e7; margin: 24px 0;" />
        <p style="color: #a1a1aa; font-size: 12px;">Trenno Sprint & Task Management Platform</p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(to: string, rawToken: string, firstName: string): Promise<void> {
  const resetUrl = `${appUrl}/reset-password?token=${rawToken}`;
  await sendEmail({
    to,
    subject: "Reset your Trenno password",
    text: `Hello ${firstName},\n\nWe received a request to reset your Trenno password. Use the link below to set a new password:\n\n${resetUrl}\n\nThis link is single-use and valid for 30 minutes.\n\nIf you did not request this, please review your security settings immediately.\n\nBest,\nThe Trenno Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #18181b;">
        <div style="margin-bottom: 24px;">
          <h2 style="color: #4f46e5; margin: 0; font-size: 24px;">Trenno</h2>
        </div>
        <h3 style="margin-top: 0; color: #18181b;">Reset your password</h3>
        <p>Hello ${firstName},</p>
        <p>We received a request to reset the password for your Trenno account. Click the button below to choose a new password:</p>
        <div style="margin: 32px 0;">
          <a href="${resetUrl}" style="background-color: #4f46e5; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Reset Password</a>
        </div>
        <p style="color: #71717a; font-size: 14px;">This link is valid for 30 minutes and can only be used once. If you did not make this request, you can safely ignore this email.</p>
        <hr style="border: 0; border-top: 1px solid #e4e4e7; margin: 24px 0;" />
        <p style="color: #a1a1aa; font-size: 12px;">Trenno Sprint & Task Management Platform</p>
      </div>
    `,
  });
}

export async function sendPasswordChangedEmail(to: string, firstName: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Your Trenno password was changed",
    text: `Hello ${firstName},\n\nYour Trenno account password was successfully changed. All other active sessions have been revoked for your security.\n\nIf you did not make this change, please contact your administrator immediately.\n\nBest,\nThe Trenno Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #18181b;">
        <h3 style="margin-top: 0; color: #18181b;">Password changed successfully</h3>
        <p>Hello ${firstName},</p>
        <p>This is a confirmation that your Trenno account password was successfully updated. As a precaution, all other active sessions have been logged out.</p>
        <p style="color: #ef4444; font-size: 14px;">If you did not perform this action, please contact support or your organization administrator immediately.</p>
      </div>
    `,
  });
}

export async function sendAccountLockedEmail(to: string, firstName: string, minutes: number): Promise<void> {
  await sendEmail({
    to,
    subject: "Security Alert: Trenno account temporarily locked",
    text: `Hello ${firstName},\n\nYour Trenno account has been temporarily locked for ${minutes} minutes due to 5 consecutive failed login attempts.\n\nYou can try logging in again once the lockout period expires.\n\nBest,\nThe Trenno Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #18181b;">
        <h3 style="margin-top: 0; color: #dc2626;">Account temporarily locked</h3>
        <p>Hello ${firstName},</p>
        <p>Your account has been locked for <strong>${minutes} minutes</strong> following 5 consecutive failed login attempts.</p>
        <p>If this was you, please wait until the lock period ends and verify your credentials before trying again. If you forgot your password, you can use the "Forgot password" option.</p>
      </div>
    `,
  });
}

export async function sendInvitationEmail(
  to: string,
  orgName: string,
  inviterName: string,
  rawToken: string
): Promise<void> {
  const inviteUrl = `${appUrl}/invite/${rawToken}`;
  await sendEmail({
    to,
    subject: `You've been invited to join ${orgName} on Trenno`,
    text: `Hello,\n\n${inviterName} has invited you to collaborate in ${orgName} on Trenno.\n\nOpen this link to accept (it works once and expires in 7 days):\n\n${inviteUrl}\n\nBest,\nThe Trenno Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #18181b;">
        <div style="margin-bottom: 24px;">
          <h2 style="color: #4f46e5; margin: 0; font-size: 24px;">Trenno</h2>
        </div>
        <h3 style="margin-top: 0; color: #18181b;">You've been invited to join ${orgName}</h3>
        <p>Hello,</p>
        <p><strong>${inviterName}</strong> has invited you to collaborate in <strong>${orgName}</strong> on the Trenno sprint & task management platform.</p>
        <div style="margin: 32px 0;">
          <a href="${inviteUrl}" style="background-color: #4f46e5; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Accept invitation</a>
        </div>
        <p style="color: #71717a; font-size: 14px;">This link works once and expires in 7 days. If you don't have a Trenno account yet, you'll create one from the link.</p>
        <hr style="border: 0; border-top: 1px solid #e4e4e7; margin: 24px 0;" />
        <p style="color: #a1a1aa; font-size: 12px;">Trenno Sprint & Task Management Platform</p>
      </div>
    `,
  });
}

export async function sendAccountSuspendedEmail(to: string, firstName: string, reason?: string): Promise<void> {
  const reasonText = reason ? `Reason provided: ${reason}\n\n` : "";
  await sendEmail({
    to,
    subject: "Notice: Your Trenno account has been suspended",
    text: `Hello ${firstName},\n\nYour Trenno platform account has been suspended by an administrator.\n\n${reasonText}All active sessions have been revoked. If you believe this is in error, please contact your platform administrator.\n\nBest,\nThe Trenno Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #18181b;">
        <h3 style="color: #dc2626; margin-top: 0;">Account Suspended</h3>
        <p>Hello ${firstName},</p>
        <p>Your Trenno account has been suspended by a System Administrator.</p>
        ${reason ? `<div style="background-color: #fef2f2; border: 1px solid #fee2e2; padding: 12px; margin: 16px 0; color: #991b1b; font-size: 13px;"><strong>Reason:</strong> ${reason}</div>` : ""}
        <p style="color: #71717a; font-size: 13px;">All of your active sessions and real-time connections have been closed. Contact platform administration if you have questions.</p>
      </div>
    `,
  });
}

export async function sendAccountReactivatedEmail(to: string, firstName: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Notice: Your Trenno account has been reactivated",
    text: `Hello ${firstName},\n\nYour Trenno account has been reactivated by an administrator. You may now sign in to your workspace.\n\nBest,\nThe Trenno Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #18181b;">
        <h3 style="color: #10b981; margin-top: 0;">Account Reactivated</h3>
        <p>Hello ${firstName},</p>
        <p>Your Trenno account has been reactivated by an administrator. You can now log in and access your workspace.</p>
        <div style="margin: 24px 0;">
          <a href="${appUrl}/login" style="background-color: #2563eb; color: #ffffff; padding: 10px 20px; text-decoration: none; font-weight: 600; display: inline-block;">Sign In Now</a>
        </div>
      </div>
    `,
  });
}

export async function sendAccountDeletedEmail(to: string, firstName: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Notice: Your Trenno account has been deleted",
    text: `Hello ${firstName},\n\nYour Trenno account is being deleted by an administrator. In accordance with platform privacy and anonymization rules, all personal credentials and identification records have been removed.\n\nBest,\nThe Trenno Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #18181b;">
        <h3 style="color: #dc2626; margin-top: 0;">Account Deleted</h3>
        <p>Hello ${firstName},</p>
        <p>Your Trenno account is being deleted by an administrator. Your personal identifying information is anonymized, and all active sessions and access credentials have been revoked.</p>
      </div>
    `,
  });
}

export async function sendOrgDeletedEmail(to: string, firstName: string, orgName: string): Promise<void> {
  await sendEmail({
    to,
    subject: `${orgName} was deleted on Trenno`,
    text: `Hello ${firstName},\n\nThe organization "${orgName}" was deleted by a Trenno administrator. Your account is still active; you can create a new organization or accept an invitation from another one.\n\nBest,\nThe Trenno Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #18181b;">
        <h3 style="color: #dc2626; margin-top: 0;">Organization deleted</h3>
        <p>Hello ${firstName},</p>
        <p>The organization <strong>${orgName}</strong> was deleted by a Trenno administrator. Your account is still active; you can create a new organization or accept an invitation from another one.</p>
      </div>
    `,
  });
}

export async function sendMemberRemovedEmail(to: string, firstName: string, orgName: string): Promise<void> {
  await sendEmail({
    to,
    subject: `You were removed from ${orgName} on Trenno`,
    text: `Hello ${firstName},\n\nYou were removed from the organization "${orgName}" by an administrator. Your account is still active; you can create a new organization or accept an invitation from another one.\n\nBest,\nThe Trenno Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #18181b;">
        <h3 style="color: #dc2626; margin-top: 0;">Removed from ${orgName}</h3>
        <p>Hello ${firstName},</p>
        <p>You were removed from <strong>${orgName}</strong> by an administrator. Your account is still active; you can create a new organization or accept an invitation from another one.</p>
      </div>
    `,
  });
}

export async function sendRoleChangedEmail(to: string, firstName: string, details: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Notice: Your Trenno role has been updated",
    text: `Hello ${firstName},\n\nYour permissions on Trenno have been updated: ${details}.\n\nBest,\nThe Trenno Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #18181b;">
        <h3 style="color: #2563eb; margin-top: 0;">Permissions Updated</h3>
        <p>Hello ${firstName},</p>
        <p>Your account permissions on Trenno have been updated by an administrator:</p>
        <div style="background-color: #eff6ff; border: 1px solid #dbeafe; padding: 12px; margin: 16px 0; color: #1e40af; font-size: 13px;">${details}</div>
      </div>
    `,
  });
}

export async function sendSaInvitationEmail(to: string, inviterName: string, rawToken: string): Promise<void> {
  const inviteUrl = `${appUrl}/sa-invite/${rawToken}`;
  await sendEmail({
    to,
    subject: "You've been invited to become a System Administrator on Trenno",
    text: `Hello,\n\n${inviterName} has invited you to join the Trenno platform as a System Administrator.\n\nOpen this link to create your account (it works once and expires in 7 days):\n\n${inviteUrl}\n\nBest,\nThe Trenno Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #18181b;">
        <div style="margin-bottom: 24px;">
          <h2 style="color: #9333ea; margin: 0; font-size: 24px;">Trenno Platform Administration</h2>
        </div>
        <h3 style="margin-top: 0; color: #18181b;">System Administrator Invitation</h3>
        <p>Hello,</p>
        <p><strong>${inviterName}</strong> has invited you to join Trenno with <strong>System Administrator (SA)</strong> privileges.</p>
        <div style="margin: 32px 0;">
          <a href="${inviteUrl}" style="background-color: #9333ea; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Accept SA Invitation</a>
        </div>
        <p style="color: #71717a; font-size: 14px;">This gives full administrative access across the platform. The link works once and expires in 7 days.</p>
      </div>
    `,
  });
}

export async function sendTwoFactorDisabledEmail(to: string, firstName: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Two-Factor Authentication Disabled - Trenno",
    text: `Hello ${firstName},\n\nTwo-factor authentication (2FA) has been disabled for your Trenno account.\n\nIf you did not make this change, please contact support and change your account password immediately.\n\nBest,\nThe Trenno Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #18181b;">
        <h3 style="margin-top: 0; color: #18181b;">Two-Factor Authentication Disabled</h3>
        <p>Hello ${firstName},</p>
        <p>This is a confirmation that Two-Factor Authentication (2FA) was successfully turned off for your Trenno account.</p>
        <p style="color: #ef4444; font-size: 14px;">If you did not perform this action, please secure your account immediately by changing your password or contacting your administrator.</p>
        <hr style="border: 0; border-top: 1px solid #e4e4e7; margin: 24px 0;" />
        <p style="color: #a1a1aa; font-size: 12px;">Trenno Sprint & Task Management Platform</p>
      </div>
    `,
  });
}
