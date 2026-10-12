'use strict';
// Matching engine — PRD §4 "Matching rules". The ONLY place a payment becomes paid.
// The customer's TrxID is the claim, the forwarded SMS is the evidence. A claim is checked
// when the customer presses Confirm and again whenever a new SMS arrives, so order of
// arrival does not matter. Each check runs in one database transaction on an unclaimed
// incoming transaction (atomic claim; first valid claim wins).

const { db, nowIso, uid, audit } = require('./db');
const { normalizeToken } = require('./references');

// --- ledger + webhook side effects ---------------------------------------
function recordPaid(payment, txn, matchedBy) {
  const t = nowIso();
  const merchant = db.prepare('SELECT * FROM merchants WHERE id=?').get(payment.merchant_id);
  const feeRate = merchant.fee_rate_bps;
  const fee = Math.round(payment.amount * feeRate / 10000); // rounded to nearest paisa
  const net = payment.amount - fee;
  db.prepare(`UPDATE payments SET status='paid', fee_amount=?, net_amount=?, matched_by=?,
              paid_at=?, confirmed_at=COALESCE(confirmed_at,?), wallet_id=COALESCE(wallet_id,?)
              WHERE id=?`)
    .run(fee, net, matchedBy, t, t, txn.wallet_id, payment.id);
  if (txn.claimed_payment_id == null) {
    db.prepare('UPDATE incoming_txns SET claimed_payment_id=? WHERE id=?').run(payment.id, txn.id);
  }
  // Double entry: pay-in (money received), fee (PayGate revenue), merchant payable (+net)
  db.prepare(`INSERT INTO ledger_entries (id,merchant_id,payment_id,entry_type,amount,description,created_at)
              VALUES (?,?,?,?,?,?,?)`).run(uid('led'), payment.merchant_id, payment.id, 'pay_in', 0,
    `Gross Tk ${(payment.amount / 100).toFixed(2)} received into PayGate wallet`, t);
  db.prepare(`INSERT INTO ledger_entries (id,merchant_id,payment_id,entry_type,amount,description,created_at)
              VALUES (?,?,?,?,?,?,?)`).run(uid('led'), payment.merchant_id, payment.id, 'fee', -fee,
    `PayGate fee ${(feeRate / 100).toFixed(2)}%`, t);
  db.prepare(`INSERT INTO ledger_entries (id,merchant_id,payment_id,entry_type,amount,description,created_at)
              VALUES (?,?,?,?,?,?,?)`).run(uid('led'), payment.merchant_id, payment.id, 'merchant_payable', net,
    `Net credited to merchant balance`, t);
  return { fee, net };
}

function needsReview(payment, reason) {
  db.prepare(`UPDATE payments SET status='needs_review', review_reason=? WHERE id=?`).run(reason, payment.id);
  queueWebhook(payment, 'payment.needs_review', { review_reason: reason });
}

function queueWebhook(payment, eventType, extra = {}) {
  const merchant = db.prepare('SELECT * FROM merchants WHERE id=?').get(payment.merchant_id);
  const url = payment.callback_url || merchant.webhook_url;
  if (!url) return;
  const eventId = uid('evt');
  const payload = {
    event_id: eventId,
    type: eventType,
    created_at: nowIso(),
    data: {
      id: payment.id,
      reference: payment.reference,
      plan_id: payment.plan_id,
      order_id: payment.order_id,
      provider: payment.provider,
      amount: payment.amount,
      currency: 'BDT',
      status: eventType === 'payment.paid' ? 'paid' : (eventType === 'payment.expired' ? 'expired' : (eventType === 'payment.cancelled' ? 'cancelled' : 'needs_review')),
      matched_by: eventType === 'payment.paid' ? (extra.matched_by || payment.matched_by) : undefined,
      fee_amount: extra.fee_amount,
      net_amount: extra.net_amount,
      settlement_status: 'unsettled',
      review_reason: extra.review_reason,
      metadata: payment.metadata ? JSON.parse(payment.metadata) : undefined,
    },
  };
  try {
    db.prepare(`INSERT INTO webhook_deliveries (id,merchant_id,event_id,event_type,payment_id,payload,url,attempts,next_attempt_at,status,created_at)
                VALUES (?,?,?,?,?,?,?,?,0,?,'queued',?)`)
      .run(uid('whd'), payment.merchant_id, eventId, eventType, payment.id,
        JSON.stringify(payload), url, nowIso(), nowIso());
  } catch (e) { /* duplicate event id virtually impossible */ }
}

