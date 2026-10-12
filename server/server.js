'use strict';
// PayGate Platform server — PRD v3.0 merchant SaaS API + hosted pay page + consoles.
// Single backend (route handlers), one database (SQLite standing in for Supabase Postgres).

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const { db, nowIso, hash, uid, audit } = require('./src/db');
const refs = require('./src/references');
const sms = require('./src/smsParser');
const wallets = require('./src/wallets');
const matching = require('./src/matching');
const hooks = require('./src/webhooks');
const { seed } = require('./src/seed');

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;
const BASE = process.env.PAYGATE_BASE_URL || `http://localhost:${PORT}`;

// ---- tiny rate limiter (PRD: public pay 10/min/IP, device ingest 60/min) ----
const buckets = new Map();
function rateLimit(limit, windowMs) {
  return (req, res, next) => {
    const key = req.ip + '|' + req.path;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
    b.n++;
    if (b.n > limit) return res.status(429).json({ error: 'rate_limited' });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.start > 120000) buckets.delete(k); }, 60000).unref?.();

// ---- auth helpers ----------------------------------------------------------
function merchantFromKey(req, res) {
  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!key) { res.status(401).json({ error: 'unauthorized', message: 'Provide Authorization: Bearer sk_live_… or sk_test_…' }); return null; }
  const mode = key.startsWith('sk_test_') ? 'test' : 'live';
  const row = db.prepare('SELECT k.*, m.* FROM api_keys k JOIN merchants m ON m.id=k.merchant_id WHERE k.key_hash=? AND k.revoked_at IS NULL').get(hash(key));
  if (!row) { res.status(401).json({ error: 'invalid_api_key' }); return null; }
  if (row.status !== 'active') { res.status(403).json({ error: 'merchant_inactive' }); return null; }
  req.merchant = { id: row.merchant_id, name: row.name, fee_rate_bps: row.fee_rate_bps, mode, auto_confirm: row.auto_confirm };
  return req.merchant;
}

function staffFromSession(req, res) {
  const tok = (req.headers['x-staff-token'] || '').trim();
  if (!tok) { res.status(401).json({ error: 'staff_login_required' }); return null; }
  const s = db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?').get(hash(tok), nowIso());
  if (!s) { res.status(401).json({ error: 'session_expired' }); return null; }
  const u = db.prepare('SELECT * FROM staff_users WHERE id=?').get(s.user_id);
  if (!u) { res.status(401).json({ error: 'staff_login_required' }); return null; }
  req.staff = u;
  return u;
}

function deviceFromToken(req, res) {
  const tok = req.headers['x-device-token'] || '';
  const d = db.prepare('SELECT * FROM devices WHERE token_hash=?').get(hash(tok));
  if (!d || d.revoked_at) { res.status(401).json({ error: 'revoked' }); return null; }
  req.device = d;
  return d;
}

// payment JSON for API responses
function paymentJson(p, { includePayUrl = true } = {}) {
  const wallet = p.wallet_id ? db.prepare('SELECT * FROM wallets WHERE id=?').get(p.wallet_id) : null;
  const j = {
    id: p.id, object: 'payment', status: p.status, provider: p.provider,
    amount: p.amount, currency: 'BDT', reference: p.reference,
    plan_id: p.plan_id, order_id: p.order_id, review_reason: p.review_reason,
    matched_by: p.matched_by, fee_amount: p.fee_amount, net_amount: p.net_amount,
    wallet: wallet ? { provider: wallet.provider, number: wallet.msisdn, holder_name: wallet.holder_name } : null,
    created_at: p.created_at, expires_at: p.expires_at, paid_at: p.paid_at,
    metadata: p.metadata ? JSON.parse(p.metadata) : null,
  };
  if (includePayUrl) j.pay_url = `${BASE}/pay/${p.id}`;
  return j;
}

// ================= MERCHANT API (/v1) =====================================
const v1 = express.Router();

// --- Plans: create, list, patch (edit = new version) ---
v1.post('/plans', (req, res) => {
  const m = merchantFromKey(req, res); if (!m) return;
  const { name, amount, external_sku, open_amount = false, min_amount, max_amount } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(422).json({ error: 'invalid_plan', message: 'name required' });
  if (!open_amount && !(Number.isInteger(amount) && amount > 0)) return res.status(422).json({ error: 'invalid_plan', message: 'amount must be a positive integer in paisa (or set open_amount)' });
  if (open_amount && !(min_amount > 0 && max_amount >= min_amount)) return res.status(422).json({ error: 'invalid_plan', message: 'open plans need min_amount and max_amount (paisa)' });
  const id = uid('pln');
  db.prepare(`INSERT INTO pricing_plans (id,merchant_id,name,amount,currency,external_sku,version,status,open_amount,min_amount,max_amount,created_at)
              VALUES (?,?,?,?,'BDT',?,1,'active',?,?,?,?,?)`)
    .run(id, m.id, name, open_amount ? 0 : amount, external_sku || null, open_amount ? 1 : 0, min_amount || null, max_amount || null, nowIso());
  res.status(201).json(db.prepare('SELECT * FROM pricing_plans WHERE id=?').get(id));
});

