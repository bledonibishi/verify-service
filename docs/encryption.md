# Encryption of stored documents

Every photo is encrypted **before** it leaves the application, and only ciphertext is written to disk or S3. How the key is held decides what a breach exposes.

| `STORAGE_KEY_PROVIDER` | Key | Use |
| --- | --- | --- |
| `env` (default) | One 32-byte master key in `STORAGE_ENCRYPTION_KEY` | Development and tests |
| `kms` | **AWS KMS envelope encryption** | **Production** |

## What each protects against

| An attacker gets… | `env` | `kms` |
| --- | --- | --- |
| The bucket or disk | ciphertext only | ciphertext only |
| A database dump, or a backup of the server's files **and its configuration** | the master key is in the configuration, so **everything decrypts** | wrapped data keys only: **nothing decrypts** without asking KMS |
| The running server (code execution) | everything | **everything not yet deleted, while the access lasts** (see below) |

KMS does **not** make a compromised server harmless: code running with the server's AWS role can ask KMS to decrypt, so it can read documents while it has that access. What it changes:

- The key that protects the data never leaves KMS and is never in `.env`, a backup, a dump, a log or a laptop.
- **Every decryption is recorded** in AWS CloudTrail, with the tenant and session it was for, so abnormal bulk reads can be seen and alarmed on.
- **Access can be cut at once** (disable the key, or remove the permission) without redeploying anything. With the default settings the effect is immediate, because no data key is kept in memory.
- Permissions are separate: the people who can read the code or the database cannot decrypt anything unless they also hold the AWS permission.

## How `kms` works

For each object the service asks KMS for a fresh random **data key** (`GenerateDataKey`), encrypts the photo with it (AES-256-GCM), stores the **KMS-wrapped** copy of the data key next to the ciphertext, and discards the plaintext data key. Reading reverses it with `Decrypt`. Details that matter:

- **Bound to what it protects.** The KMS *encryption context* is `{ app, purpose, tenant, session }` and the storage key is also authenticated in AES-GCM. A ciphertext moved to another session, tenant or object name fails to decrypt. (The `env` provider's newer format binds the storage key as well.)
- **No data-key cache by default** (`KMS_DEK_CACHE_SECONDS=0`). Every read calls KMS `Decrypt`, so revocation is immediate and **each read leaves an audit event**. Each unwrapped data key is used once and zeroed. You may opt in to a cache (a few seconds to a minute) to cut KMS calls; the cost is that keys read within that time are served from memory, so revoking access takes up to that long to take effect and those reads are not logged individually. The cache holds a private copy, is keyed by context (it can never serve a key for another tenant or session), is bounded to 200 entries and is zeroed on eviction.
- **Failure behaviour.** If KMS is down, throttled or refusing, reads answer `503` (reviewer and evidence endpoints) or are retried (pipeline); nothing is written and nothing is damaged. A document that fails verification is a different, permanent error.
- **Formats.** `VSE1` is the KMS format, `VSE0` the master-key format bound to the storage key; objects written before either existed (no header) are still readable. Because an old object has a random first four bytes, a marker is not trusted on its own: an object only counts as current if it **actually opens** in that format (otherwise the old format is tried), so the migration never skips an old object that merely looks current.

## Setting up KMS (eu-central-1)

1. **Create a key**: KMS → Customer managed keys → Create key → *Symmetric*, *Encrypt and decrypt*. Alias `alias/verify-service-docs`. Region **Europe (Frankfurt)**, next to the S3 bucket.
2. **Turn on automatic key rotation** for it (AWS rotates the key material yearly; nothing in this service needs to change, old objects keep working).
3. **Key administrators** (who may manage the key, not use it) and **key users** (who may use it): make the storage IAM user a *key user*, and keep the number of administrators small.
4. **Allow the storage user** (add to its IAM policy, with the key's ARN):
   ```json
   {
     "Effect": "Allow",
     "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
     "Resource": "arn:aws:kms:eu-central-1:<account-id>:key/<key-id>",
     "Condition": { "StringEquals": { "kms:EncryptionContext:app": "verify-service" } }
   }
   ```
   The condition means that even stolen credentials can only use the key for this application's context.
5. **Configure** (in `.env` only, never `.env.example`):
   ```
   STORAGE_KEY_PROVIDER=kms
   KMS_KEY_ID=alias/verify-service-docs     # or the key ARN
   KMS_REGION=eu-central-1                  # defaults to S3_REGION
   # Credentials: KMS_ACCESS_KEY_ID + KMS_SECRET_ACCESS_KEY (both, used alone), else the storage user's S3_* pair, else an IAM role
   ```
   If `AWS_ACCESS_KEY_ID` (the face-match user) is set and no dedicated keys are, startup refuses rather than silently using the wrong user.
6. Run `pnpm storage:check`: it writes, reads and deletes an object through the configured key provider and prints only pass or fail.

KMS has a small monthly fee per key plus a small fee per request; check the current AWS price page.

## Moving existing documents to KMS

1. Keep `STORAGE_ENCRYPTION_KEY` set (the service uses it **only to read** old objects once KMS is on).
2. Set the KMS variables and restart.
3. `pnpm storage:reencrypt --dry-run` shows how many objects would change (it reads and verifies every object, so it makes one KMS call per document); `pnpm storage:reencrypt` re-encrypts them (add `--tenant=<id>` to do one tenant at a time). It is safe to repeat and to interrupt, never writes an object back after its person was erased (it holds the session's row lock, which erasure also needs), counts anything it cannot convert as failed and leaves it untouched, and prints counts only.
4. When it reports `already current` for everything and `failed: 0`, remove `STORAGE_ENCRYPTION_KEY` from the production configuration. **Keep a sealed offline backup of the old key** for as long as backups made before the migration may need restoring.

Switching back from `kms` to `env` is not supported without re-encrypting first.

## Operations

- **Alarm on KMS use.** Create a CloudWatch alarm on CloudTrail `Decrypt` events for this key (count per hour well above normal) and on `AccessDenied`. That is the main detection a stolen role will trip.
- **Rotating the master key** (`env` provider): not supported; this is one more reason to use `kms`.
- **Losing KMS access** (key deleted or disabled) makes every document unreadable. Scheduled deletion has a mandatory waiting period (7 to 30 days); cancel it if it was a mistake. Do not give anyone `kms:ScheduleKeyDeletion` who does not need it.

## Not covered

- **Application-level keys per tenant.** One KMS key protects all tenants (separated by encryption context). Per-tenant keys are possible later if a customer demands their own key.
- **Other secrets in the database.** Webhook secrets are stored in plain text because the service needs them to sign. Reviewer two-factor secrets (when added) use the same key provider.
- **Backups, the database, and AWS itself** are outside this document.
