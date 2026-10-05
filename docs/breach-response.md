# Personal data breach response plan (draft)

Status: **draft for the owner to complete and have a lawyer review.** Fill the `[brackets]`, run the drill in section 7 once, and keep a printed or offline copy: you will need this when the systems are the thing that is down. Nothing here is legal advice.

## 1. Why this matters here

The service holds copies of identity cards, selfies and their parsed data for other companies (the tenants). A breach is therefore both a data-protection incident and a customer-trust incident. Facts that shape the response:

- Photos are encrypted before they are stored (S3 or disk) with AWS KMS in production ([encryption](encryption.md)). A leaked bucket or database dump alone does not expose photos; **a compromised server or AWS role can**, for as long as the access lasts.
- Documents are deleted `documentRetentionDays` after the decision (default 30) and records after `recordRetentionDays` (default 1825). What is **not yet deleted** is what is exposed ([retention](retention.md)).
- The database holds: parsed results (pass/fail, issue codes), the name and date of birth the tenant supplied, webhook secrets in plain text, hashed API keys and reviewer password hashes, sealed two-factor secrets. It does **not** hold the MRZ values or the photos.
- Sub-processors: AWS (S3, KMS, Rekognition in `eu-central-1`; Face Liveness, if enabled, in `eu-west-1`). `[hosting provider of the app and database]`.

## 2. Roles

| Role | Person | Contact (keep offline too) |
| --- | --- | --- |
| Incident lead (decides, owns the clock) | `[name]` | `[phone]` |
| Technical responder (contains, collects evidence) | `[name]` | `[phone]` |
| Communications / customer contact | `[name]` | `[phone]` |
| Legal adviser | `[name]` | `[phone]` |
| Backup for each of the above | `[name]` | `[phone]` |

For a one-person operation, the same person may hold several roles; the point is that **someone outside** (the lawyer) is on the list.

## 3. What counts, and the clock

A personal data breach is any accidental or unlawful destruction, loss, alteration, disclosure of, or access to personal data. A stolen key, a public bucket, a mis-sent export, a reviewer account taken over, a tenant seeing another tenant's data, and ransomware all count.

**The clock starts when you become aware**, not when it happened. The controller (normally the tenant) has **72 hours** to notify the supervisory authority where the breach is likely to put people at risk. Check with the lawyer what your contracts say: as a processor you must tell each affected tenant **without undue delay** so they can meet their own deadline. `[Contract wording: notify tenants within __ hours.]`

In Kosovo the supervisory authority is the Information and Privacy Agency (IPA), and the relevant law is Law No. 06/L-082 on Protection of Personal Data (breach notification in Art. 33, per the research notes in this repo; `[lawyer to confirm articles and the current notification form]`).

## 4. First hour: contain

Do these in order. Write the time and what you did for each; the log matters later.

1. **Note the time you became aware** and who reported it. Open an incident log (a dated file or document, kept outside the affected systems).
2. **Do not delete anything** (logs, buckets, accounts) while you investigate; deletion destroys evidence and may itself be a breach.
3. **Cut the access that is being abused**, the smallest thing that stops it:
   - Suspected stolen AWS keys: IAM console → the user → Security credentials → **Make inactive** the access key (then delete once confirmed). This stops S3, KMS and Rekognition use by that key.
   - Suspected server or role compromise: attach an explicit deny policy to the role, or **disable the KMS key** (KMS console → key → Key actions → Disable). With `KMS_DEK_CACHE_SECONDS=0` (the default) every document becomes unreadable at once; re-enable it after the cause is fixed. Do **not** schedule key deletion.
   - Suspected tenant API key leak: the tenant must stop using the key. *Gap:* there is no key-rotation command yet; until one exists, create a new tenant and migrate, or add the command (see section 8).
   - Suspected reviewer account takeover: reset the password and 2FA with `pnpm reviewer` (see [review](review.md)); check which sessions that reviewer opened (`review.document_viewed` audit events).
   - Suspected data leak through a webhook: change the tenant's webhook URL and secret with `pnpm tenant:update`.
