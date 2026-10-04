# verify-service

Standalone, multi-tenant identity-verification service: users upload an ID and a selfie, the service checks them (manual review for now, automated checks next), and the calling project gets a signed webhook with the result. Each project using it is a **tenant** with its own API key.

Calling projects never store the ID images — they only receive a status.

## Status

Step 1 of the roadmap is in place: tenants, sessions, encrypted uploads, signed webhooks.

- [x] Tenants + API keys, sessions, uploads, encrypted storage, signed webhooks
- [x] Kosovo MRZ module: TD1 parser, check digits, OCR repair, name/DOB cross-check (`src/documents/mrz`, see [docs/kosovo-documents.md](docs/kosovo-documents.md))
- [x] Verification pipeline: background worker reads the ID back MRZ (Tesseract), checks it against the expected identity and expiry, stores flags and issue codes
- [ ] Driving licence field extraction
- [x] Reviewer accounts, review API and a small review UI at `/review` (see [docs/review.md](docs/review.md))
- [x] Face match: ID portrait vs selfie behind a `FaceProvider` interface (AWS Rekognition, per-tenant threshold)
- [x] Liveness provider layer: `LivenessProvider` interface, challenge endpoint, per-tenant minimum confidence, required for auto-approve (AWS adapter + browser widget come with the upload page)
- [x] Per-tenant retention, data-subject deletion and evidence export (see [docs/retention.md](docs/retention.md))
- [x] S3-compatible storage adapter (eu-central-1, server-side encryption on top of ours), `pnpm storage:check`
- [ ] NFC chip SDK, billing
- [x] Webhook outbox with retries, backoff and replay
- [ ] SDK / embeddable upload widget

## Run locally

```bash
docker compose up -d db                 # Postgres on :5434
cp .env.example .env                    # then set STORAGE_ENCRYPTION_KEY (openssl rand -base64 32)
pnpm install
pnpm prisma migrate deploy
pnpm tenant:create "my-project" https://my-app.example/webhooks/verify
pnpm start:dev                          # http://localhost:4100
```

`tenant:create` prints the API key and webhook secret once. Only a hash of the key is stored.

## API

**Server-to-server** (header `Authorization: Bearer <api key>`)

| Method | Path | Purpose |
| --- | --- | --- |
| `DELETE` | `/v1/sessions/:id` | Erase a session and its documents now (data-subject request). `204`; `409` while it is being processed. |
| `GET` | `/v1/sessions/:id/evidence` and `/evidence/documents/:kind` | Signed evidence bundle and decrypted documents, only for tenants with evidence export enabled. |
| `POST` | `/v1/sessions` | Start a verification. Body: `externalRef` (your user id), optional `firstName`, `lastName`, `birthDate` (`YYYY-MM-DD`). Returns `id`, `uploadToken`, `uploadUrl`, `expiresAt`. |
| `GET` | `/v1/sessions/:id` | Current `status`, which documents are uploaded, and `verification` (null until the automated checks have run). |

