# Commercial layer: metering, pricing and billing (design)

Status: **M1 (metering, usage API, report, caps) is implemented; M2 (plans, invoices) and M3 (payment collection) are not.** The owner's decisions are recorded in [Decisions](#decisions-owner-2026-10-05). Nothing here is legal, tax or accounting advice; confirm the payment, VAT and invoicing parts with an accountant and a lawyer who know Kosovo.

## 1. Goals and non-goals

Goals: know exactly what each tenant used, so it can be invoiced correctly and defended in a dispute; protect against a runaway AWS bill; keep the service project-agnostic (no tenant-specific pricing in code).

Non-goals for now: collecting card payments, a customer billing portal, tax calculation, multi-currency.

## 2. What costs money

| Driver | Who pays for it | Metered how |
| --- | --- | --- |
| A submitted verification (OCR, checks, storage, webhook) | us | one count per session that reaches a decision |
| Face match (Rekognition `CompareFaces`) | us, per call | feature flag on the usage event |
| Liveness (when a provider exists) | us, per challenge | feature flag |
| Driving licence read | us (extra OCR) | feature flag |
| Manual review | **the tenant's own staff** | not billed by us; counted for information |
| Storage | us, small, grows with retention | not metered per tenant at first; covered by the base price |

AWS prices must be checked on the day pricing is set; this document deliberately contains no AWS figures.

## 3. Metering

**Unit: one completed verification** = a session that was submitted and reached a decision (`APPROVED`, `REJECTED` or `NEEDS_REVIEW` from the pipeline). Pass or fail costs us the same, so both are billable.

Not billable (recorded, flagged `billable = false` with a reason): sessions never submitted or expired; sessions the pipeline gave up on (`PIPELINE_ERROR`) because that is our failure; sessions erased before completion.

**Event, written in the same transaction as the decision** (the same pattern as the webhook outbox, so a decision always has its usage event and a rolled-back decision never does):

```
usage_events
  id, tenant_id, session_id  UNIQUE        -- one event per session: idempotent
  occurred_at (UTC), quantity (1; negative for a credit)
  billable, non_billable_reason
  face, liveness, licence, auto_decided     -- booleans: which features ran
```

Design rules:

- **No personal data.** Only ids, timestamps and booleans. It does not reference the session by foreign key, so **erasing a person (retention or a data-subject request) does not delete usage**; the invoice trail survives. The session id alone identifies nothing.
- **Idempotent**: a unique constraint on `session_id` makes a repeated pipeline step harmless.
- **Months are UTC calendar months.** A session is counted in the month of `occurred_at` (the decision), not of creation.
- **Corrections are new rows, never edits**: a credit is an event with a negative `quantity` and a reason, so history stays auditable.
- Usage events are kept as long as the company must keep accounting records (to confirm with the accountant), independent of the tenant's document and record retention.

**Tenant-facing**: `GET /v1/usage?month=2026-10` (API key) returns counts per feature for that month, so tenants can reconcile before an invoice arrives. **Operator-facing**: `pnpm usage:report 2026-10` prints a per-tenant CSV for invoicing.

## 4. Cost protection

A tenant (or a bug, or a stolen key) creating sessions in a loop would run up AWS charges. Per-tenant, optional:

- `monthlyVerificationCap`: past it, `POST /v1/sessions` answers `429` with a clear message; existing sessions finish. Default: none for existing tenants, a sensible cap for new ones.
- `softLimitPercent` (default 80): logs a warning and, later, emails the operator.

## 5. Pricing shape (options)

| Option | How it works | Fits | Weakness |
| --- | --- | --- | --- |
| **A. Subscription tiers** (recommended) | Monthly fee includes N verifications; extras at a per-verification price; face/liveness/licence as small add-ons | B2B customers who want a predictable bill (a telehealth portal, a bank) | Needs a plan definition per tenant |
| B. Pure pay-as-you-go | Price per verification, volume discounts | Very small or spiky customers | Unpredictable for the buyer; harder to forecast revenue |
| C. Prepaid credits | Customer buys a block, usage draws it down | Customers who cannot do monthly invoices | Needs a balance ledger and expiry rules |

Recommendation: **A**, with annual contracts for regulated customers (they also need the 5-year record retention, see [retention](retention.md)). Prices are data, not code: a `plans` table (monthly fee, included volume, overage price, add-on prices, currency EUR) and `tenant.plan_id`, so a customer-specific deal is a new row. Numbers are not proposed here: they depend on AWS costs, review effort and what the first customers will pay.

## 6. Billing mechanics and the payment problem

Constraints found while researching (checked 2026-10-05; re-check before relying on them):