// --- core check ------------------------------------------------------------
/**
 * Try to match one payment against the incoming transactions table.
 * Runs inside a transaction; claims an unclaimed txn atomically.
 * Returns updated payment row.
 */
const checkPayment = db.transaction((paymentId) => {
  let p = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
  if (!p) return null;
  if (['paid', 'expired', 'cancelled'].includes(p.status)) return p;

  // Terminal states reached by time: expired unless confirming (late SMS -> review below)
  const expired = p.expires_at <= nowIso();

  if (!p.submitted_trx_id) {
    // No claim yet — auto-confirm path handled from ingest side (reference-only proof).
    if (expired && p.status !== 'expired') {
      db.prepare(`UPDATE payments SET status='expired' WHERE id=? AND status IN ('created','awaiting_payment','confirming')`).run(p.id);
      queueWebhook(p, 'payment.expired', {});
      return db.prepare('SELECT * FROM payments WHERE id=?').get(p.id);
    }
    return p;
  }

  const trx = p.submitted_trx_id.toUpperCase();
  const offered = JSON.parse(p.offered_wallet_ids || '[]');
  const txn = db.prepare(`SELECT * FROM incoming_txns WHERE upper(trx_id)=? LIMIT 1`).get(trx);

  if (!txn) {
    // Case: no evidence yet -> stays confirming until expiry.
    if (expired && p.status !== 'expired') {
      db.prepare(`UPDATE payments SET status='expired' WHERE id=?`).run(p.id);
      queueWebhook(p, 'payment.expired', {});
      return db.prepare('SELECT * FROM payments WHERE id=?').get(p.id);
    }
    return p; // still confirming / awaiting
  }

  if (txn.claimed_payment_id && txn.claimed_payment_id !== p.id) {
    // TrxID already claimed by another payment -> first valid claim wins.
    needsReview(p, 'trxid_already_claimed');
    return db.prepare('SELECT * FROM payments WHERE id=?').get(p.id);
  }

  if (expired) { needsReview(p, 'late_payment'); return db.prepare('SELECT * FROM payments WHERE id=?').get(p.id); }

  // Evidence exists — verify everything agrees.
  const walletOk = txn.wallet_id && offered.includes(txn.wallet_id);
  const providerOk = txn.provider === p.provider;
  const refOk = txn.ref_normalized ? (normalizeToken(txn.ref_normalized) === normalizeToken(p.reference)) : true;

  if (!providerOk || !walletOk) { needsReview(p, 'wrong_wallet'); return db.prepare('SELECT * FROM payments WHERE id=?').get(p.id); }
  if (!refOk) { needsReview(p, 'conflict'); return db.prepare('SELECT * FROM payments WHERE id=?').get(p.id); }
  if (txn.amount !== p.amount) { needsReview(p, txn.amount < p.amount ? 'underpaid' : 'overpaid'); return db.prepare('SELECT * FROM payments WHERE id=?').get(p.id); }

  // Time window sanity: SMS must not predate payment creation by > 1 day or postdate far future
  const smsTime = txn.sms_received_at || txn.received_at;
  if (smsTime && (new Date(smsTime) < new Date(new Date(p.created_at).getTime() - 24 * 3600 * 1000) || new Date(smsTime) > new Date(Date.now() + 10 * 60 * 1000))) {
    needsReview(p, 'time_window'); return db.prepare('SELECT * FROM payments WHERE id=?').get(p.id);
  }

  // Balance continuity fraud flag (PRD §6): previous txn on same wallet should chain.
  const prev = db.prepare(`SELECT balance_after FROM incoming_txns WHERE wallet_id=? AND id!=? AND balance_after IS NOT NULL ORDER BY received_at DESC LIMIT 1`).get(txn.wallet_id, txn.id);
  if (prev && txn.balance_after != null && prev.balance_after + txn.amount !== txn.balance_after) {
    db.prepare('UPDATE incoming_txns SET flags=? WHERE id=?').run(JSON.stringify(['balance_gap']), txn.id);
    // flagged but still matchable per PRD (flag for ops)
  }

  const matchedBy = txn.ref_normalized ? 'trxid+reference' : 'trxid';
  const { fee, net } = recordPaid(p, txn, matchedBy);
  require('./wallets').addTotals(txn.wallet_id, p.amount);
  queueWebhook({ ...p, status: 'paid' }, 'payment.paid', { matched_by: matchedBy, fee_amount: fee, net_amount: net });
  audit('matching_engine', 'payment.paid', 'payment', p.id, { status: p.status }, { status: 'paid', matched_by: matchedBy });
  return db.prepare('SELECT * FROM payments WHERE id=?').get(p.id);
});