**End-user** (authorised only by the one-time token in the URL)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/upload/:token/:kind` | Multipart field `file` (JPEG/PNG/WebP, max 8 MB). `kind` is `ID_FRONT`, `ID_BACK` or `SELFIE`. Re-uploading replaces the earlier file. |
| `POST` | `/v1/upload/:token/liveness` | Start a liveness challenge. Returns `{ provider, sessionId, ... }` for the client widget. `501` if no provider is configured; `410` once the session is submitted or expired, `409` if another start won a concurrent race (retry). Calling again later replaces the earlier challenge. |
| `POST` | `/v1/upload/:token/submit` | Finish. Requires `ID_FRONT` and `SELFIE`; `ID_BACK` is needed for the MRZ checks. Returns `PROCESSING` immediately. |

Statuses: `PENDING`, `PROCESSING`, `NEEDS_REVIEW`, `APPROVED`, `REJECTED`, `EXPIRED`.

### Verification pipeline

Submitting queues a job (Postgres-backed, `FOR UPDATE SKIP LOCKED`, lease + retries with backoff). The worker decrypts `ID_BACK` in memory, runs OCR through the `OcrProvider` interface (`src/ocr`; Tesseract CLI today, image sent on stdin so nothing is written in the clear), finds the MRZ, validates check digits and expiry, and compares name and date of birth with what the tenant supplied when creating the session.

Decisions are conservative:

- The only automatic outcome is `APPROVED`, and only if the tenant has **auto-approve** on (default off; `pnpm tenant:create "name" [webhookUrl] --auto-approve`) *and* every check passed with no issue at all: MRZ found, all check digits valid, no OCR repair, surname, given names and date of birth all matching, not expired. Supplying no expected identity, or any mismatch, never auto-approves.
- Nothing is rejected automatically. Everything else, including unreadable images, missing `ID_BACK`, a missing OCR engine and repeated pipeline failures, goes to `NEEDS_REVIEW`.
- Auto-approval also needs a **face match**: the portrait on `ID_FRONT` compared with the `SELFIE` must reach the tenant's threshold. If face matching is not configured, unavailable, finds no face or scores below the threshold, the session goes to review. Auto-approval additionally requires a passed **liveness** check (see below), so until a liveness provider is wired in, nothing is auto-approved.

`verification` (in `GET /v1/sessions/:id` and the webhook) holds flags and issue codes only, never names, dates or numbers read from the card:

```json
{ "decision": "NEEDS_REVIEW", "autoDecided": false,
  "mrz": { "found": true, "valid": true, "repaired": false },
  "identity": { "surname": "match", "givenNames": "match", "birthDate": "mismatch" },
  "expired": false, "face": { "status": "match", "similarity": 96.3, "provider": "rekognition", "source": "liveness" }, "liveness": { "status": "live", "confidence": 98.1, "provider": "..." }, "checks": [{ "field": "documentNumber", "ok": true }], "issues": ["BIRTH_DATE_MISMATCH"] }
```

Issue codes are the MRZ parser's (`CHECK_DIGIT_MISMATCH`, `OPTIONAL_DATA_PRESENT`, `OCR_REPAIRED`, ...) plus `ID_BACK_MISSING`, `MRZ_NOT_FOUND`, `SURNAME_MISMATCH`, `GIVEN_NAMES_MISMATCH`, `BIRTH_DATE_MISMATCH`, `EXPECTED_IDENTITY_MISSING`, `DOCUMENT_EXPIRED`, `OCR_UNAVAILABLE`, `PIPELINE_ERROR`.

**Face match.** `FACE_PROVIDER=rekognition` (with `AWS_REGION`, e.g. `eu-central-1`) sends the `ID_FRONT` and `SELFIE` bytes to AWS Rekognition `CompareFaces`; it is off by default (`none`), so no image leaves the host unless you opt in. Credentials come from the SDK's default chain: environment variables locally, an IAM role in production. A minimal IAM policy allows `rekognition:CompareFaces` only. The tenant threshold (default 90, `pnpm tenant:create … --face-threshold=92`) is applied by the service, not by AWS. Results hold the similarity score and status (`match`, `below_threshold`, `no_face`, `unusable_image`); no face data or images are stored. Extra issue codes: `FACE_BELOW_THRESHOLD`, `FACE_NOT_DETECTED`, `FACE_MULTIPLE_FACES` (the selfie must contain exactly one face), `FACE_IMAGE_UNUSABLE`, `FACE_UNAVAILABLE` (provider off or credentials rejected; logged as a warning when a provider is configured), `ID_FRONT_MISSING`, `SELFIE_MISSING`. Rekognition's 5 MB limit and JPEG/PNG-only support are checked before calling AWS, so larger images and WebP are never sent and go to review as `FACE_IMAGE_UNUSABLE`. The threshold must be above 0 and at most 100 (0 would make the check meaningless).

**Liveness.** The `LivenessProvider` interface (`src/liveness`) has two halves: `createSession` (called by `POST /v1/upload/:token/liveness`, the provider's browser/mobile widget then runs the challenge) and `getResult` (called by the pipeline after submit). Only `LIVENESS_PROVIDER=none` exists today, so the endpoint answers `501` and nothing is auto-approved; the AWS Face Liveness adapter and the widget arrive with the hosted upload page. Design points already in place:
- A "live" verdict only counts if its confidence reaches the tenant's `livenessMinConfidence` (default 90, `--liveness-threshold=NN`).
- If the provider returns the face image captured during the challenge, the **face match uses that image instead of the uploaded selfie** (`face.source: "liveness"`), so the match is bound to the person who passed liveness. It stays in memory and is never stored. **Auto-approval requires this binding**: a live verdict with a match against the separately uploaded selfie is reported as `FACE_NOT_BOUND_TO_LIVENESS` and goes to review, so a provider must return the challenge image for auto-approve to work.
- Issue codes: `LIVENESS_NOT_PERFORMED` (no challenge started), `LIVENESS_FAILED`, `LIVENESS_INCOMPLETE`, `LIVENESS_UNAVAILABLE` (provider error; logged as a warning, not retried). Transient provider errors are retried like OCR and face failures.
- Results hold status, confidence and provider name only. Note: AWS Face Liveness is not offered in every region (Frankfurt may be unsupported; Ireland, `eu-west-1`, is), which needs a decision when the adapter is built.

OCR needs the `tesseract` binary on the host (`brew install tesseract` / `apt install tesseract-ocr`). Accuracy on real cards has not been tuned yet; see the PR notes.

### Webhooks

`POST` to the tenant's webhook URL with JSON `{ eventId, type, sessionId, externalRef, status, occurredAt, verification?, review? }`, sent once the pipeline or a reviewer has decided (not at submit).

Headers: `X-Verify-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC-SHA256(webhookSecret, "<t>.<raw body>")`, and `X-Verify-Event-Id` (same as `eventId` in the body). Verify the signature, reject old timestamps, and **dedupe on `eventId`**: delivery is at-least-once.

**Reliability.** Events go through an outbox: the event row is written in the same database transaction as the status change, so a decision always has its webhook queued and a rolled-back decision never does. A dispatcher (several instances can run) delivers with a 10 s timeout. Any non-2xx answer, timeout or connection error is retried with growing waits (about 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h, with jitter), 9 attempts in all, and the body is byte-identical each time with a fresh signature timestamp. Redirects are not followed. After the last attempt the event is `FAILED`. Responses are never stored, only a code (`http_500`, `timeout`, `network`, `http_302`).

Tenants can see and replay events (API key):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/webhook-events?status=` | The last 50 events (`PENDING`, `DELIVERED`, `FAILED`) with attempts and the last error code. |
| `POST` | `/v1/webhook-events/:id/retry` | Re-queue a `FAILED` event, for example after fixing the endpoint (`409` otherwise). |