v1.get('/plans', (req, res) => {
  const m = merchantFromKey(req, res); if (!m) return;
  res.json({ data: db.prepare('SELECT * FROM pricing_plans WHERE merchant_id=? ORDER BY created_at DESC').all(m.id) });
});

v1.patch('/plans/:id', (req, res) => {
  const m = merchantFromKey(req, res); if (!m) return;
  const cur = db.prepare('SELECT * FROM pricing_plans WHERE id=? AND merchant_id=?').get(req.params.id, m.id);
  if (!cur) return res.status(404).json({ error: 'plan_not_found' });
  // Editing a plan creates a NEW VERSION; old version archived; payments in flight keep snapshots.
  const { name, amount, external_sku, status, min_amount, max_amount, open_amount } = req.body || {};
  if (status === 'archived') {
    db.prepare(`UPDATE pricing_plans SET status='archived' WHERE id=?`).run(cur.id);
    return res.json({ ...cur, status: 'archived' });
  }
  const newId = uid('pln');
  db.prepare(`INSERT INTO pricing_plans (id,merchant_id,name,amount,currency,external_sku,version,status,open_amount,min_amount,max_amount,created_at)
              VALUES (?,?,?,?,'BDT',?,?, 'active',?,?,?,?,?)`)
    .run(newId, m.id, name ?? cur.name, open_amount === true ? 0 : (amount ?? cur.amount),
      external_sku ?? cur.external_sku, cur.version + 1,
      open_amount != null ? (open_amount ? 1 : 0) : cur.open_amount,
      min_amount ?? cur.min_amount, max_amount ?? cur.max_amount, nowIso());
  db.prepare(`UPDATE pricing_plans SET status='archived' WHERE id=?`).run(cur.id);
  res.status(201).json(db.prepare('SELECT * FROM pricing_plans WHERE id=?').get(newId));
});

// --- Payments ---
v1.post('/payments', (req, res) => {
  const m = merchantFromKey(req, res); if (!m) return;
  const idem = req.headers['idempotency-key'] || req.body?.idempotency_key || null;
  const { plan_id, order_id, provider, success_url, cancel_url, callback_url, metadata, amount } = req.body || {};
  if (idem) {
    const prev = db.prepare('SELECT * FROM payments WHERE merchant_id=? AND idempotency_key=?').get(m.id, idem);
    if (prev) return res.json(paymentJson(prev)); // replay same result
  }
  const prov = String(provider || '').toUpperCase();
  if (!['BKASH', 'NAGAD', 'ROCKET'].includes(prov)) return res.status(422).json({ error: 'invalid_provider', message: 'provider must be BKASH | NAGAD | ROCKET' });

  let amt = null, plan = null, snapshot = null;
  if (plan_id) {
    plan = db.prepare(`SELECT * FROM pricing_plans WHERE id=? AND merchant_id=? AND status='active'`).get(plan_id, m.id);
    if (!plan) return res.status(422).json({ error: 'plan_not_found_or_archived' });
    if (plan.open_amount) {
      amt = Number(amount);
      if (!Number.isInteger(amt) || amt < plan.min_amount || amt > plan.max_amount)
        return res.status(422).json({ error: 'amount_out_of_range', message: `open plan allows ${plan.min_amount}..${plan.max_amount} paisa` });
    } else {
      amt = plan.amount; // server sets the amount; a client can never change it
    }
    snapshot = { id: plan.id, name: plan.name, amount: amt, version: plan.version, external_sku: plan.external_sku };
  } else {
    return res.status(422).json({ error: 'plan_id_required' });
  }

  const offered = wallets.offerWallets(prov, amt, 2);
  if (offered.length === 0) return res.status(503).json({ error: 'no_wallet_available' });
  const primary = offered[0];

  // single-use references, never reused
  let reference;
  do { reference = refs.generateReference(); }
  while (db.prepare('SELECT 1 FROM payments WHERE reference=?').get(reference));

  const id = uid('pay');
  const ttlMs = 30 * 60 * 1000;
  db.prepare(`INSERT INTO payments (id,merchant_id,plan_id,plan_snapshot,order_id,provider,wallet_id,offered_wallet_ids,
      amount,reference,status,idempotency_key,success_url,cancel_url,callback_url,metadata,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'awaiting_payment', ?,?,?,?,?,?,?)`)
    .run(id, m.id, plan.id, JSON.stringify(snapshot), order_id || null, prov, primary.id,
      JSON.stringify(offered.map(w => w.id)), amt, reference,
      idem, success_url || null, cancel_url || null, callback_url || null,
      metadata ? JSON.stringify(metadata) : null,
      new Date(Date.now() + ttlMs).toISOString(), nowIso());
  wallets.markAssigned(primary.id);
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(id);
  res.status(201).json({
    ...paymentJson(p),
    wallet: { provider: primary.provider, number: primary.msisdn, holder_name: primary.holder_name },
  });
});

