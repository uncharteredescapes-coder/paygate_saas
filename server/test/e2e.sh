#!/usr/bin/env bash
# End-to-end test of the PayGate acceptance criteria (PRD §9).
set -u
BASE=${BASE:-http://localhost:3000}
LOG=/tmp/paygate.log
KEY=$(grep -o 'sk_live_[a-f0-9]*' $LOG | head -1)
TEST=$(grep -o 'sk_test_[a-f0-9]*' $LOG | head -1)
DEV=$(grep -o 'devt_[A-Za-z0-9_-]*' $LOG | head -1)
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ✗ $1 — GOT: $2"; FAIL=$((FAIL+1)); }
jqv(){ node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(eval('j'+process.argv[1]||''))}catch(e){console.log('PARSE_ERR')}})" "$1"; }

echo "== reference format =="
R=$(curl -s -X POST $BASE/v1/payments -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"plan_id":"pln_demo000000000000001","provider":"BKASH"}' | jqv '.reference')
[[ ${#R} -eq 8 ]] && ok "8-char reference $R" || bad "ref length" "$R"

echo "== SMS first, confirm second =="
P=$(curl -s -X POST $BASE/v1/payments -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"plan_id":"pln_demo000000000000001","provider":"BKASH"}')
ID=$(echo $P|jqv '.id'); REF=$(echo $P|jqv '.reference')
curl -s -X POST $BASE/v1/sms/webhook -H "x-device-token: $DEV" -H 'Content-Type: application/json' \
  -d "{\"sender\":\"BKASH\",\"body\":\"You have received Tk 500.00 from 01712750278. Fee Tk 0.00. Balance Tk 5,500.00. TrxID AAAABBBB11 and Ref $REF at 12/10/2026 15:24\",\"client_msg_id\":\"t-m1\"}" >/dev/null
S=$(curl -s -m 5 -X POST $BASE/v1/pay/$ID/confirm -H 'Content-Type: application/json' -d '{"trx_id":"AAAABBBB11"}' | jqv '.status')
[[ $S == paid ]] && ok "paid after confirm with pre-arrived SMS" || bad "sms-first flow" "$S"

echo "== confirm first, SMS second =="
P=$(curl -s -X POST $BASE/v1/payments -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"plan_id":"pln_demo000000000000001","provider":"BKASH"}')
ID=$(echo $P|jqv '.id'); REF=$(echo $P|jqv '.reference')
(curl -s -m 20 -X POST $BASE/v1/pay/$ID/confirm -H 'Content-Type: application/json' -d '{"trx_id":"BBBBCCCC22"}' > /tmp/conf_out.json &)
sleep 1
curl -s -X POST $BASE/v1/sms/webhook -H "x-device-token: $DEV" -H 'Content-Type: application/json' \
  -d "{\"sender\":\"BKASH\",\"body\":\"You have received Tk 500.00 from 01712750278. Fee Tk 0.00. Balance Tk 6,000.00. TrxID BBBBCCCC22 and Ref $REF at 12/10/2026 15:26\",\"client_msg_id\":\"t-m2\"}" >/dev/null
sleep 3
S=$(cat /tmp/conf_out.json | jqv '.status')
[[ $S == paid ]] && ok "confirm held and matched when SMS arrived" || bad "confirm-first flow" "$(cat /tmp/conf_out.json)"

echo "== duplicate SMS dedupe =="
D=$(curl -s -X POST $BASE/v1/sms/webhook -H "x-device-token: $DEV" -H 'Content-Type: application/json' \
  -d "{\"sender\":\"BKASH\",\"body\":\"You have received Tk 500.00 from 01712750278. TrxID BBBBCCCC22 and Ref $REF\",\"client_msg_id\":\"t-m2\"}" | jqv '.result')
[[ $D == duplicate ]] && ok "duplicate client_msg_id ignored" || bad "dedupe" "$D"

echo "== wrong wallet -> needs_review =="
P=$(curl -s -X POST $BASE/v1/payments -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"plan_id":"pln_demo000000000000001","provider":"NAGAD"}')
ID=$(echo $P|jqv '.id'); REF=$(echo $P|jqv '.reference')
curl -s -m 2 -X POST $BASE/v1/pay/$ID/confirm -H 'Content-Type: application/json' -d '{"trx_id":"DDODEEEEFF33"}' >/dev/null 2>&1
curl -s -X POST $BASE/v1/sms/webhook -H "x-device-token: $DEV" -H 'Content-Type: application/json' \
  -d "{\"sender\":\"BKASH\",\"body\":\"You have received Tk 500.00 from 01712750278. TrxID DDODEEEEFF33 and Ref $REF\",\"client_msg_id\":\"t-m3\"}" >/dev/null
sleep 1
J=$(curl -s $BASE/v1/payments/$ID -H "Authorization: Bearer $KEY")
S=$(echo $J|jqv '.status'); RR=$(echo $J|jqv '.review_reason')
[[ $S == needs_review && $RR == wrong_wallet ]] && ok "wrong_wallet flagged" || bad "wrong wallet" "$S/$RR"

echo "== underpaid -> needs_review =="
P=$(curl -s -X POST $BASE/v1/payments -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"plan_id":"pln_demo000000000000001","provider":"BKASH"}')
ID=$(echo $P|jqv '.id'); REF=$(echo $P|jqv '.reference')
curl -s -m 2 -X POST $BASE/v1/pay/$ID/confirm -H 'Content-Type: application/json' -d '{"trx_id":"GGGHHHHI44"}' >/dev/null 2>&1
curl -s -X POST $BASE/v1/sms/webhook -H "x-device-token: $DEV" -H 'Content-Type: application/json' \
  -d "{\"sender\":\"BKASH\",\"body\":\"You have received Tk 450.00 from 01712750278. TrxID GGGHHHHI44 and Ref $REF\",\"client_msg_id\":\"t-m4\"}" >/dev/null
sleep 1
J=$(curl -s $BASE/v1/payments/$ID -H "Authorization: Bearer $KEY"); S=$(echo $J|jqv '.status'); RR=$(echo $J|jqv '.review_reason')
[[ $S == needs_review && $RR == underpaid ]] && ok "underpaid flagged" || bad "underpaid" "$S/$RR"

echo "== trxid already claimed =="
P=$(curl -s -X POST $BASE/v1/payments -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"plan_id":"pln_demo000000000000001","provider":"BKASH"}')
ID=$(echo $P|jqv '.id')
CODE=$(curl -s -o /tmp/used.json -w '%{http_code}' -m 5 -X POST $BASE/v1/pay/$ID/confirm -H 'Content-Type: application/json' -d '{"trx_id":"AAAABBBB11"}')
E=$(cat /tmp/used.json | jqv '.error')
[[ $CODE == 409 && $E == trxid_already_used ]] && ok "second claim of same TrxID rejected" || bad "already-used" "$CODE $E"

echo "== expiry =="
node -e "const D=require('better-sqlite3');const db=new D('$PWD/paygate.db');db.prepare(\"UPDATE payments SET expires_at=datetime('now','-1 hour') WHERE id IN (SELECT id FROM payments WHERE status='awaiting_payment' AND submitted_trx_id IS NULL ORDER BY created_at DESC LIMIT 1)\").run();console.log(db.prepare('SELECT changes c').get().c)" >/dev/null
PID=$(node -e "const D=require('better-sqlite3');const db=new D('$PWD/paygate.db');console.log(db.prepare(\"SELECT id FROM payments WHERE status='expired' ORDER BY created_at DESC LIMIT 1\").get()?.id||'')")
[[ -n $PID ]] && ok "unclaimed payment expired" || bad "expiry" ""

echo "== webhook signature + payload =="
WHL=$(curl -s $BASE/devhook/log)
EVENT=$(echo $WHL | jqv '.data[0].event'); SIG=$(echo $WHL | jqv '.data[0].signature')
[[ $EVENT == payment.paid && ${SIG:0:2} == t= ]] && ok "payment.paid delivered to demo receiver with PayGate-Signature ($SIG…)" || bad "webhook" "$EVENT $SIG"

echo "== fee split & balance =="
BAL=$(curl -s $BASE/v1/balance -H "Authorization: Bearer $KEY")
AV=$(echo $BAL|jqv '.available_balance'); CAN=$(echo $BAL|jqv '.can_request_payout')
[[ $AV == 142500 ]] && ok "net ledger = 3×Tk475 = Tk 1,425.00 (5% fee)" || bad "balance" "$AV"
[[ $CAN == true ]] && ok "payout eligible ≥ Tk 1,000" || bad "payout min" "$CAN"

echo "== sandbox simulate (test key) =="
P=$(curl -s -X POST $BASE/v1/payments -H "Authorization: Bearer $TEST" -H 'Content-Type: application/json' -d '{"plan_id":"pln_demo000000000000001","provider":"ROCKET"}')
ID=$(echo $P|jqv '.id')
SIM=$(curl -s -X POST $BASE/v1/sandbox/simulate-sms -H "Authorization: Bearer $TEST" -H 'Content-Type: application/json' -d "{\"payment_id\":\"$ID\",\"trx_id\":\"SIMTEST123\"}")
S=$(curl -s $BASE/v1/payments/$ID -H "Authorization: Bearer $TEST" | jqv '.status')
[[ $S == paid ]] && ok "sandbox simulated SMS matched payment" || bad "sandbox" "$(echo $SIM) $S"
LIVE=$(curl -s -X POST $BASE/v1/sandbox/simulate-sms -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"payment_id":"x"}' | jqv '.error')
[[ $LIVE == sandbox_only ]] && ok "sandbox blocked for live keys" || bad "sandbox guard" "$LIVE"

echo "== staff login 2FA =="
NO2FA=$(curl -s -X POST $BASE/v1/admin/login -H 'Content-Type: application/json' -d '{"email":"ops@paygate.local","password":"paygate-admin-2026"}' | jqv '.error')
[[ $NO2FA == 2fa_required ]] && ok "2FA mandatory" || bad "2fa" "$NO2FA"
TOK=$(curl -s -X POST $BASE/v1/admin/login -H 'Content-Type: application/json' -d '{"email":"ops@paygate.local","password":"paygate-admin-2026","totp":"246810"}' | jqv '.token')
OV=$(curl -s $BASE/v1/admin/overview -H "x-staff-token: $TOK" | jqv '.needs_review')
[[ -n $OV ]] && ok "admin overview reachable (needs_review=$OV)" || bad "admin" ""

echo "== payout two-person rule =="
PO=$(curl -s -X POST $BASE/v1/payouts -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{}' | jqv '.id')
A1=$(curl -s -X POST $BASE/v1/admin/payouts/$PO/approve -H "x-staff-token: $TOK" | jqv '.status')
A2=$(curl -s -X POST $BASE/v1/admin/payouts/$PO/approve -H "x-staff-token: $TOK" | jqv '.error')
[[ $A1 == approved_by_maker && $A2 == two_person_rule ]] && ok "same staff cannot both approve and execute" || bad "maker-checker" "$A1/$A2"

echo "== rate limit on pay endpoints =="
for i in $(seq 1 12); do curl -s -o /dev/null $BASE/v1/pay/whatever; done
RL=$(curl -s -o /dev/null -w '%{http_code}' $BASE/v1/pay/whatever)
[[ $RL == 429 ]] && ok "public pay endpoint rate limited" || bad "rate limit" "$RL"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]] && echo "ALL ACCEPTANCE TESTS PASSED"