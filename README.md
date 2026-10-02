# verify-service

Standalone, multi-tenant identity-verification service: users upload an ID and a selfie, the service checks them (manual review for now, automated checks next), and the calling project gets a signed webhook with the result. Each project using it is a **tenant** with its own API key.

Calling projects never store the ID images — they only receive a status.

## Status

Step 1 of the roadmap is in place: tenants, sessions, encrypted uploads, signed webhooks.

- [x] Tenants + API keys, sessions, uploads, encrypted storage, signed webhooks
- [x] Kosovo MRZ module: TD1 parser, check digits, OCR repair, name/DOB cross-check (`src/documents/mrz`, see [docs/kosovo-documents.md](docs/kosovo-documents.md))
- [x] Verification pipeline: background worker reads the ID back MRZ (Tesseract), checks it against the expected identity and expiry, stores flags and issue codes
- [ ] Driving licence field extraction
- [ ] Admin review queue / UI (individual reviewer accounts)
- [x] Face match: ID portrait vs selfie behind a `FaceProvider` interface (AWS Rekognition, per-tenant threshold)
- [ ] Liveness
- [ ] Per-tenant retention, evidence export, NFC chip SDK, billing
- [ ] SDK / embeddable upload widget, retention job, webhook retries

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
| `POST` | `/v1/sessions` | Start a verification. Body: `externalRef` (your user id), optional `firstName`, `lastName`, `birthDate` (`YYYY-MM-DD`). Returns `id`, `uploadToken`, `uploadUrl`, `expiresAt`. |
| `GET` | `/v1/sessions/:id` | Current `status`, which documents are uploaded, and `verification` (null until the automated checks have run). |

**End-user** (authorised only by the one-time token in the URL)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/upload/:token/:kind` | Multipart field `file` (JPEG/PNG/WebP, max 8 MB). `kind` is `ID_FRONT`, `ID_BACK` or `SELFIE`. Re-uploading replaces the earlier file. |
| `POST` | `/v1/upload/:token/submit` | Finish. Requires `ID_FRONT` and `SELFIE`; `ID_BACK` is needed for the MRZ checks. Returns `PROCESSING` immediately. |

Statuses: `PENDING`, `PROCESSING`, `NEEDS_REVIEW`, `APPROVED`, `REJECTED`, `EXPIRED`.

### Verification pipeline

Submitting queues a job (Postgres-backed, `FOR UPDATE SKIP LOCKED`, lease + retries with backoff). The worker decrypts `ID_BACK` in memory, runs OCR through the `OcrProvider` interface (`src/ocr`; Tesseract CLI today, image sent on stdin so nothing is written in the clear), finds the MRZ, validates check digits and expiry, and compares name and date of birth with what the tenant supplied when creating the session.

Decisions are conservative:

- The only automatic outcome is `APPROVED`, and only if the tenant has **auto-approve** on (default off; `pnpm tenant:create "name" [webhookUrl] --auto-approve`) *and* every check passed with no issue at all: MRZ found, all check digits valid, no OCR repair, surname, given names and date of birth all matching, not expired. Supplying no expected identity, or any mismatch, never auto-approves.
- Nothing is rejected automatically. Everything else, including unreadable images, missing `ID_BACK`, a missing OCR engine and repeated pipeline failures, goes to `NEEDS_REVIEW`.
- Auto-approval also needs a **face match**: the portrait on `ID_FRONT` compared with the `SELFIE` must reach the tenant's threshold. If face matching is not configured, unavailable, finds no face or scores below the threshold, the session goes to review. Liveness (is the selfie a live person?) is not implemented yet, so a held-up photo of a photo is not detected; keep that in mind before enabling auto-approve.

`verification` (in `GET /v1/sessions/:id` and the webhook) holds flags and issue codes only, never names, dates or numbers read from the card:

```json
{ "decision": "NEEDS_REVIEW", "autoDecided": false,
  "mrz": { "found": true, "valid": true, "repaired": false },
  "identity": { "surname": "match", "givenNames": "match", "birthDate": "mismatch" },
  "expired": false, "face": { "status": "match", "similarity": 96.3, "provider": "rekognition" }, "checks": [{ "field": "documentNumber", "ok": true }], "issues": ["BIRTH_DATE_MISMATCH"] }
```

Issue codes are the MRZ parser's (`CHECK_DIGIT_MISMATCH`, `OPTIONAL_DATA_PRESENT`, `OCR_REPAIRED`, ...) plus `ID_BACK_MISSING`, `MRZ_NOT_FOUND`, `SURNAME_MISMATCH`, `GIVEN_NAMES_MISMATCH`, `BIRTH_DATE_MISMATCH`, `EXPECTED_IDENTITY_MISSING`, `DOCUMENT_EXPIRED`, `OCR_UNAVAILABLE`, `PIPELINE_ERROR`.

**Face match.** `FACE_PROVIDER=rekognition` (with `AWS_REGION`, e.g. `eu-central-1`) sends the `ID_FRONT` and `SELFIE` bytes to AWS Rekognition `CompareFaces`; it is off by default (`none`), so no image leaves the host unless you opt in. Credentials come from the SDK's default chain: environment variables locally, an IAM role in production. A minimal IAM policy allows `rekognition:CompareFaces` only. The tenant threshold (default 90, `pnpm tenant:create … --face-threshold=92`) is applied by the service, not by AWS. Results hold the similarity score and status (`match`, `below_threshold`, `no_face`, `unusable_image`); no face data or images are stored. Extra issue codes: `FACE_BELOW_THRESHOLD`, `FACE_NOT_DETECTED`, `FACE_MULTIPLE_FACES` (the selfie must contain exactly one face), `FACE_IMAGE_UNUSABLE`, `FACE_UNAVAILABLE` (provider off or credentials rejected; logged as a warning when a provider is configured), `ID_FRONT_MISSING`, `SELFIE_MISSING`. Rekognition's 5 MB limit and JPEG/PNG-only support are checked before calling AWS, so larger images and WebP are never sent and go to review as `FACE_IMAGE_UNUSABLE`. The threshold must be above 0 and at most 100 (0 would make the check meaningless).

OCR needs the `tesseract` binary on the host (`brew install tesseract` / `apt install tesseract-ocr`). Accuracy on real cards has not been tuned yet; see the PR notes.

### Webhooks

`POST` to the tenant's webhook URL with JSON `{ type, sessionId, externalRef, status, occurredAt, verification }`. It is sent once the pipeline has decided (not at submit).

Header `X-Verify-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC-SHA256(webhookSecret, "<t>.<raw body>")`. Verify the signature and reject old timestamps.

## Security notes

- Documents are encrypted with AES-256-GCM before they are written to storage; the key comes from `STORAGE_ENCRYPTION_KEY`.
- Upload tokens and API keys are stored only as SHA-256 hashes.
- File types are detected from magic bytes, not the client's content-type.
- Never commit `.env`; `.env.example` documents every variable.

## Develop

```bash
pnpm typecheck && pnpm build
DATABASE_URL=postgresql://verify:verify@localhost:5434/verify pnpm test   # includes an e2e flow against Postgres
```
