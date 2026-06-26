import type { Handle } from '@sveltejs/kit';
import { verifyToken } from '$lib/server/auth';
import { getDb } from '$lib/server/db';
import { purgeExpiredInstances, refreshAllInstanceHealth } from '$lib/server/instance';
import { evaluateAlerts } from '$lib/server/alertEvaluator';
import { notifyOps, cleanupAlertDedup } from '$lib/server/gchatAlert';

function runJob(name: string, fn: () => Promise<unknown>): Promise<void> {
  return fn().then(() => {}).catch((err: any) => {
    console.error(`[${name}] background job failed:`, err);
    const errorKind = err?.code ?? err?.name ?? 'error';
    const message = err instanceof Error ? err.message : String(err);
    void notifyOps({
      source: 'background-job',
      dedupKey: `${name}:${errorKind}`,
      title: `Background job '${name}' failed`,
      details: { error: message },
    });
  });
}

// Purge soft-deleted connection rows + alert dedup cleanup — runs every 6 hours
let purgeJobStarted = false;
if (!purgeJobStarted) {
  purgeJobStarted = true;
  const purgeAndCleanup = async () => {
    purgeExpiredInstances();
    try { cleanupAlertDedup(); } catch (err) { console.error('[purge] cleanupAlertDedup failed:', err); }
  };
  setTimeout(() => {
    runJob('purge', purgeAndCleanup);
    setInterval(() => runJob('purge', purgeAndCleanup), 6 * 60 * 60 * 1000);
  }, 30_000);
}

// Health-check every connected Arc server — runs every 60 seconds
let healthJobStarted = false;
if (!healthJobStarted) {
  healthJobStarted = true;
  setTimeout(() => {
    runJob('health', refreshAllInstanceHealth);
    setInterval(() => runJob('health', refreshAllInstanceHealth), 60_000);
  }, 15_000);
}

// Start alert evaluation job — runs every 60 seconds
let alertJobStarted = false;
if (!alertJobStarted) {
  alertJobStarted = true;
  setTimeout(() => {
    runJob('alert-eval', evaluateAlerts);
    setInterval(() => runJob('alert-eval', evaluateAlerts), 60_000);
  }, 120_000);
}

export const handle: Handle = async ({ event, resolve }) => {
  // Extract JWT from cookie
  const token = event.cookies.get('arc_session');

  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      // Load fresh user data from DB (handles deleted accounts + name changes)
      const db = getDb();
      const dbUser = db.prepare('SELECT id, email, first_name, last_name, token_version, is_operator, suspended_at, deleted_at FROM users WHERE id = ?').get(payload.userId) as { id: string; email: string; first_name: string | null; last_name: string | null; token_version: number; is_operator: number; suspended_at: string | null; deleted_at: string | null } | undefined;
      if (dbUser && (dbUser.token_version ?? 0) === (payload.tv ?? 0) && !dbUser.suspended_at && !dbUser.deleted_at) {
        event.locals.user = {
          id: dbUser.id,
          email: dbUser.email,
          first_name: dbUser.first_name || '',
          last_name: dbUser.last_name || '',
          is_operator: !!dbUser.is_operator,
        };
      } else {
        event.cookies.delete('arc_session', { path: '/' });
        event.locals.user = null;
      }
    } else {
      // Invalid token — clear cookie
      event.cookies.delete('arc_session', { path: '/' });
      event.locals.user = null;
    }
  } else {
    event.locals.user = null;
  }

  // First-run bootstrap: if the database has no users yet, funnel everyone to the
  // setup wizard so the first admin account can be created. Allow the wizard page,
  // its form actions, and static assets through.
  const path = event.url.pathname;
  const db = getDb();
  const hasUser = db.prepare('SELECT 1 FROM users WHERE deleted_at IS NULL LIMIT 1').get();

  const onSetup = path === '/setup' || path.startsWith('/setup/');
  const firstRunAllowed =
    onSetup ||
    path.startsWith('/_app/') ||
    path.startsWith('/images/') ||
    path === '/favicon.ico';
  if (!hasUser && !firstRunAllowed) {
    return Response.redirect(new URL('/setup', event.url.origin).toString(), 302);
  }
  // Once setup is complete, the wizard page is gone — redirect it to login.
  // (Its sub-routes like /setup/test-email return their own 403, so only the
  // page itself is redirected.)
  if (hasUser && path === '/setup') {
    return Response.redirect(new URL('/login', event.url.origin).toString(), 302);
  }

  const response = await resolve(event);

  // Security headers
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  return response;
};
