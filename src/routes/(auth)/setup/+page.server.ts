import { redirect, fail } from '@sveltejs/kit';
import { v4 as uuidv4 } from 'uuid';
import type { PageServerLoad, Actions } from './$types';
import { getDb } from '$lib/server/db';
import { hashPassword, createToken, sessionCookieOptions } from '$lib/server/auth';
import { hasAnyUser, setEmailConfig, type EmailConfig } from '$lib/server/settings';
import { sendTestEmail } from '$lib/server/email';

// First-run setup wizard. Available ONLY while no account exists; once the
// admin is created it is permanently closed (redirects to /login).
export const load: PageServerLoad = async () => {
  if (hasAnyUser()) throw redirect(302, '/login');
  return {};
};

function isStrongPassword(p: string): boolean {
  return (
    p.length >= 8 &&
    p.length <= 128 &&
    /[A-Z]/.test(p) &&
    (/[0-9]/.test(p) || /[!@#$%^&*()_\-+=\[\]{};':"\\|,.<>\/?]/.test(p))
  );
}

function parseEmailConfig(form: FormData): EmailConfig {
  const provider = String(form.get('email_provider') || 'none');
  if (provider === 'mailgun') {
    return {
      provider: 'mailgun',
      from: String(form.get('from') || '').trim(),
      domain: String(form.get('mg_domain') || '').trim(),
      apiKey: String(form.get('mg_api_key') || '').trim(),
      apiUrl: String(form.get('mg_api_url') || '').trim() || undefined,
    };
  }
  if (provider === 'smtp') {
    return {
      provider: 'smtp',
      from: String(form.get('from') || '').trim(),
      host: String(form.get('smtp_host') || '').trim(),
      port: parseInt(String(form.get('smtp_port') || '587'), 10),
      secure: form.get('smtp_secure') === 'on' || form.get('smtp_secure') === 'true',
      user: String(form.get('smtp_user') || '').trim() || undefined,
      pass: String(form.get('smtp_pass') || '') || undefined,
    };
  }
  return { provider: 'none' };
}

export const actions: Actions = {
  // Test the email config without creating the admin (used by the "Send test" button).
  testEmail: async ({ request }) => {
    if (hasAnyUser()) return fail(403, { error: 'Setup already completed.' });
    const form = await request.formData();
    const to = String(form.get('test_to') || '').trim();
    if (!to) return fail(400, { emailError: 'Enter an address to send the test to.' });
    const cfg = parseEmailConfig(form);
    if (cfg.provider === 'none') return fail(400, { emailError: 'Choose a provider first.' });
    try {
      await sendTestEmail(cfg, to);
      return { emailTested: true };
    } catch (err: any) {
      return fail(400, { emailError: `Test failed: ${err.message}` });
    }
  },

  // Create the first admin account (and persist email config if provided).
  complete: async ({ request, cookies }) => {
    if (hasAnyUser()) throw redirect(302, '/login');

    const form = await request.formData();
    const email = String(form.get('email') || '').trim().toLowerCase();
    const password = String(form.get('password') || '');
    const firstName = String(form.get('first_name') || '').trim() || null;
    const lastName = String(form.get('last_name') || '').trim() || null;

    if (!email || !password) return fail(400, { error: 'Email and password are required.', email });
    if (!isStrongPassword(password)) {
      return fail(400, {
        error: 'Password must be 8–128 chars with an uppercase letter and a number or symbol.',
        email,
      });
    }

    const db = getDb();

    // Persist email config first (best-effort; never blocks admin creation).
    const emailCfg = parseEmailConfig(form);
    if (emailCfg.provider !== 'none') {
      try {
        setEmailConfig(emailCfg);
      } catch (err) {
        console.error('[setup] failed to save email config:', err);
      }
    }

    const userId = uuidv4();
    const passwordHash = await hashPassword(password);

    // Race guard: re-check inside the write. UNIQUE(email) + the hasAnyUser
    // gate make a double-admin practically impossible, but be explicit.
    const create = db.transaction(() => {
      const { count } = db
        .prepare('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL')
        .get() as { count: number };
      if (count > 0) throw new Error('already_setup');

      db.prepare(
        'INSERT INTO users (id, email, password_hash, first_name, last_name, email_verified, is_operator) VALUES (?, ?, ?, ?, ?, 1, 1)',
      ).run(userId, email, passwordHash, firstName, lastName);

      const orgId = uuidv4();
      const displayName = [firstName, lastName].filter(Boolean).join(' ');
      const orgName = displayName ? `${displayName}'s Organization` : 'My Organization';
      db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(
        orgId,
        orgName,
        userId,
      );
      db.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')").run(
        orgId,
        userId,
      );
      return displayName;
    });

    let displayName = '';
    try {
      displayName = create();
    } catch (err: any) {
      if (err.message === 'already_setup') throw redirect(302, '/login');
      throw err;
    }

    const token = createToken({ userId, email, name: displayName });
    cookies.set('arc_session', token, sessionCookieOptions);
    throw redirect(303, '/dashboard');
  },
};
