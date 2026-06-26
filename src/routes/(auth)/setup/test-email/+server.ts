import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { hasAnyUser, type EmailConfig } from '$lib/server/settings';
import { sendTestEmail } from '$lib/server/email';

// Client-side test-email endpoint for the setup wizard. Available only during
// first-run (no users yet); once an admin exists, use Settings → Email instead.
export const POST: RequestHandler = async ({ request }) => {
  if (hasAnyUser()) {
    return json({ error: 'Setup already completed.' }, { status: 403 });
  }

  const body = await request.json();
  const to = String(body?.to || '').trim();
  if (!to) return json({ error: 'Enter an address to send the test to.' }, { status: 400 });

  let cfg: EmailConfig;
  if (body.provider === 'smtp') {
    cfg = {
      provider: 'smtp',
      from: String(body.from || '').trim(),
      host: String(body.host || '').trim(),
      port: parseInt(String(body.port || '587'), 10),
      secure: !!body.secure,
      user: body.user ? String(body.user).trim() : undefined,
      pass: body.pass ? String(body.pass) : undefined,
    };
  } else if (body.provider === 'mailgun') {
    cfg = {
      provider: 'mailgun',
      from: String(body.from || '').trim(),
      domain: String(body.domain || '').trim(),
      apiKey: String(body.apiKey || '').trim(),
      apiUrl: body.apiUrl ? String(body.apiUrl).trim() : undefined,
    };
  } else {
    return json({ error: 'Choose a provider first.' }, { status: 400 });
  }

  try {
    await sendTestEmail(cfg, to);
    return json({ ok: true });
  } catch (err: any) {
    return json({ error: `Test failed: ${err.message}` }, { status: 400 });
  }
};
