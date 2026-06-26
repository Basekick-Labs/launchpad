import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.LAUNCHPAD_DB_PATH || path.join(process.cwd(), 'data', 'launchpad.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  }
  return db;
}

// Fresh-install schema. Arc Launchpad creates its SQLite database on first
// run; there is no upgrade path from older databases, so this is a single
// flat set of CREATE TABLE statements rather than an incremental migration
// chain. Every column here is used by current code — the cloud/billing
// schema (tiers, stripe, k8s resource limits) has been removed.
function runMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      first_name TEXT,
      last_name TEXT,
      email_verified INTEGER DEFAULT 0,
      github_id TEXT,
      google_id TEXT,
      token_version INTEGER DEFAULT 0,
      is_operator INTEGER DEFAULT 0,
      mfa_secret TEXT,
      mfa_enabled_at TEXT,
      suspended_at TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS org_members (
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (org_id, user_id)
    );

    -- A "connection" to an existing Arc server: its base URL + an admin token.
    -- status reflects the last reachability probe (e.g. 'running', 'unreachable').
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id),
      resource_id TEXT NOT NULL UNIQUE,
      name TEXT,
      endpoint_url TEXT,
      status TEXT,
      arc_version TEXT,
      admin_token TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      suspended_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS instance_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL REFERENCES instances(id),
      event_type TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Key/value application settings written by the setup wizard / admin
    -- (e.g. email transport config). Values are JSON-encoded strings.
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS org_invitations (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      token TEXT NOT NULL UNIQUE,
      invited_by TEXT NOT NULL REFERENCES users(id),
      grant_operator INTEGER DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS operator_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'My Passkey',
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auth_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      challenge TEXT NOT NULL,
      type TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      condition TEXT NOT NULL,
      threshold TEXT NOT NULL,
      check_interval TEXT NOT NULL,
      webhook_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT,
      last_value TEXT,
      last_error TEXT,
      triggered_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alert_executions (
      id TEXT PRIMARY KEY,
      alert_rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
      triggered_at TEXT NOT NULL,
      value TEXT,
      message TEXT
    );

    CREATE TABLE IF NOT EXISTS alert_dedup (
      source TEXT NOT NULL,
      dedup_key TEXT NOT NULL,
      last_sent_at TEXT NOT NULL,
      PRIMARY KEY (source, dedup_key)
    );

    CREATE INDEX IF NOT EXISTS idx_instances_org ON instances(org_id);
    CREATE INDEX IF NOT EXISTS idx_instances_resource_id ON instances(resource_id);
    CREATE INDEX IF NOT EXISTS idx_instance_events_instance ON instance_events(instance_id);
    CREATE INDEX IF NOT EXISTS idx_email_verify_user ON email_verification_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_org_invitations_token ON org_invitations(token);
    CREATE INDEX IF NOT EXISTS idx_org_invitations_org ON org_invitations(org_id);
    CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_operator ON operator_audit_log(operator_id);
    CREATE INDEX IF NOT EXISTS idx_audit_target ON operator_audit_log(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user ON mfa_recovery_codes(user_id);
    CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth_challenges(expires_at);
    CREATE INDEX IF NOT EXISTS idx_alert_rules_instance_id ON alert_rules(instance_id);
    CREATE INDEX IF NOT EXISTS idx_alert_executions_rule_id ON alert_executions(alert_rule_id);
    CREATE INDEX IF NOT EXISTS idx_alert_dedup_last_sent ON alert_dedup(last_sent_at);
  `);
}