Events are erased with their session; delivered ones are also deleted after 7 days and failed ones after 30 (see `docs/retention.md`). Events for one session can arrive out of order after retries: use `occurredAt` and the `status` itself rather than arrival order.

## Manual review

Sessions that need a person land in a queue at `/review`. Reviewers are individual accounts belonging to one tenant, created from the command line:

```bash
pnpm reviewer create <tenantId> alice@customer.example "Alice"   # prints a one-time password
pnpm reviewer reset alice@customer.example
pnpm reviewer disable alice@customer.example
```

They sign in with email and password, see the documents next to what the tenant supplied and the automated results, and approve or reject (a reason is required to reject and is sent to the tenant). The decision is audit-logged and triggers the signed webhook with a `review` object `{ decision, reason, decidedAt }`; `GET /v1/sessions/:id` returns the same. Details, security model and API in [docs/review.md](docs/review.md).

## Retention

Each tenant has its own retention windows: documents are deleted 30 days after the decision by default, the whole record after 5 years, and unsubmitted sessions a day after their link expires. A scheduled job applies them; `DELETE /v1/sessions/:id` erases a person on request and leaves a record with no personal data. Set windows with `pnpm tenant:create ... --doc-retention-days=N --record-retention-days=N` or `pnpm tenant:update <id> ...`. Details: [docs/retention.md](docs/retention.md).

## Security notes

- Documents are encrypted with AES-256-GCM before they are written to storage (local disk for development, S3 for production, see [docs/storage.md](docs/storage.md)); the key comes from `STORAGE_ENCRYPTION_KEY`.
- Upload tokens and API keys are stored only as SHA-256 hashes.
- File types are detected from magic bytes, not the client's content-type.
- Never commit `.env`; `.env.example` documents every variable.

## Develop

```bash
pnpm typecheck && pnpm build
DATABASE_URL=postgresql://verify:verify@localhost:5434/verify pnpm test   # includes an e2e flow against Postgres
```
