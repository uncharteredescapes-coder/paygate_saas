'use strict';
// SMS ingest parser — PRD §3 "SMS ingest and parser: provider patterns, dedupe by
// client_msg_id, versioned". Versioned so parser changes never invalidate old rows.

const { normalizeToken } = require('./references');

const PARSER_VERSION = '2026-10-01.1';

// Sender allowlist per provider (sender IDs, never phone numbers — PRD §6 layered spoof defence).
const SENDER_ALLOWLIST = {
  BKASH: ['BKASH', 'bKash', '28323', 'BKASH-TXN'],
  NAGAD: ['NAGAD', 'Nagad', '162627'],
  ROCKET: ['ROCKET', 'Rocket', 'BDBLROCKET', '3657'],
};

function detectProvider(sender, body) {
  const s = String(sender || '').toUpperCase();
  const b = String(body || '').toUpperCase();
  if (/BKASH|28323/.test(s) || /BKASH/.test(b)) return 'BKASH';
  if (/NAGAD|162627/.test(s) || /NAGAD/.test(b)) return 'NAGAD';
  if (/ROCKET|BDBLROCKET|3657/.test(s) || /ROCKET/.test(b)) return 'ROCKET';
  return null;
}

function money(s) {
  // "1,200.00" -> paisa integer 120000
  const n = parseFloat(String(s).replace(/,/g, ''));
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

const PATTERNS = [
  // You have received Tk 1,200.00 from 01712750278. Fee Tk 0.00. Balance Tk 1,200.00. TrxID DJC9SZQV0J and Ref REF934P923 at 12/10/2026 15:24
  { name: 'received_from', re: /(?:Tk\.?|BDT)\s*([\d,]+\.?\d*)\s*(?:from|by)\s*(\+?\d{9,14})/i, amount: 1, msisdn: 2 },
  { name: 'trxid', re: /trx\s*(?:id)?\s*[:#]?\s*([A-Z0-9]{8,20})/i, trx: 1 },
  { name: 'ref_label', re: /\bref(?:erence)?\s*(?:no\.?|id\.?)?\s*[:#]?\s*([A-Z0-9\-]{6,20})/i, ref: 1 },
  { name: 'balance', re: /balance\s*(?:tk\.?|taka)?\s*([\d,]+\.?\d*)/i, balance: 1 },
  { name: 'fee', re: /fee\s*(?:tk\.?)?\s*([\d,]+\.?\d*)/i, fee: 1 },
  { name: 'timestamp', re: /(\d{2}[\/-]\d{2}[\/-]\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)/i, ts: 1 },
];

/** Parse a received-money SMS body. Returns fields or null when unparseable (kept + flagged, 422). */
function parseSms({ sender, body }) {
  const text = String(body || '');
  const provider = detectProvider(sender, text);
  const flags = [];
  if (!provider) flags.push('unknown_provider');
  if (!/receiv|got|credit|added|received money/i.test(text) && !/tk|taka|৳/i.test(text)) {
    flags.push('not_received_money');
  }

  let amount = null, payer_msisdn = null, trx_id = null, ref_raw = null, balance_after = null, sms_ts = null;

  const mAmt = text.match(PATTERNS[0].re);
  if (mAmt) { amount = money(mAmt[1]); payer_msisdn = mAmt[2]; }
  else {
    // fallback: any Tk amount
    const mAny = text.match(/(?:Tk\.?|BDT|৳)\s*([\d,]+\.?\d*)/i);
    if (mAny) amount = money(mAny[1]);
  }
  const mTrx = text.match(PATTERNS[1].re);
  if (mTrx) trx_id = mTrx[1].toUpperCase();
  const mRef = text.match(PATTERNS[2].re);
  if (mRef) ref_raw = mRef[1];
  const mBal = text.match(PATTERNS[3].re);
  if (mBal) balance_after = money(mBal[1]);
  const mTs = text.match(PATTERNS[5].re);
  if (mTs) sms_ts = mTs[0];

  if (amount == null) flags.push('no_amount');
  if (!trx_id) flags.push('no_trxid');

  let ref_normalized = null, ref_checked = false;
  if (ref_raw) {
    ref_normalized = normalizeToken(ref_raw);
    // strip a leading REF label residue the regex may have captured
    if (/^REF[A-Z0-9]+$/.test(ref_normalized) && ref_normalized.length > 8) {
      ref_normalized = ref_normalized.slice(3); // tolerate "REF934P923" style echoes
    }
    ref_checked = true;
  }

  return {
    provider,
    trx_id,
    amount,
    payer_msisdn,
    balance_after,
    ref_raw,
    ref_normalized,
    ref_checked,
    sms_timestamp: sms_ts,
    flags,
    parser_version: PARSER_VERSION,
    parseable: amount != null && !!trx_id && !!provider,
  };
}

/** Provider format fingerprints for TrxIDs (PRD §6). Blocks obvious typos on confirm. */
const TRXID_PATTERNS = {
  BKASH: /^[A-Z0-9]{8,20}$/i,   // e.g. DJC9SZQV0J
  NAGAD: /^[A-Z0-9]{8,20}$/i,
  ROCKET: /^[A-Z0-9]{10,20}$/i,
};

function trxIdLooksValid(provider, trx) {
  const t = String(trx || '').trim().toUpperCase();
  if (t.length < 6 || t.length > 24) return false;
  const re = TRXID_PATTERNS[provider] || /^[A-Z0-9]{6,24}$/;
  return re.test(t);
}

module.exports = { PARSER_VERSION, SENDER_ALLOWLIST, detectProvider, parseSms, trxIdLooksValid };