function loadMerchantPayment(req, res) {
  const m = merchantFromKey(req, res); if (!m) return null;
  const p = db.prepare('SELECT * FROM payments WHERE id=? AND merchant_id=?').get(req.params.id, m.id);
  if (!p) { res.status(404).json({ error: 'payment_not_found' }); return null; }
  return p;
}

v1.get('/payments', (req, res) => {
  const m = merchantFromKey(req, res); if (!m) return;
  const { status, limit = 50, offset = 0 } = req.query;
  const rows = db.prepare(`SELECT * FROM payments WHERE merchant_id=? AND (?='' OR status=?)
      ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(m.id, status || '', status || '', Math.min(+limit, 200), +offset);
  res.json({ data: rows.map(p => paymentJson(p, { includePayUrl: false })) });
});

v1.get('/payments/:id', (req, res) => {
  const p = loadMerchantPayment(req, res); if (!p) return;
  res.json(paymentJson(p, { includePayUrl: false }));
});

v1.post('/payments/:id/cancel', (req, res) => {
  const p = loadMerchantPayment(req, res); if (!p) return;
  if (['paid'].includes(p.status)) return res.status(409).json({ error: 'already_paid' });
  if (['expired', 'cancelled'].includes(p.status)) return res.json(paymentJson(p));
  db.prepare(`UPDATE payments SET status='cancelled' WHERE id=?`).run(p.id);
  matching.queueWebhook(p, 'payment.cancelled', {});
  audit(`api:${m2id(req)}`, 'payment.cancel', 'payment', p.id, { status: p.status }, { status: 'cancelled' }, req.ip);
  res.json(paymentJson(db.prepare('SELECT * FROM payments WHERE id=?').get(p.id)));
});
const m2id = (req) => req.merchant?.id || 'anon';

// --- Money views: balance, settlements, payouts (min Tk 1,000 = 100000 paisa) ---
function merchantBalancePaisa(merchantId) {
  return db.prepare('SELECT COALESCE(SUM(amount),0) b FROM ledger_entries WHERE merchant_id=?').get(merchantId).b;
}

v1.get('/balance', (req, res) => {
  const m = merchantFromKey(req, res); if (!m) return;
  const bal = merchantBalancePaisa(m.id);
  const pendingPayouts = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE merchant_id=? AND status IN ('pending_approval','approved_by_maker')`).get(m.id).s;
  const available = bal - pendingPayouts;
  res.json({
    available_balance: Math.max(available, 0), pending_payouts: pendingPayouts, lifetime_net: bal,
    currency: 'BDT', minimum_payout: 100000, can_request_payout: available >= 100000,
  });
});

v1.get('/settlements', (req, res) => {
  const m = merchantFromKey(req, res); if (!m) return;
  const entries = db.prepare('SELECT * FROM ledger_entries WHERE merchant_id=? ORDER BY created_at DESC LIMIT 200').all(m.id);
  const payouts = db.prepare('SELECT * FROM payouts WHERE merchant_id=? ORDER BY created_at DESC').all(m.id);
  res.json({ ledger: entries, payouts });
});

v1.get('/settlements/export.csv', (req, res) => {
  const m = merchantFromKey(req, res); if (!m) return;
  const rows = db.prepare('SELECT * FROM ledger_entries WHERE merchant_id=? ORDER BY created_at').all(m.id);
  const csv = ['id,entry_type,amount_paisa,payment_id,created_at,description']
    .concat(rows.map(r => [r.id, r.entry_type, r.amount, r.payment_id || '', r.created_at, `"${(r.description || '').replace(/"/g, '""')}"`].join(',')))
    .join('\n');
  res.header('Content-Type', 'text/csv').send(csv);
});

