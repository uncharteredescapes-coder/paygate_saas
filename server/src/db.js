'use strict';
// Database layer — Supabase Postgres schema translated to SQLite for local dev.
// Conventions (PRD §5): timestamptz as ISO strings, amounts as integer paisa, prefixed text IDs,
// indexes on payments(reference), incoming_txns(ref_normalized), payments(merchant_id,status,created_at).

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.PAYGATE_DB || path.join(__dirname, '..', 'paygate.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function nowIso() { return new Date().toISOString(); }

db.exec(`
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  kyb_status TEXT NOT NULL DEFAULT 'unverified',
  payout_account TEXT, fee_rate_bps INTEGER NOT NULL DEFAULT 500,
  risk_tier TEXT NOT NULL DEFAULT 'standard',
  webhook_secret_hash TEXT, webhook_url TEXT, auto_confirm INTEGER NOT NULL DEFAULT 0,
  high_value_confirm_paisa INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
  key_prefix TEXT NOT NULL, key_hash TEXT NOT NULL, mode TEXT NOT NULL, -- live|test
  created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS pricing_plans (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
  name TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'BDT',
  external_sku TEXT, version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active', open_amount INTEGER NOT NULL DEFAULT 0,
  min_amount INTEGER, max_amount INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, msisdn TEXT NOT NULL,
  holder_name TEXT, device_id TEXT, sim_slot INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',          -- active|draining|paused|frozen
  daily_limit INTEGER NOT NULL DEFAULT 2500000, monthly_limit INTEGER NOT NULL DEFAULT 25000000,
  today_total INTEGER NOT NULL DEFAULT 0, month_total INTEGER NOT NULL DEFAULT 0,
  concurrency_cap INTEGER NOT NULL DEFAULT 5, last_assigned_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT, model TEXT, app_version TEXT,
  token_hash TEXT, pairing_code_hash TEXT, status TEXT NOT NULL DEFAULT 'paired',
  last_heartbeat_at TEXT, battery INTEGER, queue_depth INTEGER DEFAULT 0, permissions TEXT,
  revoked_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
  plan_id TEXT, plan_snapshot TEXT, order_id TEXT, provider TEXT NOT NULL,
  wallet_id TEXT, offered_wallet_ids TEXT NOT NULL,
  amount INTEGER NOT NULL, fee_amount INTEGER, net_amount INTEGER,
  reference TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'created',
  review_reason TEXT, matched_by TEXT, submitted_trx_id TEXT,
  confirm_attempts INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
  confirmed_at TEXT, idempotency_key TEXT, success_url TEXT, cancel_url TEXT, callback_url TEXT,
  metadata TEXT, expires_at TEXT NOT NULL, paid_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference);
CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_idem ON payments(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS incoming_txns (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, trx_id TEXT, wallet_id TEXT,
  amount INTEGER, balance_after INTEGER, ref_raw TEXT, ref_normalized TEXT,
  raw TEXT, client_msg_id TEXT, sim_slot INTEGER, device_id TEXT,
  claimed_payment_id TEXT, flags TEXT, parser_version TEXT,
  sms_received_at TEXT, server_received_at TEXT NOT NULL, received_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_incoming_dedupe ON incoming_txns(client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_incoming_trx ON incoming_txns(provider, trx_id, wallet_id) WHERE trx_id IS NOT NULL AND wallet_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_incoming_ref ON incoming_txns(ref_normalized);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY, merchant_id TEXT, payment_id TEXT, payout_id TEXT,
  entry_type TEXT NOT NULL,   -- pay_in|fee|merchant_payable|payout|refund_record
  amount INTEGER NOT NULL,    -- signed paisa against merchant payable balance
  description TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchants(id),
  amount INTEGER NOT NULL, method TEXT NOT NULL, destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval',   -- pending_approval|approved_by_maker|paid|rejected
  requested_by TEXT, approved_by TEXT, executed_by TEXT, note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL, payment_id TEXT, payload TEXT NOT NULL,
  url TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT, last_status TEXT, response_code INTEGER, response_body TEXT,
  status TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL, delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
  object_type TEXT, object_id TEXT, before TEXT, after TEXT, ip TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff', totp_secret TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, kind TEXT NOT NULL, -- staff
  user_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
`);

// ---- helpers -------------------------------------------------------------
function hash(s) {
  const c = require('crypto');
  return c.createHash('sha256').update(String(s)).digest('hex');
}
function uid(prefix) {
  const c = require('crypto');
  return prefix + '_' + c.randomBytes(9).toString('base64url'); // prefixed text IDs
}

function audit(actor, action, objectType, objectId, before, after, ip) {
  db.prepare(`INSERT INTO audit_log (id,actor,action,object_type,object_id,before,after,ip,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(uid('aud'), actor, action, objectType || null, objectId || null,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, ip || null, nowIso());
}

module.exports = { db, nowIso, hash, uid, audit, DB_PATH };
