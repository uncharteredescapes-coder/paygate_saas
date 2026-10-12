'use strict';
// Wallet pool assignment — PRD §4 "Wallet assignment".
// Choose an active wallet for the provider whose phone heartbeat is under 3 minutes old,
// with limit headroom and fewer pending payments than its concurrency cap; take the least
// recently assigned, otherwise return 503 no_wallet_available. Each payment keeps
// offered_wallet_ids so reassigning a wallet never loses a payment. Wallets in draining get
// no new payments; wallets above 80% of a limit are drained automatically.

const { db, nowIso } = require('./db');

const HEARTBEAT_MAX_MS = 3 * 60 * 1000; // 3 minutes

function pendingCountFor(walletId) {
  return db.prepare(`SELECT COUNT(*) c FROM payments
                     WHERE wallet_id = ? AND status IN ('created','awaiting_payment','confirming')`)
    .get(walletId).c;
}

function autoDrainCheck() {
  // >80% of daily or monthly limit -> draining
  const rows = db.prepare(`SELECT * FROM wallets WHERE status = 'active'`).all();
  const upd = db.prepare(`UPDATE wallets SET status='draining' WHERE id=?`);
  for (const w of rows) {
    if ((w.daily_limit && w.today_total / w.daily_limit > 0.8) ||
        (w.monthly_limit && w.month_total / w.monthly_limit > 0.8)) {
      upd.run(w.id);
    }
  }
}

/**
 * Pick up to `n` candidate wallets for a provider. Returns array of wallet rows
 * (ordered best-first). Empty array => caller must return 503 no_wallet_available.
 */
function offerWallets(provider, amountPaisa, n = 2) {
  autoDrainCheck();
  const cutoff = new Date(Date.now() - HEARTBEAT_MAX_MS).toISOString();
  const candidates = db.prepare(`
    SELECT w.* FROM wallets w
    LEFT JOIN devices d ON d.id = w.device_id
    WHERE w.provider = ? AND w.status = 'active'
      AND d.status != 'revoked' AND d.last_heartbeat_at >= ?
    ORDER BY (w.last_assigned_at IS NULL) DESC, w.last_assigned_at ASC
  `).all(provider, cutoff);

  const picked = [];
  for (const w of candidates) {
    if (amountPaisa > w.daily_limit - w.today_total) continue;            // daily headroom
    if (amountPaisa > w.monthly_limit - w.month_total) continue;          // monthly headroom
    if (pendingCountFor(w.id) >= w.concurrency_cap) continue;             // concurrency cap
    picked.push(w);
    if (picked.length >= n) break;
  }
  return picked;
}

function markAssigned(walletId) {
  db.prepare(`UPDATE wallets SET last_assigned_at = ? WHERE id = ?`).run(nowIso(), walletId);
}

function addTotals(walletId, amountPaisa) {
  const today = nowIso().slice(0, 10);
  const month = nowIso().slice(0, 7);
  const w = db.prepare('SELECT * FROM wallets WHERE id=?').get(walletId);
  const dayRows = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM payments
      WHERE wallet_id=? AND status='paid' AND substr(paid_at,1,10)=?`).get(walletId, today).s;
  const monRows = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM payments
      WHERE wallet_id=? AND status='paid' AND substr(paid_at,1,7)=?`).get(walletId, month).s;
  db.prepare(`UPDATE wallets SET today_total=?, month_total=? WHERE id=?`)
    .run(Math.max(w.today_total, dayRows), Math.max(w.month_total, monRows), walletId);
  autoDrainCheck();
}

module.exports = { offerWallets, markAssigned, addTotals, pendingCountFor, HEARTBEAT_MAX_MS };
