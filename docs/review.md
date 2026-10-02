# Manual review

Anything the pipeline does not approve automatically waits in a queue for a person on the **tenant's own staff**. The review UI is served by the service itself at `/review`; it is a few static files with no framework and no third-party resources.

## Accounts

- One account per person, belonging to exactly one tenant. Email is globally unique.
- Created and managed from the CLI (there is no self-service signup): `pnpm reviewer create|reset|disable|enable`. A strong random password is generated and shown once; `REVIEWER_PASSWORD` (min 12 characters) can supply one instead.
- Passwords are hashed with scrypt (N=2^15, r=8, p=1, per-password salt). The stored string carries its parameters, so the cost can be raised later.
- Resetting or disabling an account ends its browser sessions.

## Sign-in

- `POST /review/api/login` sets a random session token in an `HttpOnly`, `SameSite=Strict`, `Path=/review` cookie (`Secure` when `PUBLIC_BASE_URL` is https). Only the token's SHA-256 is stored.
- Sessions last at most 8 hours and expire after 60 minutes idle.
- Every failure (unknown email, wrong password, disabled or locked account) returns the same `401 Invalid email or password`, and a password hash is always computed, so neither the message nor the timing reveals which accounts exist.
- Rate limits: `LOGIN_RATE_LIMIT` attempts per minute per IP (default 10), plus an account lock of 15 minutes after 5 consecutive failures. Behind a reverse proxy, enable Express `trust proxy` so the limit sees the real client IP.
- State-changing requests (and login) must come from our own origin: a request with a foreign `Origin` header is refused with 403, on top of `SameSite=Strict`.
- Optional TOTP second factor is planned: add a secret column and a second step after the password check in `ReviewAuthService.login`; nothing else needs to change.

## API (cookie authenticated, all scoped to the reviewer's tenant)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/review/api/login`, `/review/api/logout` | Sign in / out |
| `GET` | `/review/api/me` | Current reviewer |
| `GET` | `/review/api/sessions?cursor=` | Sessions in `NEEDS_REVIEW`, oldest first, 25 per page |
| `GET` | `/review/api/sessions/:id` | Expected data, document list, automated results |
| `GET` | `/review/api/sessions/:id/documents/:kind` | The image, decrypted in memory for this response only |
| `POST` | `/review/api/sessions/:id/decision` | `{ decision: "APPROVED" \| "REJECTED", reason? }` |

A session of another tenant is indistinguishable from one that does not exist (`404`). A decision only applies to a session still in `NEEDS_REVIEW`; with simultaneous decisions exactly one wins and the others get `409`.

## What is recorded

- `review.document_viewed` `{ kind, reviewerId }` each time an image is opened.
- `review.decided` `{ decision, reviewerId, hasReason }`. The free-text reason is stored on the session (and sent to the tenant), not in the audit log. Audit entries hold events and field names, never values.
- The reviewer's identity is not exposed through the tenant API or webhooks.

## Documents

Images are read from encrypted storage, decrypted into memory, and sent with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and a `default-src 'none'; sandbox` CSP. Nothing is written back to disk in the clear (a test scans the storage directory to prove it).

## UI hardening

The page is served with `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'`, so inline script, inline style, framing and third-party loads are blocked. Every value from the API is written with `textContent`, never as HTML.

## Known gaps

- No password change screen yet (use `pnpm reviewer reset`).
- Login and logout events are not audit-logged, because the audit log is per session; a general security log is a follow-up.
- Reviewers see the whole tenant's queue; there is no assignment or locking, so two people can open the same case (the second decision gets a clear conflict message).
