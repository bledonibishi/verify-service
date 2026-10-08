# Integrating verify-service into the pharmacy software

**Audience: the developer or coding agent working on the pharmacy software.** This document is self-contained: you do not need the verify-service source. It describes what to build, the exact API, how to check webhooks, what to store and what never to store, and how to test against a local instance.

## What verify-service does

It verifies that a person holds a genuine Kosovo identity card and (when enabled) that the selfie shows the same person. Your pharmacy software creates a **session** for one person, sends the person to a **hosted capture page** where they photograph their ID and take a selfie, and later receives a **signed webhook** with the result. Today every case is checked by a pharmacist in the verify-service **review screen** before it is approved or rejected (nothing is approved automatically yet), so a result can take minutes or hours.

```
pharmacy server ──1 create session──▶ verify-service ──▶ hostedUrl
       ▲                                                    │ 2 send the customer there
       │ 4 webhook (signed): APPROVED / REJECTED            ▼
       └─────────────────────────────  customer's phone uploads the photos
                          3 pharmacist reviews in verify-service /review
```

## Values you are given (placeholders here)

| Name | Meaning | Where it lives |
| --- | --- | --- |
| `VERIFY_BASE_URL` | Address of the service, e.g. `http://localhost:4100` for testing, `https://verify.example.com` later | server config |
| `VERIFY_API_KEY` | `vk_…`, authenticates your server to verify-service | **server secret only** (env var / secret store). Never in a browser, a mobile app, a repository or a log. |
| `VERIFY_WEBHOOK_SECRET` | `whsec_…`, used to check webhook signatures | server secret only |

If the key leaks, the operator rotates it with `pnpm tenant:rotate-key <tenantId>` (the old key stops at once, or after `--grace-hours=N`). Build your code so the key is read from configuration and can be replaced without a code change.

## Step 1: create a session (server to server)

```
POST {VERIFY_BASE_URL}/v1/sessions
Authorization: Bearer {VERIFY_API_KEY}
Content-Type: application/json

{
  "externalRef": "<your own id for this person or request>",
  "firstName": "Arta",             // optional but strongly recommended: what the ID should say
  "lastName": "Krasniqi",          // optional
  "birthDate": "1990-05-15",       // optional, YYYY-MM-DD
  "requireDrivingLicence": false   // true: also read and cross-check a driving licence
}
```

Reply `201`:

```json
{
  "id": "<session id>",
  "uploadToken": "<one-time token>",
  "uploadUrl": "…/v1/upload/<token>",
  "hostedUrl": "{VERIFY_BASE_URL}/verify#<token>",
  "expiresAt": "2026-10-05T12:01:46.071Z",
  "status": "PENDING",
  "requireDrivingLicence": false
}
```

- Send the customer to **`hostedUrl`** (open it in their browser or a webview). That is all the customer needs.
- The session expires about an hour after creation (`expiresAt`). Create a new one if it expires.
- Supply `firstName`, `lastName` and `birthDate` when you know them: the service compares them with the card and shows any mismatch to the pharmacist. Upper/lower case and `ë`/`ç` never matter. Each identity field is `match`, `near_match` (one letter differs, most likely misread from the card; always left for a person to review), `mismatch`, `not_provided` or `unavailable`: treat any value you do not know as "not a match". Without them every case needs manual review anyway.
- **Do not retry `POST /v1/sessions` blindly** after an unclear failure (timeout): a repeat creates a second session. Use your `externalRef` to avoid sending the same person twice.
- Store: `id` (session id), your `externalRef`, `status`, `expiresAt`. Do **not** store or log the `uploadToken`.
- Errors: `401` bad API key; `400` invalid body; `429` with `"code":"monthly_cap_reached"` when your monthly cap is used up; `5xx` transient.

## Step 2: the customer captures the photos

Nothing for you to build: the hosted page (English, Albanian, Serbian) asks for ID front, ID back and a selfie (and the driving licence when requested), uploads them and submits. The token is in the URL fragment (`#…`), so it never reaches servers or logs. After submitting, the page just says the customer can close it, **so show your own "we are checking" screen** and wait for the webhook (or poll).

If you want your own screens instead of the hosted page, see `UploadClient` in the SDK below.

## Step 3: receive the result (webhook)

verify-service sends `POST` to the webhook address configured for your account, once the case is **decided** (not when it is submitted):

```json
{
  "eventId": "…",
  "type": "session.status_changed",
  "sessionId": "<session id>",
  "externalRef": "<your id>",
  "status": "APPROVED",            // APPROVED | REJECTED | NEEDS_REVIEW
  "occurredAt": "2026-10-05T12:30:00.000Z",
  "verification": { … },           // flags and issue codes only, never document values
  "review": { "decision": "APPROVED", "reason": null, "decidedAt": "…" }   // present after a pharmacist decided
}
```

Headers: `X-Verify-Signature: t=<unix seconds>,v1=<hex>` and `X-Verify-Event-Id` (equals `eventId`).

### You MUST verify the signature

`v1 = HMAC-SHA256(VERIFY_WEBHOOK_SECRET, "<t>.<raw request body>")` as lowercase hex, computed over the **raw bytes** of the body (not a re-serialised JSON). Reject the request if the signature does not match (compare in constant time), or if `t` is more than 5 minutes from your clock. Node example without the SDK:

```js
const crypto = require('crypto');
function verify(rawBody /* Buffer */, header /* X-Verify-Signature */, secret) {
  const parts = Object.fromEntries((header || '').split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.`).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

(Express: use `express.raw({ type: 'application/json' })` for this route so `req.body` is the raw Buffer. The header may carry several `v1=` values during a secret rotation; accept if any matches.)

### Webhook rules

