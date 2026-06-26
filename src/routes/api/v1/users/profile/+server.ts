import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { sendVerificationEmail } from '$lib/server/email';

export const PATCH: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { first_name, last_name, email } = body;

  const db = getDb();
  const emailChanged = email && email.trim().toLowerCase() !== locals.user.email.toLowerCase();

  // Validate email uniqueness if changing
  if (emailChanged) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email.trim(), locals.user.id);
    if (existing) {
      return json({ error: 'Email already in use' }, { status: 409 });
    }
  }

  const updates: string[] = [];
  const params: any[] = [];

  if (first_name !== undefined) {
    updates.push('first_name = ?');
    params.push(first_name.trim() || null);
  }
  if (last_name !== undefined) {
    updates.push('last_name = ?');
    params.push(last_name.trim() || null);
  }
  if (emailChanged) {
    updates.push('email = ?');
    params.push(email.trim());
    // Reset verification — user must re-verify the new address
    updates.push('email_verified = 0');
  }

  if (updates.length === 0) {
    return json({ error: 'No fields to update' }, { status: 400 });
  }

  updates.push("updated_at = datetime('now')");
  params.push(locals.user.id);

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // Send verification email to the new address
  if (emailChanged) {
    sendVerificationEmail(email.trim(), locals.user.id).catch(console.error);
  }

  const user = db.prepare('SELECT id, email, first_name, last_name, email_verified FROM users WHERE id = ?').get(locals.user.id) as any;

  return json({
    user: { id: user.id, email: user.email, first_name: user.first_name || '', last_name: user.last_name || '' },
    emailVerificationSent: !!emailChanged,
  });
};
