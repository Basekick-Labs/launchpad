import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { verifyToken } from '$lib/server/auth';
import { getDb } from '$lib/server/db';
import { purgeExpiredInstances, refreshAllInstanceHealth } from '$lib/server/instance';
import { evaluateAlerts } from '$lib/server/alertEvaluator';
import { notifyOps, cleanupAlertDedup } from '$lib/server/gchatAlert';

// The public base for server-issued redirects. Behind a reverse proxy (or when
// the browser has upgraded us to HTTPS via HSTS), `event.url.origin` is derived
// from request headers and can come out as the wrong scheme/port — e.g.
// `https://localhost` with no port. When the operator has set LAUNCHPAD_BASE_URL,
// trust that instead so redirects land on the URL the deployment is actually
// served from. Fall back to the request origin when it's unset.
const CONFIGURED_BASE_URL = (() => {
  const raw = env.LAUNCHPAD_BASE_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    console.warn(`[hooks] LAUNCHPAD_BASE_URL is not a valid URL: ${raw}`);
    return null;
  }
})();

function redirectTo(path: string, event: { url: URL }): Response {
  const base = CONFIGURED_BASE_URL ?? event.url.origin;
  return Response.redirect(new URL(path, base).toString(), 302);
}

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
    return redirectTo('/setup', event);
  }
  // Once setup is complete, the wizard page is gone — redirect it to login.
  // (Its sub-routes like /setup/test-email return their own 403, so only the
  // page itself is redirected.)
  if (hasUser && path === '/setup') {
    return redirectTo('/login', event);
  }

  const response = await resolve(event);

  // Security headers. CSP is configured in svelte.config.js (kit.csp) so
  // SvelteKit can hash its own inline hydration scripts.
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  // Only advertise HSTS on genuinely-HTTPS deployments. Sending it on a plain-HTTP
  // deployment (e.g. http://localhost:3000) makes the browser permanently upgrade
  // requests to https://, which then fails — the classic "redirected to
  // https://localhost" trap. Gate on the configured base URL's scheme, falling
  // back to the request/forwarded protocol.
  const isHttps =
    (CONFIGURED_BASE_URL ?? '').startsWith('https:') ||
    (!CONFIGURED_BASE_URL &&
      (event.url.protocol === 'https:' ||
        event.request.headers.get('x-forwarded-proto') === 'https'));
  if (isHttps) {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  return response;
};