v1.post('/payouts', (req, res) => {
  const m = merchantFromKey(req, res); if (!m) return;
  const avail = merchantBalancePaisa(m.id) - db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE merchant_id=? AND status IN ('pending_approval','approved_by_maker')`).get(m.id).s;
  if (avail < 100000) return res.status(422).json({ error: 'below_minimum', message: 'Available balance must reach Tk 1,000 (100000 paisa) before a payout can be requested', available: Math.max(avail, 0) });
  const acc = m.id ? JSON.parse(db.prepare('SELECT payout_account FROM merchants WHERE id=?').get(m.id).payout_account || 'null') : null;
  if (!acc) return res.status(422).json({ error: 'no_payout_account' });
  const id = uid('po');
  db.prepare(`INSERT INTO payouts (id,merchant_id,amount,method,destination,status,requested_by,created_at)
              VALUES (?,?,?,?,?,'pending_approval',?,?)`)
    .run(id, m.id, avail, acc.method, JSON.stringify(acc), `api`, nowIso());
  audit(`api:${m.id}`, 'payout.request', 'payout', id, null, { amount: avail }, req.ip);
  res.status(201).json(db.prepare('SELECT * FROM payouts WHERE id=?').get(id));
});

// --- Sandbox: simulated SMS tool (P1) ---
v1.post('/sandbox/simulate-sms', (req, res) => {
  const m = merchantFromKey(req, res); if (!m) return;
  if (req.merchant.mode !== 'test') return res.status(403).json({ error: 'sandbox_only', message: 'use an sk_test_ key' });
  const { payment_id, trx_id, amount, with_reference = true, wrong_wallet = false } = req.body || {};
  const p = db.prepare('SELECT * FROM payments WHERE id=? AND merchant_id=?').get(payment_id, m.id);
  if (!p) return res.status(404).json({ error: 'payment_not_found' });
  const offered = JSON.parse(p.offered_wallet_ids);
  const walletId = wrong_wallet ? (db.prepare('SELECT id FROM wallets WHERE provider=? AND id NOT IN (?)').get(p.provider, offered[0])?.id || offered[0]) : offered[0];
  const body = `You have received Tk ${(amount ?? p.amount) / 100}.00 from 01712750278. Fee Tk 0.00. Balance Tk ${(amount ?? p.amount) / 100}.00. TrxID ${trx_id || 'SIM' + crypto.randomBytes(4).toString('hex').toUpperCase()}${with_reference ? ` and Ref ${p.reference}` : ''} at ${new Date().toLocaleString('en-GB')}`;
  const out = ingestSms({ sender: p.provider, body, client_msg_id: 'sim_' + crypto.randomBytes(8).toString('hex'), device_id: req.device?.id || null, sim_slot: 1, received_at: nowIso() });
  res.json(out);
});

app.use('/v1', v1);

// ================= PUBLIC PAY PAGE ENDPOINTS ===============================
// GET /v1/pay/:id — pay page data. POST /v1/pay/:id/confirm — holds up to 90 s.
const payRouter = express.Router();
payRouter.use(rateLimit(10, 60000)); // 10 requests per minute per IP

payRouter.get('/pay/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  touchExpiry(p);
  const wallet = db.prepare('SELECT * FROM wallets WHERE id=?').get(p.wallet_id);
  res.json({
    id: p.id, status: p.status, provider: p.provider, amount: p.amount, reference: p.reference,
    review_reason: p.review_reason, expires_at: p.expires_at, locked_until: p.locked_until,
    wallet: wallet ? { provider: wallet.provider, number: wallet.msisdn, holder_name: wallet.holder_name } : null,
    plan: p.plan_snapshot ? JSON.parse(p.plan_snapshot) : null,
    merchant: db.prepare('SELECT name FROM merchants WHERE id=?').get(p.merchant_id)?.name,
  });
});

function touchExpiry(p) {
  if (['created', 'awaiting_payment', 'confirming'].includes(p.status) && p.expires_at <= nowIso() && !p.submitted_trx_id) {
    db.prepare(`UPDATE payments SET status='expired' WHERE id=?`).run(p.id);
    matching.queueWebhook(p, 'payment.expired', {});
    p.status = 'expired';
  }
}

payRouter.post('/pay/:id/confirm', async (req, res) => {
  const p0 = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (!p0) return res.status(404).json({ error: 'not_found' });
  touchExpiry(p0);
  let p = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (p.status === 'paid') return res.json(finalResult(p));
  if (['expired', 'cancelled', 'needs_review'].includes(p.status)) return res.json(finalResult(p));
  if (p.locked_until && p.locked_until > nowIso()) return res.status(423).json({ error: 'locked', message: 'Too many failed attempts. Try again later.', retry_after: p.locked_until });

  const trx = String(req.body?.trx_id || '').trim().toUpperCase();
  if (!sms.trxIdLooksValid(p.provider, trx)) return res.status(422).json({ error: 'bad_trxid_format', message: 'That does not look like a valid TrxID. Please check what your wallet app shows.' });

  // Already-used TrxID guard ("This TrxID was already used")
  const claimedTxn = db.prepare('SELECT * FROM incoming_txns WHERE upper(trx_id)=? AND claimed_payment_id IS NOT NULL LIMIT 1').get(trx);
  if (claimedTxn && claimedTxn.claimed_payment_id !== p.id) {
    bumpAttempt(p, res);
    return res.status(409).json({ error: 'trxid_already_used', message: 'This TrxID was already used.' });
  }

  // Record the claim; re-checked on every new SMS too.
  db.prepare(`UPDATE payments SET submitted_trx_id=?, status='confirming', confirmed_at=?, confirm_attempts=confirm_attempts+1 WHERE id=?`)
    .run(trx, nowIso(), p.id);
  p = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);

  matching.checkPayment(p.id);
  p = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (p.status === 'paid' || p.status === 'needs_review') return res.json(finalResult(p));

  // Hold up to 90 s polling for the SMS evidence to arrive.
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    matching.checkPayment(p.id);
    p = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
    if (['paid', 'needs_review', 'expired', 'cancelled'].includes(p.status)) break;
  }
  if (p.status === 'confirming') {
    // "Still checking" — keeps matching in the background until expiry.
    return res.json({ status: 'confirming', still_checking: true, message: "We haven't seen your payment yet. It can take a minute.", reference: p.reference });
  }
  bumpAttemptOnFail(p);
  res.json(finalResult(p));
});

function bumpAttempt(p, res) {
  const attempts = p.confirm_attempts + 1;
  const upd = db.prepare('UPDATE payments SET confirm_attempts=? WHERE id=?');
  if (attempts >= 5) { // 5 failed attempts lock the page for 15 min
    upd.run(attempts, p.id);
    db.prepare(`UPDATE payments SET locked_until=? WHERE id=?`).run(new Date(Date.now() + 15 * 60000).toISOString(), p.id);
  } else upd.run(attempts, p.id);
}
function bumpAttemptOnFail(p) { /* attempt already counted at confirm time */ }

function finalResult(p) {
  switch (p.status) {
    case 'paid': return { status: 'paid', amount: p.amount, reference: p.reference, order_id: p.order_id, message: 'Payment received' };
    case 'needs_review': return { status: 'needs_review', review_reason: p.review_reason, reference: p.reference, message: reviewMessage(p) };
    case 'expired': return { status: 'expired', message: 'This payment link has expired.' };
    case 'cancelled': return { status: 'cancelled', message: 'This payment was cancelled.' };
    default: return { status: p.status };
  }
}
function reviewMessage(p) {
  if (['underpaid', 'overpaid'].includes(p.review_reason)) {
    const t = db.prepare('SELECT amount FROM incoming_txns WHERE claimed_payment_id=? OR trx_id=(SELECT submitted_trx_id FROM payments WHERE id=?) LIMIT 1').get(p.id, p.id);
    return `We received Tk ${((t?.amount || 0) / 100).toFixed(2)} but expected Tk ${(p.amount / 100).toFixed(2)}. Our team will review it.`;
  }
  if (p.review_reason === 'trxid_already_claimed') return 'This TrxID was already used.';
  return 'Your payment needs a quick review by our team. Support has been notified.';
}

app.use('/v1', payRouter);

// ================= DEVICE INGEST ==========================================
const devRouter = express.Router();
devRouter.use(rateLimit(60, 60000));

devRouter.post('/devices/pair', (req, res) => {
  // Exchange an admin-issued pairing code for a device token.
  const code = String(req.body?.pairing_code || '');
  const d = db.prepare(`SELECT * FROM devices WHERE pairing_code_hash=? AND revoked_at IS NULL`).get(hash(code));
  if (!code || !d) return res.status(401).json({ error: 'invalid_pairing_code' });
  const token = 'devt_' + crypto.randomBytes(32).toString('base64url');
  db.prepare(`UPDATE devices SET token_hash=?, pairing_code_hash=NULL, app_version=COALESCE(?,app_version), model=COALESCE(?,model), name=COALESCE(?,name), status='paired', last_heartbeat_at=? WHERE id=?`)
    .run(hash(token), req.body?.app_version || null, req.body?.model || null, req.body?.name || null, nowIso(), d.id);
  db.prepare('UPDATE devices SET pairing_code_hash=? WHERE id=?').run(null, d.id);
  audit('device', 'device.pair', 'device', d.id, null, null, req.ip);
  res.json({ device_id: d.id, token, rotate_after_days: 90 });
});

devRouter.post('/devices/heartbeat', (req, res) => {
  const d = deviceFromToken(req, res); if (!d) return;
  db.prepare(`UPDATE devices SET last_heartbeat_at=?, battery=?, queue_depth=?, permissions=?, status='online' WHERE id=?`)
    .run(nowIso(), req.body?.battery ?? d.battery, req.body?.queue_depth ?? 0, req.body?.permissions ?? d.permissions, d.id);
  res.json({ ok: true });
});

function ingestSms(msg) {
  // msg: {sender, body, client_msg_id, received_at, sim_slot, ref_hint, device_id}
  const parsed = sms.parseSms(msg);
  const deviceId = msg.device_id || req0device();
  // map SIM to its wallet
  let wallet = null;
  if (deviceId) wallet = db.prepare('SELECT * FROM wallets WHERE device_id=? AND sim_slot=? AND provider=?').get(deviceId, msg.sim_slot || 1, parsed.provider)
    || db.prepare('SELECT * FROM wallets WHERE device_id=? AND provider=?').get(deviceId, parsed.provider);
  const id = uid('inc');
  try {
    db.prepare(`INSERT INTO incoming_txns (id,provider,trx_id,wallet_id,amount,balance_after,ref_raw,ref_normalized,raw,client_msg_id,sim_slot,device_id,flags,parser_version,sms_received_at,server_received_at,received_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, parsed.provider || 'UNKNOWN', parsed.trx_id, wallet?.id || null, parsed.amount, parsed.balance_after,
        parsed.ref_raw, parsed.ref_normalized, encryptRaw(msg.body || ''), msg.client_msg_id || null, msg.sim_slot || 1,
        deviceId || null, JSON.stringify(parsed.flags), parsed.parser_version, msg.received_at || null, nowIso(), nowIso());
  } catch (e) {
    const m = String(e.message || e);
    if (m.includes('idx_incoming_dedupe') || m.includes('idx_incoming_trx')) return { status: 200, body: { result: 'duplicate' } };
    console.error('ingest', m);
    throw e;
  }
  if (!parsed.parseable) return { status: 422, body: { result: 'unparseable', kept: true, flags: parsed.flags, id } };
  if (parsed.flags.includes('not_received_money')) return { status: 200, body: { result: 'ignored', flags: parsed.flags, id } };
  const r = matching.onNewIncoming(id);
  return { status: 200, body: { result: r.result === 'unmatched' ? 'stored' : r.result, matched_payment_id: r.payment_id || null, id } };
}
let _reqDevice = null; function req0device() { return _reqDevice; }