- Answer `2xx` quickly once you have **stored** the event. Anything else (or no answer within 10 s) is retried with growing waits for about a day (9 attempts), then marked failed.
- Delivery is **at-least-once**: **dedupe on `eventId`** (keep the ids you processed). The same event can arrive twice.
- Events can arrive **out of order** after retries: look at `status` and `occurredAt`, not the order of arrival, and never move a person from a final status (`APPROVED`/`REJECTED`) back to a non-final one.
- Redirects are not followed. Use `https` for your webhook address in production.

### What the statuses mean for the pharmacy

| `status` | Meaning | What your software should do |
| --- | --- | --- |
| `PENDING` | Session created, photos not submitted | Wait; offer the link again if it expires |
| `PROCESSING` | Photos submitted, being checked | Show "checking" |
| `NEEDS_REVIEW` | A pharmacist has not decided yet | Show "checking". **Not an approval.** |
| `APPROVED` | Verified | Allow the action (e.g. release the prescription flow) |
| `REJECTED` | Not verified; `review.reason` says why | Do not allow; show a neutral message and offer a retry or a manual check at the counter |
| `EXPIRED` | The link ran out before the photos were submitted | Create a new session |

Treat anything unknown as "not approved". Never approve on `NEEDS_REVIEW`, and never approve on a webhook you could not verify.

## Polling (as a fallback or for testing)

```
GET {VERIFY_BASE_URL}/v1/sessions/{id}
Authorization: Bearer {VERIFY_API_KEY}
```

Returns `{ id, externalRef, status, expiresAt, uploaded: [...], verification, review, … }`. Poll sparingly (every 10 to 30 s while the customer waits; webhooks are the main channel). `404` means no such session for your account.

## Other calls you may need

| Call | Purpose |
| --- | --- |
| `DELETE /v1/sessions/{id}` | Erase a person's session and photos now (a data-subject request). `204`; `409` while it is still processing. |
| `GET /v1/webhook-events?status=FAILED` | See webhooks that gave up. |
| `POST /v1/webhook-events/{id}/retry` | Re-send a failed event after you fixed your endpoint. |
| `GET /v1/usage?month=2026-10` | Your counts for the month, to check an invoice. |

## Data handling rules for the pharmacy software

- **Store only:** the session id, your `externalRef`, the final `status` and `occurredAt`, and `review.reason` if you need it. These are enough to show that a person was verified.
- **Never store or log:** the API key, the webhook secret, the `uploadToken`, the `hostedUrl`, photos, or anything read from a document. The service never returns document values (name, numbers, dates from the card) in results or webhooks, only pass/fail flags and issue codes, and your software should not try to collect them.
- Do not put personal data (names, birth dates) in logs or error messages; log the session id.
- The service deletes the photos itself after the retention period (30 days by default) and the record after 5 years. You can request earlier deletion with `DELETE /v1/sessions/{id}`.
- You tell the service the person's expected name and birth date; treat that as personal data in your own system too.

## Optional: the TypeScript SDK

`@verify-service/client` (folder `sdk/` in the verify-service repository; build with `pnpm sdk:build`, then copy it into your project or `pnpm pack` it) wraps all of the above: `VerifyClient` for your server, `constructWebhookEvent` to verify and parse a webhook, `UploadClient` for your own capture screens in a browser.

```ts
import { VerifyClient, constructWebhookEvent, WebhookSignatureError } from '@verify-service/client';

const verify = new VerifyClient({ apiKey: process.env.VERIFY_API_KEY!, baseUrl: process.env.VERIFY_BASE_URL! });
const session = await verify.sessions.create({ externalRef, firstName, lastName, birthDate });
// send the customer to session.hostedUrl

// webhook route (raw body!):
const event = constructWebhookEvent({ payload: rawBody, signatureHeader: req.header('x-verify-signature'), secret: process.env.VERIFY_WEBHOOK_SECRET! });
```

Any language works with the plain HTTP API above; the SDK is optional.

## Testing against a local instance

The owner runs verify-service locally (see `safe-testing.md`) and gives you `VERIFY_BASE_URL` (for example `http://localhost:4100`), a test API key and a test webhook secret. In this mode:

- Use **fake data or the owner's own data only**. No real customers.
- Plain `http` is acceptable on the local network only. Production must be `https`.
- Face matching and liveness are off, so every case lands in `NEEDS_REVIEW` for a person to decide; ask the owner to approve or reject in the review screen at `{VERIFY_BASE_URL}/review` and watch your webhook arrive.
- Make the webhook address point at your local receiver (the owner sets it: `pnpm tenant:update <tenantId> --webhook-url=http://<your-host>:<port>/webhooks/verify`).

### Test checklist for your integration

1. Create a session; open `hostedUrl`; upload three photos; submit. Your software shows "checking".
2. The owner **approves** the case: your webhook endpoint receives `APPROVED` with a valid signature, and your software allows the action.
3. The owner **rejects** another case with a reason: you receive `REJECTED` and show a neutral message.
4. Send yourself a request with a **wrong signature** (or a body edited by one byte): your endpoint answers `400` and changes nothing.
5. Send the **same event twice** (replay with the same `eventId`): processed once.
6. Make your endpoint return `500` once: the event is retried and then processed once (`GET /v1/webhook-events` shows attempts).
7. Use a wrong API key: you handle `401` without crashing, and without logging the key.
8. Let a session expire: you handle `EXPIRED` / `410` and offer a new link.
9. Check that no photo, token or API key appears in your logs or database.

## Not available yet (design around it)

- **Automatic approval** (needs a liveness check, not built): every case waits for a pharmacist, so build the "checking" state seriously.
- **A return redirect** after the customer submits: the hosted page only says they can close it.
- **Live camera preview** on the capture page: it uses the phone's camera through the file picker.
- **HTTPS** for the local test setup: production must have it.
