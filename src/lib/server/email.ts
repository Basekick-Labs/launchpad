import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { env } from '$env/dynamic/private';
import { getDb } from './db';
import { getEmailConfig, type EmailConfig } from './settings';

const TOKEN_EXPIRY_MINUTES = 60;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function createVerificationToken(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000).toISOString();

  const db = getDb();
  db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO email_verification_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);

  return token;
}

// Dispatch a single email via the configured transport. With provider 'none'
// (the default on a fresh install) the message is logged to the console so
// invite/verification links are still recoverable from the container logs.
async function deliver(
  cfg: EmailConfig,
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<void> {
  if (cfg.provider === 'none') {
    console.log(`\n[Arc Launchpad] Email to ${to}: ${subject}\n${text}\n`);
    return;
  }

  if (cfg.provider === 'mailgun') {
    const apiUrl = cfg.apiUrl || 'https://api.mailgun.net';
    const body = new URLSearchParams({ from: cfg.from, to, subject, text, html });
    const res = await fetch(`${apiUrl}/v3/${cfg.domain}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${cfg.apiKey}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Mailgun error: ${res.status} ${err}`);
    }
    return;
  }

  // SMTP
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass || '' } : undefined,
  });
  await transport.sendMail({ from: cfg.from, to, subject, text, html });
}

async function sendEmail(to: string, subject: string, text: string, html: string): Promise<void> {
  await deliver(getEmailConfig(), to, subject, text, html);
}

/**
 * Send a test message using a candidate config (not necessarily the saved one),
 * so the setup wizard / admin page can verify credentials before persisting.
 */
export async function sendTestEmail(cfg: EmailConfig, to: string): Promise<void> {
  const subject = 'Arc Launchpad test email';
  const text = 'This is a test email from Arc Launchpad. If you received it, email delivery is configured correctly.';
  const html = `<p>This is a test email from <strong>Arc Launchpad</strong>.</p><p>If you received it, email delivery is configured correctly.</p>`;
  await deliver(cfg, to, subject, text, html);
}

export async function sendWelcomeEmail(email: string): Promise<void> {
  const text = `Hi,

Welcome to Arc by Basekick Labs! You're joining developers who trust us to power their analytical workloads at companies using Arc for product analytics, observability, and AI agent memory.

Arc is built on DuckDB, Parquet, and Apache Arrow — delivering columnar query performance with a simple HTTP API.

Here's what you get access to:

- Blazing-fast columnar queries — outperforms row-based databases on analytical workloads
- Parquet-native storage — compact, efficient, and compatible with your existing data stack
- Simple HTTP API — ingest and query data with a single curl command

Need help getting started? Just reply to this email — it goes straight to me.

Welcome aboard,
Ignacio
Founder, Arc by Basekick Labs`;

  const html = `<p>Hi,</p>
<p>Welcome to Arc by Basekick Labs! You're joining developers who trust us to power their analytical workloads at companies using Arc for product analytics, observability, and AI agent memory.</p>
<p>Arc is built on DuckDB, Parquet, and Apache Arrow — delivering columnar query performance with a simple HTTP API.</p>
<p>Here's what you get access to:</p>
<ul>
  <li><strong>Blazing-fast columnar queries</strong> — outperforms row-based databases on analytical workloads</li>
  <li><strong>Parquet-native storage</strong> — compact, efficient, and compatible with your existing data stack</li>
  <li><strong>Simple HTTP API</strong> — ingest and query data with a single curl command</li>
</ul>
<p>Need help getting started? Just reply to this email — it goes straight to me.</p>
<p>Welcome aboard,<br>Ignacio<br><span style="color:#888">Founder, Arc by Basekick Labs</span></p>`;

  await sendEmail(email, 'Welcome to Arc by Basekick Labs', text, html);
}

export async function sendDeletionEmail(email: string, instanceName: string, purgeDate: Date): Promise<void> {
  const purgeDateStr = purgeDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const text = `Hi,

Your Arc instance "${instanceName}" has been deleted.

Your data is safe and will be retained until ${purgeDateStr}. If this was a mistake, contact us before that date and we can restore it.

After ${purgeDateStr}, all data associated with this instance will be permanently removed.

Thanks,
The Arc Launchpad team`;

  const html = `<p>Hi,</p>
<p>Your Arc instance <strong>${escapeHtml(instanceName)}</strong> has been deleted.</p>
<p>Your data is safe and will be retained until <strong>${purgeDateStr}</strong>. If this was a mistake, reply to this email before that date and we can restore it.</p>
<p>After ${purgeDateStr}, all data associated with this instance will be permanently removed.</p>
<p>Thanks,<br>The Arc Launchpad team</p>`;

  await sendEmail(email, `Arc instance "${instanceName}" deleted — data retained for 7 days`, text, html);
}

