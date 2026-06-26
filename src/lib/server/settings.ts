import { getDb } from './db';

// Generic key/value settings, JSON-encoded in the `settings` table.

export function getSetting<T = unknown>(key: string): T | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: unknown): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, JSON.stringify(value));
}

// ── Email configuration ──────────────────────────────────────────────────────

export type EmailConfig =
  | { provider: 'none' }
  | { provider: 'mailgun'; from: string; domain: string; apiKey: string; apiUrl?: string }
  | {
      provider: 'smtp';
      from: string;
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      pass?: string;
    };

const EMAIL_KEY = 'email';

/**
 * Resolve the active email config. Precedence:
 *   1. DB setting written by the wizard / admin page
 *   2. Env vars (MAILGUN_* / SMTP_*) for operators who prefer config-as-env
 *   3. { provider: 'none' } — emails are logged to the console
 */
export function getEmailConfig(): EmailConfig {
  const stored = getSetting<EmailConfig>(EMAIL_KEY);
  if (stored && stored.provider) return stored;

  // Env fallbacks (read lazily to avoid bundling-time env access).
  const env = process.env;
  if (env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN) {
    return {
      provider: 'mailgun',
      from: env.EMAIL_FROM || `Arc Launchpad <noreply@${env.MAILGUN_DOMAIN}>`,
      domain: env.MAILGUN_DOMAIN,
      apiKey: env.MAILGUN_API_KEY,
      apiUrl: env.MAILGUN_API_URL || 'https://api.mailgun.net',
    };
  }
  if (env.SMTP_HOST) {
    return {
      provider: 'smtp',
      from: env.EMAIL_FROM || 'Arc Launchpad <noreply@localhost>',
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ? parseInt(env.SMTP_PORT, 10) : 587,
      secure: env.SMTP_SECURE === 'true',
      user: env.SMTP_USER || undefined,
      pass: env.SMTP_PASS || undefined,
    };
  }
  return { provider: 'none' };
}

export function setEmailConfig(cfg: EmailConfig): void {
  setSetting(EMAIL_KEY, cfg);
}

/** True once at least one non-deleted user exists (setup wizard is then closed). */
export function hasAnyUser(): boolean {
  const db = getDb();
  const { count } = db
    .prepare('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL')
    .get() as { count: number };
  return count > 0;
}
