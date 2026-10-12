'use strict';
// Seed data so the SaaS is runnable out of the box: a demo merchant + live key,
// wallet pool, one paired device with a fresh heartbeat, and an ops staff user.

const crypto = require('crypto');
const { db, nowIso, hash, uid } = require('./db');

function seed() {
  const count = db.prepare('SELECT COUNT(*) c FROM merchants').get().c;
  if (count > 0) return { seeded: false };

  const t = nowIso();
  // Demo merchant with webhook secret (dev build stores the usable secret here).
  const whSecret = 'whsec_' + crypto.randomBytes(18).toString('hex');
  const mId = 'mch_demo000000000000001';
  db.prepare(`INSERT INTO merchants (id,name,status,kyb_status,payout_account,fee_rate_bps,risk_tier,webhook_secret_hash,webhook_url,auto_confirm,created_at)
              VALUES (?,?,'active','verified',?,500,'standard',?,?,0,?)`)
    .run(mId, 'Demo Shop Ltd', JSON.stringify({ method: 'bank', bank_name: 'Dutch-Bangla Bank', account_no: '142100900xxxxx', account_name: 'Demo Shop Ltd' }),
      hash(whSecret), 'http://localhost:3000/devhook', t);
  // NOTE: dev build keeps plaintext secret for signing; production would encrypt at rest.
  db.prepare('UPDATE merchants SET webhook_secret_hash=? WHERE id=?').run(whSecret, mId);

  const skLive = 'sk_live_' + crypto.randomBytes(20).toString('hex');
  const skTest = 'sk_test_' + crypto.randomBytes(20).toString('hex');
  db.prepare('INSERT INTO api_keys (id,merchant_id,key_prefix,key_hash,mode,created_at) VALUES (?,?,?,?,?,?)')
    .run(uid('key'), mId, skLive.slice(0, 16), hash(skLive), 'live', t);
  db.prepare('INSERT INTO api_keys (id,merchant_id,key_prefix,key_hash,mode,created_at) VALUES (?,?,?,?,?,?)')
    .run(uid('key'), mId, skTest.slice(0, 16), hash(skTest), 'test', t);

  // Plans (amount in paisa)
  const plan1 = 'pln_demo000000000000001';
  const plan2 = 'pln_demo000000000000002';
  db.prepare(`INSERT INTO pricing_plans (id,merchant_id,name,amount,currency,external_sku,version,status,open_amount,created_at)
              VALUES (?,?,'Premium Monthly',50000,'BDT','premium-mo',1,'active',0,?)`).run(plan1, mId, t);
  db.prepare(`INSERT INTO pricing_plans (id,merchant_id,name,amount,currency,external_sku,version,status,open_amount,min_amount,max_amount,created_at)
              VALUES (?,?,'Open Top-up',0,'BDT','topup',1,'active',1,1000,1000000,?)`).run(plan2, mId, t);

  // Device fleet: one paired Android device with current heartbeat
  const devId = 'dev_demo000000000000001';
  const devToken = 'devt_' + crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO devices (id,name,model,app_version,token_hash,status,last_heartbeat_at,battery,queue_depth,permissions,created_at)
              VALUES (?,?,'Samsung A13','3.0.1',?,'online',?,87,0,'sms_read,notification_listener,internet',?)`)
    .run(devId, 'Fleet-Phone-01', hash(devToken), t, t);
  db.prepare('UPDATE devices SET token_hash=? WHERE id=?').run(hash(devToken), devId); // keep hash; plaintext shown once

  // Wallet pool across providers, all on the demo device
  const wallets = [
    ['wal_bkash00000000000001', 'BKASH', '01711000001', 'Rahim Uddin'],
    ['wal_bkash00000000000002', 'BKASH', '01711000002', 'Karim Ahmed'],
    ['wal_nagad000000000000001', 'NAGAD', '01822000001', 'Salam Bibi'],
    ['wal_rocket00000000000001', 'ROCKET', '01933000001', 'Noor Jahan'],
  ];
  for (const [id, provider, msisdn, holder] of wallets) {
    db.prepare(`INSERT INTO wallets (id,provider,msisdn,holder_name,device_id,sim_slot,status,daily_limit,monthly_limit,today_total,month_total,concurrency_cap,created_at)
                VALUES (?,?,?, ?,?,1,'active',2500000,25000000,0,0,5,?)`).run(id, provider, msisdn, holder, devId, t);
  }

  // Staff user (admin console). Dev password: paygate-admin-2026 ; 2FA stub via code "246810".
  const staffId = 'stu_demo000000000000001';
  db.prepare('INSERT INTO staff_users (id,email,pass_hash,role,totp_secret,created_at) VALUES (?,?,?,?,?,?)')
    .run(staffId, 'ops@paygate.local', hash('paygate-admin-2026'), 'owner', 'TOTP-DEV-STUB', t);

  return {
    seeded: true,
    merchant_id: mId,
    api_key_live: skLive,
    api_key_test: skTest,
    webhook_secret: whSecret,
    device_token: devToken,
    plan_fixed: plan1,
    plan_open: plan2,
    staff_email: 'ops@paygate.local',
    staff_password: 'paygate-admin-2026',
    staff_totp: '246810',
  };
}

module.exports = { seed };
