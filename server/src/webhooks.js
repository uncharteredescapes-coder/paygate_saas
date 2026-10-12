'use strict';
// Webhook sender — PRD §5 "Merchant webhooks".
// Header PayGate-Signature: t=<unix>,v1=<hex> where v1 = HMAC-SHA256(secret, t + "." + rawBody).
// Retries at 10s, 1m, 5m, 30m, 2h, 6h, 24h, then failed with a Resend button.

const crypto = require('crypto');
const { db, nowIso } = require('./db');

const RETRY_DELAYS_MS = [10e3, 60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3, 6 * 3600e3, 24 * 3600e3];

function sign(secret, rawBody) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** Merchant-facing helper so docs/tests can verify signatures the same way. */
function verifySignature(secret, header, rawBody, maxAgeSec = 300) {
  const parts = Object.fromEntries(String(header || '').split(',').map(kv => kv.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > maxAgeSec) return false; // reject >5 min old
  const expect = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(parts.v1)); } catch { return false; }
}

async function attempt(id) {
  const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id=?').get(id);
  if (!row || row.status === 'delivered' || row.status === 'failed') return;
  const merchant = db.prepare('SELECT * FROM merchants WHERE id=?').get(row.merchant_id);
  // The plaintext secret is stored in webhook_secret_hash field for this dev build;
  // production stores hash + encrypted copy (PRD §6 rotation w/ 24h overlap).
  const secret = merchant.webhook_secret_hash || 'whsec_dev';
  let res, code = null, bodyText = '';
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    res = await fetch(row.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'PayGate-Signature': sign(secret, row.payload), 'PayGate-Event-Id': row.event_id },
      body: row.payload,
      signal: ctrl.signal,
    });
    clearTimeout(to);
    code = res.status; bodyText = (await res.text().catch(() => '')).slice(0, 500);
  } catch (e) { code = null; bodyText = String(e.message || e).slice(0, 500); }

  const ok = code != null && code >= 200 && code < 300;
  const attempts = row.attempts + 1;
  if (ok) {
    db.prepare(`UPDATE webhook_deliveries SET attempts=?, status='delivered', response_code=?, response_body=?, delivered_at=?, last_status='ok' WHERE id=?`)
      .run(attempts, code, bodyText, nowIso(), id);
  } else if (attempts - 1 < RETRY_DELAYS_MS.length) {
    const next = new Date(Date.now() + RETRY_DELAYS_MS[attempts - 1]).toISOString();
    db.prepare(`UPDATE webhook_deliveries SET attempts=?, status='queued', next_attempt_at=?, response_code=?, response_body=?, last_status='retry' WHERE id=?`)
      .run(attempts, next, code, bodyText, id);
  } else {
    db.prepare(`UPDATE webhook_deliveries SET attempts=?, status='failed', response_code=?, response_body=?, last_status='failed' WHERE id=?`)
      .run(attempts, code, bodyText, id);
  }
}

let timer = null;
function startSenderLoop() {
  if (timer) return;
  timer = setInterval(() => {
    const due = db.prepare(`SELECT id FROM webhook_deliveries WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=?) LIMIT 20`).all(nowIso());
    for (const d of due) attempt(d.id).catch(() => {});
  }, 3000);
  timer.unref?.();
}

function resend(id) {
  db.prepare(`UPDATE webhook_deliveries SET status='queued', next_attempt_at=?, attempts=0 WHERE id=? AND status IN ('failed','delivered','queued')`).run(nowIso(), id);
  attempt(id).catch(() => {});
}

module.exports = { startSenderLoop, attempt, resend, sign, verifySignature, RETRY_DELAYS_MS };