export async function sendInviteEmail(
  email: string,
  inviterName: string,
  orgName: string,
  role: string,
  token: string,
): Promise<void> {
  const baseUrl = env.LAUNCHPAD_BASE_URL || 'http://localhost:5173';
  const inviteUrl = `${baseUrl}/invite/${token}`;

  const text = `Hi,

${inviterName} has invited you to join ${orgName} as a ${role} on Arc Launchpad.

Click the link below to accept the invitation:
${inviteUrl}

This invitation will expire in 7 days.

Thanks,
The Arc Launchpad team`;

  const html = `<p>Hi,</p>
<p><strong>${escapeHtml(inviterName)}</strong> has invited you to join <strong>${escapeHtml(orgName)}</strong> as a <strong>${escapeHtml(role)}</strong> on Arc Launchpad.</p>
<p>
  <a href="${inviteUrl}"
     style="display:inline-block;padding:12px 24px;background:#A855F7;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
    Accept invitation
  </a>
</p>
<p style="color:#888;font-size:13px">This invitation will expire in 7 days.</p>
<p>Thanks,<br>The Arc Launchpad team</p>`;

  await sendEmail(email, `You've been invited to join ${orgName} on Arc Launchpad`, text, html);
}

export async function sendPasswordResetEmail(email: string, userId: string): Promise<void> {
  const RESET_EXPIRY_MINUTES = 30;
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_EXPIRY_MINUTES * 60 * 1000).toISOString();

  const db = getDb();
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);

  const baseUrl = env.LAUNCHPAD_BASE_URL || 'http://localhost:5173';
  const resetUrl = `${baseUrl}/auth/reset-password?token=${token}`;

  const text = `You requested a password reset for your Arc Launchpad account.

Click the link below to reset your password:
${resetUrl}

This link will expire in ${RESET_EXPIRY_MINUTES} minutes for security.

If you didn't request this, you can safely ignore this email.

The Arc Launchpad team`;

  const html = `<p>You requested a password reset for your Arc Launchpad account.</p>
<p>
  <a href="${resetUrl}"
     style="display:inline-block;padding:12px 24px;background:#A855F7;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
    Reset your password
  </a>
</p>
<p style="color:#888;font-size:13px">This link will expire in ${RESET_EXPIRY_MINUTES} minutes for security.</p>
<p style="color:#888;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
<p>The Arc Launchpad team</p>`;

  await sendEmail(email, 'Reset your Arc Launchpad password', text, html);
}

export async function sendVerificationEmail(email: string, userId: string): Promise<void> {
  const token = createVerificationToken(userId);
  const baseUrl = env.LAUNCHPAD_BASE_URL || 'http://localhost:5173';
  const verifyUrl = `${baseUrl}/auth/verify?token=${token}`;

  const text = `Please verify your Arc Launchpad email address by clicking the link below:

${verifyUrl}

This link will expire in ${TOKEN_EXPIRY_MINUTES} minutes for security.

Once verified, you'll have access to:

- Blazing-fast columnar queries — outperforms row-based databases on analytical workloads
- Parquet-native storage — compact, efficient, and compatible with your existing data stack
- Simple HTTP API — ingest and query data with a single curl command

Need help? Reply to this email or reach us at support@basekick.net

The Arc Launchpad team`;

  const html = `<p>Please verify your Arc Launchpad email address:</p>
<p>
  <a href="${verifyUrl}"
     style="display:inline-block;padding:12px 24px;background:#A855F7;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
    Verify your email
  </a>
</p>
<p style="color:#888;font-size:13px">This link will expire in ${TOKEN_EXPIRY_MINUTES} minutes for security.</p>
<p>Once verified, you'll have access to:</p>
<ul>
  <li><strong>Blazing-fast columnar queries</strong> — outperforms row-based databases on analytical workloads</li>
  <li><strong>Parquet-native storage</strong> — compact, efficient, and compatible with your existing data stack</li>
  <li><strong>Simple HTTP API</strong> — ingest and query data with a single curl command</li>
</ul>
<p style="color:#888;font-size:13px">Need help? Reply to this email or reach us at support@basekick.net</p>
<p>The Arc Launchpad team</p>`;

  await sendEmail(email, 'Verify your Arc Launchpad email', text, html);
}