devRouter.post('/sms/webhook', (req, res) => {
  const d = deviceFromToken(req, res); if (!d) return;
  _reqDevice = d.id;
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages : [req.body || {}];
  const out = [];
  for (const m of msgs) {
    try { out.push(ingestSms({ ...m, device_id: d.id })); } catch (e) { console.error(e); out.push({ status: 500, body: { result: 'error' } }); }
  }
  _reqDevice = null;
  const first = out[0] || { status: 200, body: { result: 'stored' } };
  res.status(first.status).json(out.length === 1 ? first.body : out);
});

app.use('/v1', devRouter);

// raw SMS encrypted at rest (PRD §6 privacy)
let _k;
function aesKey() {
  if (!_k) _k = crypto.createHash('sha256').update(process.env.PAYGATE_ENC_KEY || 'dev-encryption-key-change-me').digest();
  return _k;
}
function encryptRaw(s) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
  const enc = Buffer.concat([c.update(String(s), 'utf8'), c.final()]);
  return iv.toString('base64') + '.' + c.getAuthTag().toString('base64') + '.' + enc.toString('base64');
}
function decryptRaw(blob) {
  try {
    const [iv, tag, data] = String(blob).split('.');
    const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return '[redacted]'; }
}

// ================= ADMIN CONSOLE API =====================================
const admin = express.Router();
admin.use((req, res, next) => { if (req.path === '/login') return next(); if (!staffFromSession(req, res)) return; next(); });