4. **Stop the bleeding in the app** if needed: stop the service, or remove its network exposure, rather than deleting data.
5. **Preserve evidence:** export CloudTrail events for the period (S3 data events, KMS `Decrypt`, IAM), the app logs, and a snapshot of the affected host or database. Do this before restarting or rebuilding anything.

## 5. First day: assess

Answer these in the incident log; they drive who must be told.

- **What happened, and since when?** First malicious event and last. CloudTrail shows `Decrypt` calls on the KMS key with the tenant and session in the encryption context, so you can list exactly which sessions' documents were read.
- **Which data and how many people?** Documents (ID front/back, selfie, licence) or only metadata? Which tenants? Is it ciphertext only, or was it decrypted?
- **Still exposed?** Is the access closed? Is the data still being served?
- **Risk to people:** identity documents and face images are high risk (identity fraud, impersonation). Treat any readable copy of documents as high risk. Ciphertext without the key is normally low risk, but only say so after confirming the key was not also reached.

Decision: **notifiable?** If it is likely to result in a risk to people, tenants are told and the authority is notified (by the controller, with your help). If you are not sure, decide with the lawyer; the default when in doubt is to notify.

## 6. Notify

- **Tenants (the controllers), without undue delay.** Tell them what you know, even if incomplete, and when you will update. Use `[template]`: what happened, when you found out, which of their data and how many sessions (ids, not people's details), what you have done, what they should do, and your contact. Give the list of affected session ids; they hold the mapping to their users.
- **The authority (IPA)** by the controller within 72 hours; offer the technical facts. Where you are the controller for some data, you notify yourself. `[Lawyer: confirm roles per tenant contract.]`
- **The people affected**, if the risk is high: the tenant normally does this. Offer plain wording: what was exposed, what they should watch for (fraud attempts, replaced documents), and who to contact.
- **AWS and other sub-processors** if their service was part of it (AWS abuse and support, for stolen keys).
- Do not publish details or speculate publicly before the tenants and authority have been told.

## 7. Recover and learn

- Fix the cause, rotate every secret that could have been exposed (AWS keys, `STORAGE_ENCRYPTION_KEY` if used, webhook secrets, API keys, reviewer passwords), and re-enable access in stages.
- Re-encrypt if a key was exposed: `pnpm storage:reencrypt` ([encryption](encryption.md)).
- Write a short post-incident report within a week: timeline, cause, impact, what worked, what changes. Add each change to the backlog and ship it.
- **Drill once before launch** (about an hour): pretend the `AWS_ACCESS_KEY_ID` leaked on a public repo. Walk through section 4, deactivate a spare test key, find the CloudTrail events, and draft the tenant notice. Fix what was unclear.

## 8. Gaps this plan exposes (to build)

- A **tenant API key rotation** command (and revoking the old key) does not exist yet.
- A **security event log** (logins, key use, reviewer actions beyond document views) is not recorded centrally; today only the per-session audit log and AWS CloudTrail exist.
- **Alarms** are not set up: CloudWatch on KMS `Decrypt` rate and `AccessDenied` ([encryption](encryption.md), Operations), S3 access anomalies, repeated failed reviewer logins.
- No documented **backup and restore** of the database; backups also hold personal data and have their own retention.
- Verify that **bucket versioning is off** and logging (CloudTrail data events for the bucket) is on, or you cannot say what was read.

## 9. Quick card (print this)

1. Write down the time you found out. 2. Do not delete anything. 3. Deactivate the abused key (IAM) or disable the KMS key. 4. Save CloudTrail and logs. 5. Call the incident lead and the lawyer. 6. Tell affected tenants without delay; the authority gets 72 hours from when you knew. 7. Keep the log.
