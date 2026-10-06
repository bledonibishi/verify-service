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
- Rate limits: `LOGIN_RATE_LIMIT` attempts per minute per IP (default 10), plus an account lock of 15 minutes after 5 consecutive failures. Behind a reverse proxy, set `TRUST_PROXY=1` (the number of proxies, or `loopback`) so the limit sees the real client IP; without it every visitor shares the proxy's address.
- State-changing requests (and login) must come from our own origin: a request with a foreign `Origin` header is refused with 403, on top of `SameSite=Strict`.
- **Two-factor sign-in** (below) is optional per reviewer and can be required per tenant.

## Two-factor sign-in

Reviewers can add a code from an authenticator app (Google Authenticator, Authy, 1Password and the like: time-based, six digits, 30 seconds) to their sign-in, so a phished or reused password is no longer enough to open customers' ID photos.

- **Setting it up** (Security button in the header): enter your password, add the setup key to your app, confirm with a code. The service then shows **ten single-use recovery codes, once**. Turning it on signs out every other browser of that reviewer.
- **Signing in** is two steps: the password gives a **challenge** (five minutes, a handful of guesses, grants nothing, no cookie), then a code or a recovery code opens the session. Every failure gives the same message. A code is accepted for the current 30-second step and one either side (clock drift), **once**: a code that was already used, or an earlier one, is refused, even in parallel requests.
- **Lockout** counts both steps: five wrong passwords or codes lock the account for 15 minutes.
- **Required per tenant**: `pnpm tenant:update <id> --require-reviewer-2fa` (and `--no-require-reviewer-2fa`). A reviewer without it can still sign in but can only reach the setup screens (everything else answers `403` with `code: "two_factor_setup_required"`), and the rule applies at once to people already signed in. Where it is required it cannot be turned off.
- **Changing it** (turning off, new recovery codes) needs the password **and** a current code or recovery code.
- **Lost phone**: an operator runs `pnpm reviewer reset-2fa <email>`, which turns it off, deletes their recovery codes and ends their sessions; under a requirement they set it up again at the next sign-in.
- **Storage**: the authenticator secret is sealed with the same key provider as the documents (KMS in production), bound to its reviewer, and never stored in the clear; recovery codes are stored as hashes. If the key service is down, sign-in answers `503` rather than "wrong code".
- Not included: a QR code (the page shows the setup key and the `otpauth://` address to type or paste), hardware keys/passkeys, SMS codes.

## API (cookie authenticated, all scoped to the reviewer's tenant)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/review/api/login` | Password step: a session cookie, or `{ twoFactorRequired, challenge }` when the reviewer has two-factor on |
| `POST` | `/review/api/login/2fa` | `{ challenge, code }`: the second step (a code or a recovery code) |
| `GET` / `POST` | `/review/api/2fa`, `/2fa/setup`, `/2fa/enable`, `/2fa/disable`, `/2fa/recovery-codes` | Status and management (setup and changes need the password; changes also a code) |
| `POST` | `/review/api/logout` | Sign out |
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