admin.post('/login', (req, res) => {
  const { email, password, totp } = req.body || {};
  const u = db.prepare('SELECT * FROM staff_users WHERE email=?').get(String(email || ''));
  if (!u || u.pass_hash !== hash(password || '')) return res.status(401).json({ error: 'bad_credentials' });
  // Mandatory 2FA for owners and staff (dev stub accepts fixed code; prod = TOTP).
  if (!totp || String(totp) !== '246810') return res.status(401).json({ error: '2fa_required', message: 'Enter your 6-digit 2FA code (dev: 246810)' });
  const tok = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token,kind,user_id,created_at,expires_at) VALUES (?,?,?,?,?)')
    .run(hash(tok), 'staff', u.id, nowIso(), new Date(Date.now() + 12 * 3600e3).toISOString());
  audit(u.email, 'staff.login', 'staff', u.id, null, null, req.ip);
  res.json({ token: tok, role: u.role });
});

admin.get('/overview', (req, res) => {
  const q = (s) => db.prepare(s).get();
  res.json({
    payments_today: q(`SELECT COUNT(*) c FROM payments WHERE substr(created_at,1,10)=substr('${nowIso()}',1,10)`).c,
    paid_today_paisa: q(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='paid' AND substr(paid_at,1,10)=substr('${nowIso()}',1,10)`).s,
    needs_review: q(`SELECT COUNT(*) c FROM payments WHERE status='needs_review'`).c,
    unmatched: q(`SELECT COUNT(*) c FROM incoming_txns WHERE claimed_payment_id IS NULL AND amount IS NOT NULL`).c,
    devices_online: q(`SELECT COUNT(*) c FROM devices WHERE last_heartbeat_at >= '${new Date(Date.now() - 180000).toISOString()}' AND revoked_at IS NULL`).c,
    devices_total: q(`SELECT COUNT(*) c FROM devices WHERE revoked_at IS NULL`).c,
    failed_webhooks: q(`SELECT COUNT(*) c FROM webhook_deliveries WHERE status='failed'`).c,
  });
});

admin.get('/wallets', (req, res) => res.json({ data: db.prepare('SELECT * FROM wallets ORDER BY provider').all() }));
admin.patch('/wallets/:id', (req, res) => {
  const w = db.prepare('SELECT * FROM wallets WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'not_found' });
  const { status, daily_limit, monthly_limit, concurrency_cap } = req.body || {};
  db.prepare('UPDATE wallets SET status=COALESCE(?,status), daily_limit=COALESCE(?,daily_limit), monthly_limit=COALESCE(?,monthly_limit), concurrency_cap=COALESCE(?,concurrency_cap) WHERE id=?')
    .run(status || null, daily_limit ?? null, monthly_limit ?? null, concurrency_cap ?? null, w.id);
  audit(req.staff.email, 'wallet.update', 'wallet', w.id, w, db.prepare('SELECT * FROM wallets WHERE id=?').get(w.id), req.ip);
  res.json(db.prepare('SELECT * FROM wallets WHERE id=?').get(w.id));
});

admin.get('/devices', (req, res) => res.json({ data: db.prepare('SELECT id,name,model,app_version,status,last_heartbeat_at,battery,queue_depth,permissions,revoked_at FROM devices').all() }));
admin.post('/devices/:id/revoke', (req, res) => {
  db.prepare(`UPDATE devices SET revoked_at=?, status='revoked' WHERE id=?`).run(nowIso(), req.params.id);
  db.prepare(`UPDATE wallets SET status='paused' WHERE device_id=? AND status='active'`).run(req.params.id);
  audit(req.staff.email, 'device.revoke', 'device', req.params.id, null, null, req.ip);
  res.json({ ok: true });
});
admin.post('/devices/:id/flush', (req, res) => { // remote flush queue marker consumed by device poll
  db.prepare(`UPDATE devices SET queue_depth=0 WHERE id=?`).run(req.params.id);
  db.prepare(`INSERT INTO devices (id,name,status,created_at) SELECT ?, 'flush-marker', status, created_at FROM devices WHERE id=? AND 1=0`).run(uid('x'), req.params.id);
  audit(req.staff.email, 'device.flush', 'device', req.params.id, null, null, req.ip);
  res.json({ ok: true, note: 'queue cleared; device will receive flush flag on next heartbeat' });
});
admin.post('/devices/pairing-code', (req, res) => {
  const id = uid('dev'); const code = 'pair_' + crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO devices (id,name,status,pairing_code_hash,created_at) VALUES (?,?,' + "'unpaired',?,?)")
    .run(id, req.body?.name || 'New phone', hash(code), nowIso());
  audit(req.staff.email, 'device.pairing_code', 'device', id, null, null, req.ip);
  res.json({ device_id: id, pairing_code: code, note: 'one-time; exchange via POST /v1/devices/pair' });
});

admin.get('/review', (req, res) => {
  const rows = db.prepare(`SELECT p.*, m.name merchant_name FROM payments p JOIN merchants m ON m.id=p.merchant_id
    WHERE p.status='needs_review' ORDER BY p.created_at DESC`).all();
  const unmatched = db.prepare(`SELECT it.*, w.msisdn FROM incoming_txns it LEFT JOIN wallets w ON w.id=it.wallet_id
    WHERE it.claimed_payment_id IS NULL AND it.amount IS NOT NULL ORDER BY it.received_at DESC LIMIT 100`).all();
  res.json({ data: rows.map(r => ({ ...r, plan_snapshot: r.plan_snapshot ? JSON.parse(r.plan_snapshot) : null })), unmatched });
});

admin.post('/review/:paymentId/resolve', (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.paymentId);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const action = req.body?.action; // mark_paid | close
  const txn = db.prepare('SELECT * FROM incoming_txns WHERE upper(trx_id)=upper(?) LIMIT 1').get(p.submitted_trx_id || '');
  if (action === 'mark_paid') {
    if (!txn) return res.status(422).json({ error: 'no_evidence', message: 'Cannot force paid without an incoming transaction; use a suggested match instead' });
    const { fee, net } = matching.recordPaid(p, txn, 'manual');
    require('./src/wallets').addTotals(txn.wallet_id || p.wallet_id, p.amount);
    matching.queueWebhook({ ...p, status: 'paid' }, 'payment.paid', { matched_by: 'manual', fee_amount: fee, net_amount: net });
  } else if (action === 'close') {
    db.prepare(`UPDATE payments SET status='cancelled', review_reason='closed_by_ops' WHERE id=?`).run(p.id);
  } else return res.status(422).json({ error: 'bad_action' });
  audit(req.staff.email, `review.${action}`, 'payment', p.id, { status: p.status }, { note: req.body?.note || '' }, req.ip);
  res.json(db.prepare('SELECT * FROM payments WHERE id=?').get(p.id));
});

admin.post('/review/suggest/:txnId', (req, res) => {
  // Suggested match for an unmatched txn: same provider + amount within active payments
  const txn = db.prepare('SELECT * FROM incoming_txns WHERE id=?').get(req.params.txnId);
  if (!txn) return res.status(404).json({ error: 'not_found' });
  const cands = db.prepare(`SELECT p.*, m.name merchant_name FROM payments p JOIN merchants m ON m.id=p.merchant_id
    WHERE p.status IN ('awaiting_payment','confirming') AND p.provider=? AND p.amount=? ORDER BY p.created_at DESC LIMIT 5`)
    .all(txn.provider, txn.amount);
  res.json({ suggestions: cands });
});

admin.get('/payouts', (req, res) => res.json({ data: db.prepare('SELECT po.*, m.name merchant_name FROM payouts po JOIN merchants m ON m.id=po.merchant_id ORDER BY po.created_at DESC').all() }));
admin.post('/payouts/:id/approve', (req, res) => {
  const po = db.prepare('SELECT * FROM payouts WHERE id=?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'not_found' });
  if (po.approved_by && po.approved_by === req.staff.email) return res.status(409).json({ error: 'two_person_rule', message: 'A different staff member must execute the payout (maker-checker)' });
  if (po.status === 'pending_approval') {
    db.prepare(`UPDATE payouts SET status='approved_by_maker', approved_by=?, updated_at=? WHERE id=?`).run(req.staff.email, nowIso(), po.id);
    audit(req.staff.email, 'payout.approve', 'payout', po.id, po.status, 'approved_by_maker', req.ip);
    return res.json(db.prepare('SELECT * FROM payouts WHERE id=?').get(po.id));
  }
  if (po.status === 'approved_by_maker') {
    db.prepare(`UPDATE payouts SET status='paid', executed_by=?, updated_at=? WHERE id=?`).run(req.staff.email, nowIso(), po.id);
    db.prepare('INSERT INTO ledger_entries (id,merchant_id,payout_id,entry_type,amount,description,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(uid('led'), po.merchant_id, po.id, 'payout', -po.amount, 'Payout executed', nowIso());
    audit(req.staff.email, 'payout.execute', 'payout', po.id, po.status, 'paid', req.ip);
    return res.json(db.prepare('SELECT * FROM payouts WHERE id=?').get(po.id));
  }
  res.status(409).json({ error: 'bad_state' });
});
admin.post('/payouts/:id/reject', (req, res) => {
  db.prepare(`UPDATE payouts SET status='rejected', note=?, updated_at=? WHERE id=?`).run(req.body?.note || '', nowIso(), req.params.id);
  audit(req.staff.email, 'payout.reject', 'payout', req.params.id, null, req.body?.note, req.ip);
  res.json({ ok: true });
});

admin.get('/merchants', (req, res) => res.json({ data: db.prepare('SELECT id,name,status,kyb_status,fee_rate_bps,risk_tier,created_at FROM merchants').all() }));
admin.post('/merchants/:id/kyb', (req, res) => {
  const { decision } = req.body || {}; // approve | reject
  const m = db.prepare('SELECT * FROM merchants WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const kyb = decision === 'approve' ? 'verified' : 'rejected';
  db.prepare(`UPDATE merchants SET kyb_status=?, status=CASE WHEN ?='verified' THEN 'active' ELSE status END WHERE id=?`).run(kyb, kyb, m.id);
  audit(req.staff.email, `kyb.${decision}`, 'merchant', m.id, m.kyb_status, kyb, req.ip);
  res.json(db.prepare('SELECT * FROM merchants WHERE id=?').get(m.id));
});

admin.get('/webhooks', (req, res) => res.json({ data: db.prepare('SELECT id,event_id,event_type,payment_id,url,attempts,status,response_code,last_status,next_attempt_at,created_at,delivered_at FROM webhook_deliveries ORDER BY created_at DESC LIMIT 200').all() }));
admin.post('/webhooks/:id/resend', (req, res) => { hooks.resend(req.params.id); audit(req.staff.email, 'webhook.resend', 'webhook_delivery', req.params.id, null, null, req.ip); res.json({ ok: true }); });

admin.get('/audit', (req, res) => res.json({ data: db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 300').all() }));

admin.get('/incoming/:id/raw', (req, res) => {
  const t = db.prepare('SELECT raw FROM incoming_txns WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  audit(req.staff.email, 'sms.raw_reveal', 'incoming_txn', req.params.id, null, null, req.ip); // audited reveal
  res.json({ raw: decryptRaw(t.raw) });
});

app.use('/v1/admin', admin);

// ================= DEV HOOK RECEIVER (for demo webhooks) ==================
const hookLog = [];
app.post('/devhook', (req, res) => {
  hookLog.unshift({ at: nowIso(), event: req.body?.type, data: req.body?.data, signature: req.headers['paygate-signature'] || null });
  hookLog.length = Math.min(hookLog.length, 50);
  res.json({ received: true });
});
app.get('/devhook/log', (req, res) => res.json({ data: hookLog }));

// ================= STATIC UI =============================================
app.use(express.static(path.join(__dirname, 'public')));
app.get('/pay/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pay', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));
app.get('/healthz', (req, res) => res.json({ ok: true, version: '3.0.0-dev', time: nowIso() }));

// background jobs: expire payments, run matcher on stale confirming rows
setInterval(() => {
  try {
    const due = db.prepare(`SELECT id FROM payments WHERE status IN ('created','awaiting_payment','confirming') AND expires_at<=? LIMIT 100`).all(nowIso());
    for (const d of due) matching.checkPayment(d.id);
  } catch (e) { console.error('expiry job', e); }
}, 10000).unref?.();

// boot
const creds = seed();
if (creds.seeded) {
  console.log('\n=== PayGate dev seed credentials (save these) ===');
  console.log(JSON.stringify(creds, null, 2));
  console.log('=====================================================\n');
}
hooks.startSenderLoop();

if (require.main === module) {
  app.listen(PORT, () => console.log(`PayGate server on ${BASE}  (pay page: ${BASE}/pay/<id>, dashboard: ${BASE}/dashboard, admin: ${BASE}/admin)`));
}
module.exports = app;
