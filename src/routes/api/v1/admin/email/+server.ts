import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEmailConfig, setEmailConfig, type EmailConfig } from '$lib/server/settings';
import { sendTestEmail } from '$lib/server/email';

function requireAdmin(locals: App.Locals): Response | null {
  if (!locals.user?.is_operator) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}

// Return the current config with secrets masked.
export const GET: RequestHandler = async ({ locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;

  const cfg = getEmailConfig();
  const masked: Record<string, unknown> = { provider: cfg.provider };
  if (cfg.provider === 'mailgun') {
    masked.from = cfg.from;
    masked.domain = cfg.domain;
    masked.apiUrl = cfg.apiUrl;
    masked.apiKeySet = !!cfg.apiKey;
  } else if (cfg.provider === 'smtp') {
    masked.from = cfg.from;
    masked.host = cfg.host;
    masked.port = cfg.port;
    masked.secure = cfg.secure;
    masked.user = cfg.user;
    masked.passSet = !!cfg.pass;
  }
  return json({ email: masked });
};

function coerce(body: any): EmailConfig {
  const provider = body?.provider;
  if (provider === 'mailgun') {
    return {
      provider: 'mailgun',
      from: String(body.from || '').trim(),
      domain: String(body.domain || '').trim(),
      apiKey: String(body.apiKey || '').trim(),
      apiUrl: body.apiUrl ? String(body.apiUrl).trim() : undefined,
    };
  }
  if (provider === 'smtp') {
    return {
      provider: 'smtp',
      from: String(body.from || '').trim(),
      host: String(body.host || '').trim(),
      port: parseInt(String(body.port || '587'), 10),
      secure: !!body.secure,
      user: body.user ? String(body.user).trim() : undefined,
      pass: body.pass ? String(body.pass) : undefined,
    };
  }
  return { provider: 'none' };
}

// Persist a new config.
export const PUT: RequestHandler = async ({ locals, request }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;

  const cfg = coerce(await request.json());

  // If updating an existing provider without re-sending the secret, keep the old one.
  if (cfg.provider === 'mailgun' && !cfg.apiKey) {
    const cur = getEmailConfig();
    if (cur.provider === 'mailgun') cfg.apiKey = cur.apiKey;
  }
  if (cfg.provider === 'smtp' && !cfg.pass) {
    const cur = getEmailConfig();
    if (cur.provider === 'smtp') cfg.pass = cur.pass;
  }

  setEmailConfig(cfg);
  return json({ ok: true });
};

// Send a test email using either the posted config or the saved one.
export const POST: RequestHandler = async ({ locals, request }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;

  const body = await request.json();
  const to = String(body?.to || '').trim();
  if (!to) return json({ error: 'Recipient address required' }, { status: 400 });

  const cfg = body?.provider ? coerce(body) : getEmailConfig();
  if (cfg.provider === 'none') {
    return json({ error: 'No email provider configured' }, { status: 400 });
  }
  try {
    await sendTestEmail(cfg, to);
    return json({ ok: true });
  } catch (err: any) {
    return json({ error: err.message }, { status: 400 });
  }
};