/**
 * Called from SMS ingest: given a stored incoming txn, find candidate payments.
 * 1) If some confirming payment submitted this TrxID -> check it.
 * 2) Else if merchant auto_confirm is on and reference matches + amount agrees -> paid (matched_by=reference).
 * 3) Else leave in unmatched pool.
 */
const onNewIncoming = db.transaction((txnId) => {
  const txn = db.prepare('SELECT * FROM incoming_txns WHERE id=?').get(txnId);
  if (!txn || txn.claimed_payment_id) return { result: 'ignored' };
  if (!txn.trx_id) return { result: 'unparseable' };

  // 1) claim-driven match
  const claimed = db.prepare(`SELECT * FROM payments WHERE upper(submitted_trx_id)=?
      AND status IN ('created','awaiting_payment','confirming')
      ORDER BY created_at ASC LIMIT 1`).get(txn.trx_id.toUpperCase());
  if (claimed) {
    const p = checkPayment(claimed.id);
    return { result: p ? p.status : 'none', payment_id: claimed.id };
  }

  // 2) auto-confirm: reference + amount agreement, only for merchants with auto_confirm on
  if (txn.ref_normalized) {
    const cand = db.prepare(`
      SELECT p.*, m.auto_confirm ac FROM payments p JOIN merchants m ON m.id=p.merchant_id
      WHERE p.reference=? AND p.status IN ('awaiting_payment','confirming','created') AND m.auto_confirm=1
      LIMIT 1`).get(normalizeToken(txn.ref_normalized));
    if (cand && cand.ac) {
      if (cand.amount === txn.amount && (!txn.wallet_id || JSON.parse(cand.offered_wallet_ids || '[]').includes(txn.wallet_id))) {
        const { fee, net } = recordPaid(cand, txn, 'reference');
        require('./wallets').addTotals(txn.wallet_id || cand.wallet_id, cand.amount);
        queueWebhook({ ...cand, status: 'paid' }, 'payment.paid', { matched_by: 'reference', fee_amount: fee, net_amount: net });
        return { result: 'paid', payment_id: cand.id };
      }
      needsReview(cand, cand.amount !== txn.amount ? (txn.amount < cand.amount ? 'underpaid' : 'overpaid') : 'wrong_wallet');
      return { result: 'needs_review', payment_id: cand.id };
    }
  }

  // 3) unmatched pool
  return { result: 'unmatched' };
});

module.exports = { checkPayment, onNewIncoming, queueWebhook, recordPaid, needsReview };
