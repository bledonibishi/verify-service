# verify-service

Standalone, multi-tenant identity-verification service: users upload an ID and a selfie, the service checks them (manual review for now, automated checks next), and the calling project gets a signed webhook with the result. Each project using it is a **tenant** with its own API key.

Calling projects never store the ID images — they only receive a status.

## Status

Step 1 of the roadmap is in place: tenants, sessions, encrypted uploads, signed webhooks.

- [x] Tenants + API keys, sessions, uploads, encrypted storage, signed webhooks
- [ ] Admin review queue / UI
- [ ] Face match + ID field extraction (pluggable providers)
- [ ] Liveness, SDK / embeddable upload widget, document retention job, webhook retries

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
| `GET` | `/v1/sessions/:id` | Current `status` and which documents are uploaded. |

**End-user** (authorised only by the one-time token in the URL)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/upload/:token/:kind` | Multipart field `file` (JPEG/PNG/WebP, max 8 MB). `kind` is `ID_FRONT`, `ID_BACK` or `SELFIE`. Re-uploading replaces the earlier file. |
| `POST` | `/v1/upload/:token/submit` | Finish. Requires `ID_FRONT` and `SELFIE`. |

Statuses: `PENDING`, `PROCESSING`, `NEEDS_REVIEW`, `APPROVED`, `REJECTED`, `EXPIRED`.

### Webhooks

`POST` to the tenant's webhook URL with JSON `{ type, sessionId, externalRef, status, occurredAt }`.

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
