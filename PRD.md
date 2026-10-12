PayGate Platform — Product Requirements Document v3.0
Merchant SaaS (Next.js + Supabase) · Includes the shared "Gate UI" design system · Companion: PayGate SMS Forwarder PRD v3.0 · Date: 13 October 2026 · Status: Draft for review
1. Product at a glance
PayGate lets Bangladeshi merchants accept bKash, Nagad and Rocket payments with no provider integration. Customers pay a PayGate-owned wallet and quote a unique reference. A PayGate-run phone fleet forwards the confirmation SMS, the server matches it to the payment, the merchant gets a signed webhook, and PayGate settles to the merchant later.
Actor
Does
Never does
Merchant
Defines pricing plans, calls the API or uses the hosted page, receives webhooks and payouts
Install an app, use their own wallet, handle SMS
Customer
Opens the pay page or popup, copies the wallet number and reference, pays, enters the TrxID and clicks Confirm payment
Needs an account or an app
PayGate Ops
Runs the wallet pool and phone fleet, resolves exceptions, approves payouts
Matches payments by hand unless flagged
PayGate server
Assigns wallets, parses SMS, matches by reference, keeps the ledger
Trusts the phone; the server is the authority
In scope: plans, payments API, hosted pay page, matching, webhooks, ledger, settlement and payouts, admin console, phone fleet. Out of scope: iOS forwarder, card payments, provider APIs, executing refunds in wallets (recorded only).
System map: how a payment travels
1. Merchant site or app calls the Payments API with a plan_id.
2. PayGate picks a wallet from the pool, issues a unique reference, and the pay page (redirect or popup) shows both to the customer.
3. Customer copies the wallet number and reference, pays from their wallet app, then enters the TrxID and presses Confirm payment; the page shows a loading screen.
4. The wallet provider sends a received-money SMS to the PayGate phone that holds that wallet.
5. The phone forwards the SMS; SMS ingest parses it and maps the SIM to its wallet.
6. The matching engine checks the customer's TrxID against the SMS (amount, wallet, time and reference must agree) and marks the payment paid; the loading screen turns into the confirmation message.
7. The webhook sender notifies the merchant with a signed, retried webhook.
8. The ledger records the 5% fee and the net amount; PayGate Ops approve payouts to the merchant's bank or MFS wallet once the balance reaches Tk 1,000.
The highlighted box (Matching engine) is the only place a payment becomes paid. Everything to its left is how evidence arrives; everything to its right is what happens because of it.
2. Core payment flow
The customer pays, enters the TrxID and presses Confirm payment; the pay page shows a loading state while PayGate matches the claim against the forwarded SMS. If the SMS has already arrived the answer is instant; if not, PayGate keeps checking for up to 90 seconds. Anything inconsistent goes to the admin review queue.
3. Features
Area
Feature
Pri
Merchant
Onboarding: signup, business verification (KYB), payout account, 2FA
P0
Merchant
Pricing plans: create, version, archive; amount in paisa; external_sku for the merchant's own app
P0
Merchant
Payments API: create from plan_id, idempotency key, get, list, cancel
P0
Merchant
Signed webhooks: retries, delivery log, manual resend
P0
Merchant
Dashboard: overview, payments, plans, settlements, developers, settings
P0
Merchant
Settlements: balance, statements, payouts to bank or MFS (minimum Tk 1,000), CSV export
P1
Merchant
Sandbox: test keys and a simulated-SMS tool
P1
Customer
Hosted pay page or popup (redirect or paygate.js): wallet number, exact amount and reference with copy buttons, TrxID field, Confirm payment button, loading and result states, English and বাংলা
P0
Platform
Wallet pool: assignment, limits, drain, health
P0
Platform
SMS ingest and parser: provider patterns, dedupe by client_msg_id, versioned
P0
Platform
Matching engine: checks the customer's TrxID claim against the SMS, reference as cross-check, atomic claim
P0
Platform
Reconciliation: review reasons, unmatched pool, resolve with a note
P0
Platform
Ledger: double entry, fees, settlements, two-person payout approval
P0
Platform
Fraud checks: balance continuity, velocity limits, high-value confirm
P1
Ops
Fleet console: devices, heartbeat, offline alerts, remote revoke and flush
P0
Ops
Alerts: phone offline, reference-coverage drop, stuck queue, failed webhooks
P1
Ops
Audit log of every manual action
P0
4. Plans, references and matching
Pricing plans. Merchants define plans that mirror the prices in their own app or site. POST /v1/payments takes a plan_id and the server sets the amount, so a client can never change it. Editing a plan creates a new version; payments in flight keep a snapshot. Open amounts are off by default and enabled per merchant with a minimum and maximum.
Reference. Exactly 8 characters, for example K7M4X2QH: seven random characters plus a final check character that catches typos. There is no REF prefix, because the parser finds the value by the Ref label in the SMS. Values avoid look-alikes (0/O, 1/I/L), are single use, never reused, and are matched case-insensitively after normalisation (uppercase, strip spaces, hyphens and punctuation). The parser accepts any 6 to 20 character token after the label, then the server validates length and check character; anything else goes to the unmatched pool. The charset must still pass each provider's field limits (see the provider check).
Provider check (launch gate). The product owner's example SMS reads You have received Tk 1,200.00 from 01712750278. Fee Tk 0.00. Balance Tk 1,200.00. TrxID DJC9SZQV0J and Ref REF934P923 at 12/10/2026 15:24. Before building, confirm on real devices for bKash, Nagad and Rocket that (1) the wallet app has a reference field for the transaction type customers use, (2) its length and character limits, and (3) the received-money SMS echoes it, and how it is worded. A provider that does not echo it still works, because the customer's TrxID is the primary proof; the reference then acts only as a cross-check where present.
Wallet assignment. Choose an active wallet for the provider whose phone heartbeat is under 3 minutes old, with limit headroom and fewer pending payments than its concurrency cap; take the least recently assigned, otherwise return 503 no_wallet_available. Each payment keeps offered_wallet_ids and matching accepts any of them, so reassigning a wallet never loses a payment. Wallets in draining get no new payments; wallets above 80% of a limit are drained automatically.
Payment states: created → awaiting_payment → confirming → paid, with terminal expired, cancelled and needs_review. confirming starts when the customer presses Confirm payment.
Matching rules. The customer's TrxID is the claim and the forwarded SMS is the evidence. A claim is checked when the customer presses Confirm and again whenever a new SMS arrives, so order of arrival does not matter. Each check runs in one database transaction on an unclaimed incoming transaction.
1. Confirmed match: the SMS TrxID equals the customer's submitted_trx_id, and amount, provider, receiving wallet (in offered_wallet_ids) and time window all agree. If the SMS carries a reference, it must also equal the payment's reference. Result: paid, matched_by = trxid (trxid+reference when both agree).
2. Conflict: the TrxID matches but amount, wallet or reference disagree. Result: needs_review.
3. No evidence yet: no SMS with that TrxID exists. The payment stays confirming and is re-checked on every new SMS until it expires.
Case
Behaviour
TrxID found and everything agrees
paid; the loading screen ends with the success message
Customer confirms before the SMS arrives
Stays confirming; the page waits up to 90 s, then shows "Still checking" and keeps matching in the background
TrxID found, amount lower or higher
needs_review (underpaid or overpaid); the page explains clearly
TrxID found, wrong provider or wallet not offered
needs_review (wrong_wallet)
TrxID found, SMS reference differs from this payment's
needs_review (conflict)
TrxID already claimed by another payment
Rejected with "This TrxID was already used"; the first valid claim wins
Payment expired when the SMS arrives
needs_review (late_payment)
No SMS for the TrxID by expiry
expired; money found later goes to the unmatched pool
Wrong TrxID typed
Behaves like "no SMS yet"; a format check blocks obvious typos; 5 failed attempts lock the page for 15 min; PayGate never reveals another customer's TrxID
SMS arrives with no claim
Unmatched pool (or paid if auto-confirm is on and the reference matches)
Same SMS delivered twice
Duplicate by client_msg_id; no second claim
Wallet's phone offline when the customer pays
Stays confirming; completes when the phone reconnects
Fees and payouts. PayGate charges 5% per paid transaction, stored as fee_rate_bps = 500 on the merchant so it can be changed later. fee_amount is 5% of the payment amount, rounded to the nearest paisa, and net_amount = amount - fee_amount; both are written to the ledger when the payment is paid. Merchants are paid out to a bank account or an MFS wallet (bKash, Nagad or Rocket) registered in their payout account. A payout is created only when the merchant's available balance, after fees and holds, is Tk 1,000 or more; smaller balances keep accumulating. Every payout needs two-person approval and is recorded in the ledger and audit log.
Checkout and confirm flow
The merchant's Subscribe button opens PayGate in one of two modes that share the same pay page.
Mode
What happens
Redirect
The merchant server creates the payment and redirects to pay_url (pay.paygate.com/p/<id>). After the result PayGate redirects to success_url or cancel_url.
Popup
paygate.js opens the pay page in an overlay and relays paid, needs_review, expired and closed events to the merchant's page.
A redirect or popup event is never proof of payment: the merchant confirms by webhook or GET /v1/payments/:id.
1. The pay page opens with the amount, provider tabs, and the wallet number and reference, each with a copy button.
2. The customer pays in their wallet app and pastes the reference.
3. The customer returns, enters the TrxID (checked against the provider's format) and presses Confirm payment.
4. A loading screen appears. POST /v1/pay/:id/confirm holds for up to 90 s (the page also listens on Realtime) while PayGate matches the claim.
5. The page shows one of the results below.
Result
Message
Next
Paid
"Payment received" with amount and order
Back to shop
Still checking (after 90 s)
"We haven't seen your payment yet. It can take a minute."
Keep waiting (it completes automatically), re-check the TrxID, contact support
Needs review
"We received Tk X but expected Tk Y. Our team will review it."
Support link; merchant notified
TrxID already used
"This TrxID was already used."
Re-enter
Expired
"This payment link has expired."
Start again from the shop
Auto-confirm (optional, per merchant, off by default): if an incoming SMS has a reference that matches a pending payment and the amount agrees, PayGate marks it paid without waiting for the customer to press Confirm. This removes a customer step but accepts reference-only proof.
Security note: TrxID-only proof (when a provider does not echo the reference) is weaker, because another payer who has seen a TrxID could try to claim it. PayGate therefore compares amount, wallet and time window, lets the first valid claim win, sends any later conflicting claim to review, and can require staff approval above a merchant-set amount.
Recurring plans: a mobile-wallet transfer cannot be charged automatically, so each billing period creates a new payment. PayGate sends the customer a reminder with a fresh pay link, and the merchant receives an invoice.created webhook and sets a grace period.
5. Architecture, data and API
One backend (Next.js Route Handlers on Vercel) and one database (Supabase Postgres in the nearest Asian region). Phones only push SMS and heartbeats in; they never read merchant data.
Table
Key fields
merchants
id, name, status, kyb_status, payout_account (bank or MFS), fee_rate_bps (default 500), risk_tier, webhook_secret_hash
pricing_plans
id, merchant_id, name, amount, currency, external_sku, version, status
wallets
id, provider, msisdn, holder_name, device_id, sim_slot, status, daily_limit, monthly_limit, today_total, last_assigned_at
devices
id, name, model, app_version, token_hash, status, last_heartbeat_at, battery, queue_depth, permissions
payments
id, merchant_id, plan_id, plan_snapshot, order_id, provider, wallet_id, offered_wallet_ids, amount, fee_amount, net_amount, reference (unique), status, review_reason, matched_by, submitted_trx_id, confirmed_at, idempotency_key, expires_at, paid_at
incoming_txns
provider, trx_id, wallet_id, amount, balance_after, ref_raw, ref_normalized, raw (encrypted), client_msg_id, sim_slot, claimed_payment_id, flags, received_at. Key (provider, trx_id, wallet_id)
ledger_entries, settlements, payouts
Double entry: pay-in, fee, merchant payable, payout, refund record. Balance is always computed from the ledger
webhook_deliveries, audit_log
Attempt history; every manual action with actor, before, after, IP
Conventions: timestamptz, amounts as integer paisa, prefixed text IDs, Row Level Security on merchant_id, indexes on payments(reference), incoming_txns(ref_normalized), payments(merchant_id, status, created_at).
Endpoint
Auth
Purpose
POST /v1/plans, GET /v1/plans, PATCH /v1/plans/:id
Merchant key
Manage plans (edit = new version)
POST /v1/payments
Merchant key + Idempotency-Key
Body { plan_id, order_id, provider, callback_url?, success_url?, cancel_url?, metadata? }. Returns id, amount, reference, wallet { provider, number, holder_name }, pay_url, expires_at
GET /v1/payments, GET /v1/payments/:id, POST /v1/payments/:id/cancel
Merchant key
Read and cancel
GET /v1/pay/:id, POST /v1/pay/:id/confirm
Public, rate limited
Pay page data; the customer's TrxID and Confirm payment, held up to 90 s while matching
GET /v1/balance, GET /v1/settlements, POST /v1/payouts
Merchant key
Money views and payout requests
POST /v1/devices/pair
Pairing code
Exchange an admin-issued code for a device token
POST /v1/sms/webhook, POST /v1/devices/heartbeat
Device token
Ingest SMS (sender, body, client_msg_id, received_at, sim_slot, ref_hint, parser_version) and health
/v1/admin/*
Staff session + 2FA
Wallets, devices, review queue, KYB, payout approvals
SMS webhook replies: 200 {stored}, 200 {ignored}, 200 {duplicate}, 401 revoked, 422 unparseable (kept and flagged), 429 or 5xx retry.
Merchant webhooks. Events payment.paid, payment.expired, payment.needs_review, payment.cancelled, each with event_id, reference, plan_id, matched_by, net_amount, settlement_status. Header PayGate-Signature: t=<unix>,v1=<hex> where v1 = HMAC-SHA256(secret, t + "." + rawBody); merchants reject timestamps older than 5 minutes. Retries at 10 s, 1 m, 5 m, 30 m, 2 h, 6 h, 24 h, then failed with a Resend button. GET /v1/payments/:id is always the source of truth.
6. Security, fraud and compliance
• Auth: Supabase Auth with roles owner, staff, developer, viewer; mandatory 2FA for owners and all staff. API keys sk_live_, sk_test_ stored hashed. Device tokens are random 256-bit, stored hashed, rotated every 90 days. Webhook secrets rotate with a 24-hour overlap.
• Layered spoof defence: the phone allows only listed senders and rejects phone-number senders; the server enforces unique TrxID per wallet, single-use references, balance continuity (flag balance_gap), per-provider format fingerprints, velocity limits and an optional high-value confirm threshold. An allowlisted sender ID is not proof of authenticity, so the server never relies on it alone.
• Privacy: raw SMS encrypted at rest and redacted after 90 days; customer numbers masked in the UI with an audited reveal; export and deletion on request.
• Compliance gate (launch blockers, not yet assessed): a legal opinion on whether pooling funds for merchants counts as payment aggregation (licensing, KYC/AML); a check of each provider's terms for personal-type wallets; a funds-recovery runbook for a frozen wallet.
7. Gate UI design system
Gate UI is the one design system for the web app and the Android forwarder. Principle: calm, precise, fast. A quiet canvas, a single accent, data set in monospace, and motion only where state changes. Tokens live in one tokens.json and are generated into Tailwind, CSS variables and Android Color.kt, Type.kt, Shape.kt; Storybook and visual regression tests cover every component.
Token
Light
Dark
Use
bg
#FAFAF9
#0B0B0E
App background
surface / surface-2
#FFFFFF / #F4F4F2
#141418 / #1C1C22
Cards / inputs, table header
border
#E7E7E3
#2A2A31
1 px hairlines
ink / ink-2 / ink-3
#0E0E11 / #55555E / #8A8A94
#F5F5F7 / #A4A4AE / #6F6F7A
Text and primary button / secondary / hints
accent / accent-soft
#5B5BF0 / #EEEEFF
#8B8BFF / #23234A
Focus, links, the reference chip
success
#12B76A
#32D583
Paid, online
warning
#F79009
#FDB022
Needs review, low battery, waiting
danger
#F04438
#F97066
Failed, revoked, offline
Provider dots (never full backgrounds): bKash #E2136E, Nagad #F6921E, Rocket #8C3494; confirm against official brand guidelines. Text pairs meet 4.5:1 and status is never colour alone (icon plus label).
• Type: Inter (UI), Noto Sans Bengali (+10% line height), JetBrains Mono for TrxID, reference, keys and table amounts. Scale: Display 32/40, H1 24/32, H2 20/28, H3 16/24, Body 14/22 (16 on mobile), Caption 12/16, Mono 13/20; hero amounts use tabular numerals.
• Shape and depth: 4-pt grid (4 to 64); radius 8 inputs and chips, 12 buttons, 16 cards, 24 sheets, full for pills; hairlines instead of shadows; a single soft popover elevation; bento-grid cards on dashboards.
• Motion: 120 ms hover, 200 ms state, 320 ms sheets, easing cubic-bezier(.2,.8,.2,1); chip morph and a drawn check on paid; a live pulse on online devices; skeleton loaders; prefers-reduced-motion honoured.
• Power-user feel: dark mode parity, a ⌘K command palette (jump by reference, TrxID, order or merchant), keyboard shortcuts, copy-to-clipboard on every identifier, live tables over Realtime, and a developer console with code samples and a webhook inspector.
Component
Spec
Button
Primary (ink fill), secondary (border), ghost, danger; 40 px (48 mobile); loading keeps width
Input
44 px, surface-2 fill, 2 px accent focus ring, inline validation
Status chip
Pill with dot and label: Pending, Awaiting payment, Paid, Expired, Needs review, Failed
Reference chip
Mono text on accent-soft, copy button, never truncated
Stat card
Caption, Display value, delta chip, sparkline
Data table
Sticky header, 48 px rows, mono IDs, row opens a right drawer; becomes cards on mobile
Wallet and device card
Live dot, battery ring, queue depth, limit meter, last heartbeat, permission ticks
Timeline
Vertical event line for a payment's history
Toast, banner, empty state
Toast 4 s; banner for persistent attention; monoline illustration with one action
Command palette
⌘K, fuzzy search across payments, plans, wallets, devices
Screen
Layout
Hosted pay page
Mobile first, 360 px minimum, under 150 KB; amount, provider tabs, wallet number and reference with copy buttons, TrxID field and Confirm payment button, loading screen, result states, countdown
Merchant dashboard
Sidebar to icon rail to bottom tabs; Overview (four stat cards, attention queue, recent payments), Payments, Plans, Settlements, Developers, Settings
Admin console
Fleet, Wallet pool, Review queue (split view with suggested match), Payouts (maker-checker), Merchants (KYB), Audit log
The reference is the one accented value on the first screen; the Confirm button and the loading state then lead the customer to a clear result. Accessibility: WCAG 2.2 AA, 44 px touch targets, visible focus, full keyboard use, screen-reader labels, text scaling to 200%, English and বাংলা copy written natively.
8. Targets
Metric
Target
Measured as
SMS to paid latency
p95 under 5 s
server_received_at minus sms_received_at, phones online
Confirm success rate
95% or more of confirmations end in paid with no manual action; p95 under 10 s from pressing Confirm when the SMS has already arrived
paid over all confirmations
Reference coverage
90% or more of received-money SMS carry a reference, per provider
Alert below target
Review load
Under 1% of payments in needs_review
Reviews over all payments
Message loss
0 in the 72 h soak test; under 1 per 100,000 in production
device_seq gaps
Webhook delivery
99% or more succeed within 3 attempts
webhook_deliveries
Availability and speed
99.9% monthly for SMS ingest and pay page; API p95 under 800 ms
Uptime and tracing
Reconciliation
Wallet statements versus ledger differ by 0 each day
Daily job
Scale
100 merchants, 500 devices, 50 SMS/s burst
Load test
Time to first payment
Under 10 min from signup
Funnel analytics
Operations: point-in-time recovery with a quarterly restore test; structured logs with request_id, metrics and tracing; public pay endpoints limited to 10 requests per minute per IP and device ingest to 60 per minute; WCAG 2.2 AA; last two versions of Chrome, Safari, Edge and Samsung Internet.
9. Roadmap
The provider spike and legal review run first because the reference approach and the whole settlement model depend on them. Payouts ship only after legal sign-off.
10. Risks and open questions
Risk
Mitigation
A provider does not echo the reference
TrxID-only mode per provider; coverage alert; Phase 0 spike
Customers mistype the TrxID or reference
Format check on the TrxID field, check character on the reference, per-provider guides, a clear still-checking state after 90 s
Spoofed SMS
Layered defences (section 6); high-value confirm
Licensing or provider terms block pooled collection
Legal gate before payouts; hold launch if unresolved
Wallet limits or a frozen wallet
Wallet diversification, limit-aware assignment, auto drain, recovery runbook
Phone or OEM failure
N+1 phones, MDM kiosk mode, offline detection in 3 minutes
Merchant webhook endpoint down
Retries, manual resend, pull API
1. Settlement schedule and cut-off times: when are eligible balances paid out each day or week? (Rails and the Tk 1,000 threshold are set.)
2. Payout transfer cost: who bears the bank or MFS fee on a payout, PayGate or the merchant?
3. Fee side: the 5% is assumed to be deducted from the merchant's proceeds, not added to the customer's price. Confirm.
4. Hosting region: Supabase offers Singapore and Mumbai, the nearest options to Bangladesh. Default to Singapore until the legal review states any residency rule.
5. Reference length: 8 is assumed to mean 8 characters in total with no REF prefix. Confirm.
