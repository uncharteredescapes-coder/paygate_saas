'use strict';
// Reference generation & validation — PRD §4 "Reference".
// Exactly 8 characters: seven random characters plus a final check character.
// Charset avoids look-alikes (0/O, 1/I/L). No REF prefix. Matched case-insensitively
// after normalisation (uppercase, strip spaces, hyphens and punctuation).

const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 chars, no 0/O/1/I/L
const REF_LENGTH = 8;

function randInt(max) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

function checkChar(body) {
  let sum = 0;
  for (const ch of body) sum += CHARSET.indexOf(ch);
  return CHARSET[sum % CHARSET.length];
}

/** Normalise a token as the server does before validating: uppercase, strip spaces/hyphens/punctuation. */
function normalizeToken(raw) {
  return String(raw == null ? '' : raw)
    .toUpperCase()
    .replace(/[\s\-_.,;:/]/g, '');
}

/** Generate a fresh single-use reference, e.g. K7M4X2QH. */
function generateReference() {
  let body = '';
  for (let i = 0; i < REF_LENGTH - 1; i++) body += CHARSET[randInt(CHARSET.length)];
  return body + checkChar(body);
}

/** True when `token` (already normalised or raw) is a well-formed reference. */
function isValidReference(token) {
  const t = normalizeToken(token);
  if (t.length !== REF_LENGTH) return false;
  for (const ch of t) if (CHARSET.indexOf(ch) === -1) return false;
  return t[REF_LENGTH - 1] === checkChar(t.slice(0, REF_LENGTH - 1));
}

/**
 * The parser accepts any 6..20 character token after the Ref label; the server then
 * validates length + check character. Anything else goes to the unmatched pool.
 */
function refQuality(token) {
  const t = normalizeToken(token);
  if (!t) return { ok: false, reason: 'empty' };
  if (t.length < 6 || t.length > 20) return { ok: false, reason: 'bad_length' };
  if (/[^A-Z2-9]/.test(t)) return { ok: false, reason: 'bad_charset' };
  if (t.length === REF_LENGTH && isValidReference(t)) return { ok: true, normalized: t, checked: true };
  return { ok: false, reason: 'check_char', normalized: t };
}

module.exports = { CHARSET, REF_LENGTH, generateReference, isValidReference, normalizeToken, refQuality };
