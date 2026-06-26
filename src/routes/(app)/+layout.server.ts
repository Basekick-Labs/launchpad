import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { resolveActiveOrg } from '$lib/server/activeOrg';

export const load: LayoutServerLoad = async ({ locals, cookies }) => {
  if (!locals.user) {
    throw redirect(302, '/login');
  }

  const db = getDb();
  const { org: activeOrg, role: currentRole, orgs } = resolveActiveOrg(locals.user.id, cookies);

  // MFA + Passkey data for settings page
  const userMfa = db.prepare('SELECT mfa_secret, mfa_enabled_at FROM users WHERE id = ?')
    .get(locals.user.id) as { mfa_secret: string | null; mfa_enabled_at: string | null } | undefined;
  const passkeys = db.prepare('SELECT id, name, created_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC')
    .all(locals.user.id) as Array<{ id: string; name: string; created_at: string }>;
  const recoveryCodesRow = db.prepare('SELECT COUNT(*) as count FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL')
    .get(locals.user.id) as { count: number };

  return {
    user: locals.user,
    organizations: orgs,
    activeOrg,
    currentRole: currentRole ?? 'viewer',
    domain: process.env.LAUNCHPAD_DOMAIN || 'arc.localhost',
    mfaEnabled: !!userMfa?.mfa_secret,
    mfaEnabledAt: userMfa?.mfa_enabled_at || null,
    passkeys,
    recoveryCodesRemaining: recoveryCodesRow?.count || 0,
  };
};