- **Stripe does not support businesses in Kosovo** (it is absent from Stripe's supported-country list).
- **Kosovo is not in SEPA.** The central bank has prepared the application but three laws are held up in the Constitutional Court, with no confirmed date. Euro payments to a Kosovo account from the EU therefore go as international transfers, with higher fees and slower settlement than SEPA.
- **Merchant-of-record services** (Paddle and similar) can take card payments and handle sales tax in the buyer's country, but **I could not confirm that a Kosovo business can register as a seller**: Paddle's public pages cover which countries it sells *to* and payout currencies (USD/EUR/GBP/AUD/CAD, bank transfer for EUR/GBP/USD), not which countries sellers may be in. This needs a direct answer from them before it is part of any plan.

Options for collecting money:

1. **Invoice and bank transfer (recommended to start).** The Kosovo company issues a monthly invoice in EUR; local customers pay by local transfer, foreign customers by SWIFT. No payment processor, no card data, nothing to integrate. Works today for B2B, which is the intended market. Cost: manual reconciliation and slower payment from abroad.
2. **Merchant of record**, if card payments from small foreign customers become important. Depends on eligibility (above) and on the fee (typically a percentage of every sale). Integration is a webhook-driven subscription sync, which would be a separate piece of work.
3. **A company abroad** (for example in the EU, UK or US) to open Stripe. This changes tax, legal and banking obligations and is a business decision, not an engineering one.

The service should **not** assume any processor. It meters, produces invoices data and exposes usage; collecting the money stays outside it (an accounting tool or spreadsheet) until the owner picks 2 or 3.

**Invoices** (phase 2): an `invoices` table (tenant, period, status `DRAFT`/`ISSUED`/`PAID`/`VOID`, line items with unit prices copied from the plan at issue time so later price changes never rewrite history, totals, currency, a sequential number per company as required for tax invoices) and a PDF/CSV export. A `DRAFT` is generated from the usage events and reviewed by a person before it is issued. VAT handling (domestic customers, exports to the EU) is for the accountant to define; the service stores a tax rate and a reason per invoice and calculates nothing on its own.

## 7. Data model sketch

```
plans(id, name, currency, monthly_fee_cents, included_verifications,
      overage_cents, face_addon_cents, liveness_addon_cents, licence_addon_cents)
tenants + plan_id, monthly_verification_cap, soft_limit_percent
usage_events(...)        -- section 3
invoices(id, tenant_id, number UNIQUE, period_start, period_end, status, currency,
         subtotal_cents, tax_rate_bp, tax_reason, total_cents, issued_at, paid_at)
invoice_lines(invoice_id, description, quantity, unit_cents, amount_cents)
```

Amounts are integer cents. Unit prices are copied onto invoice lines. Rounding: per line, half up, documented.

## 8. Phases

### What M1 does today

- **Usage events** (`usage_events`) are written by the verification worker in the decision transaction: one per completed verification, unique per session, with `face` / `liveness` / `licence` / `auto_decided` flags. A session the pipeline gave up on (`PIPELINE_ERROR`) or could not read for lack of an OCR engine (`OCR_UNAVAILABLE`) is recorded as **not billable** with that reason. Sessions never submitted or expired write nothing. Erasing a person does not touch usage (no foreign key to the session).
- **`GET /v1/usage?month=2026-10`** (API key): billable, non-billable (by reason), adjustments, net, add-on counts, and the cap. **`GET /v1/usage/events`** lists the events behind the totals, oldest first, 100 per page. Both are tenant-scoped; `VerifyClient.usage.get/events` wrap them.
- **`pnpm usage:report 2026-10 [tenantId]`** prints a CSV for invoicing with every tenant listed (zeros included, so nothing silently drops out of an invoice run). Tenant names that start with `=`, `+`, `-` or `@` are neutralised so a spreadsheet cannot run them as formulas.
- **`pnpm usage:adjust <tenantId> 2026-10 -3 "reason"`** adds a correction row (negative is a credit); history is never edited. The note must not contain personal data.
- **Monthly cap** per tenant (`--monthly-cap=N|none`, `--soft-limit=80` on `tenant:create` / `tenant:update`): once billable verifications this month plus sessions in flight reach the cap, `POST /v1/sessions` answers `429` with `code: "monthly_cap_reached"`. The check runs inside the session-creation transaction under a per-tenant lock, so parallel requests cannot overshoot (a test shows 12 parallel creations let exactly 3 through under a cap of 3). Sessions waiting for photos count until they expire (default 60 minutes). Our own failures do not use the cap. At the soft limit a warning is logged once per month.

Known limits of M1: no prices or invoices; the soft limit only logs (no email); the cap counts the UTC month; changing a tenant's cap applies at once; metering starts when this ships (earlier sessions have no usage event, so back-fill is a separate decision if past usage must be billed).

### Plan

1. **M1: metering and visibility (done).** `usage_events` in the decision transaction, `GET /v1/usage`, `pnpm usage:report`, per-tenant monthly cap, tests (idempotency, erasure keeps usage, non-billable reasons, tenant isolation, no personal data). No prices yet.
2. **M2: plans and invoices.** `plans`, `invoices`, draft generation from usage, CSV/PDF export, a CLI to issue and mark paid.
3. **M3: payment collection**, only after the owner chooses an option in section 6.

## 9. Risks and open questions

- Defining "completed" so a retry or replay cannot double-count: handled by the unique session id, to be tested under concurrency.
- A tenant disputing a count: the event list per month (with session ids the tenant already holds) is the evidence.
- Pricing in EUR only; tenants billed in other currencies are out of scope.
- If a merchant of record is chosen later, it may want to own the subscription state; metering must stay the source of truth for usage regardless.

## Decisions (owner, 2026-10-05)

1. **Billable unit**: every completed verification except our own failures. Pass or fail is billed; never submitted, expired and pipeline-gave-up sessions are not.
2. **Pricing shape**: subscription tiers with included volume, extras per verification, add-ons for face match, liveness and licence.
3. **Collecting money first**: invoice and bank transfer. No payment processor is integrated.
4. **Scope now**: **M1 only**: metering, usage API, operator report and per-tenant caps. No prices, plans or invoices yet (M2), no payment collection (M3).

Still open for later: the numbers (depend on AWS costs and what customers will pay), VAT treatment (accountant), and whether a merchant of record is ever needed (needs a direct answer from the provider about Kosovo sellers).
