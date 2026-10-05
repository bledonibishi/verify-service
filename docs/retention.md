# Retention, deletion and evidence

Personal data is kept only as long as the tenant needs it. Everything below is **per tenant**, because regulated customers (banks, for example) may have to keep customer records for at least five years after the relationship ends, while others should keep almost nothing. Nothing here is legal advice; confirm the windows with each customer's counsel.

## Settings (per tenant)

| Setting | Default | Meaning |
| --- | --- | --- |
| `documentRetentionDays` | 30 | The ID and selfie images are deleted this many days after the final decision. `0` deletes them right after the decision. |
| `recordRetentionDays` | 1825 (5 years) | The whole record (results, audit log, the expected name and date of birth) is deleted this many days after the decision. |
| `evidenceExport` | off | Lets the tenant export evidence, including decrypted documents, through the API. |

Documents cannot be kept longer than the record. Set them with the CLI:

```bash
pnpm tenant:create "Acme Bank" https://acme.example/hook --doc-retention-days=90 --record-retention-days=1825 --evidence-export
pnpm tenant:update <tenantId> --doc-retention-days=14
```

Windows are read when the job runs, so changing one applies to existing sessions too. Shortening a window deletes sooner and cannot be undone; the CLI prints a note when records are kept for less than five years.

## What the clock starts from

The clock starts at the **final decision** (`APPROVED` by the pipeline or by a reviewer, or `REJECTED` by a reviewer). A session waiting in `NEEDS_REVIEW` is never deleted, however old, because nobody has decided it. Sessions that were never submitted (`PENDING`, or `EXPIRED`) are erased entirely `ABANDONED_GRACE_HOURS` (default 24) after their link expired.

## The job

`RetentionService.run()` runs a few seconds after start and then every `RETENTION_INTERVAL_MS` (default one hour); `RETENTION_JOB_ENABLED=false` turns it off on an instance. It is safe to run on several instances at once: each session is locked with `FOR UPDATE SKIP LOCKED` and its due-ness is re-checked under the lock.

Order of operations, for every erasure: **delete the stored files first, then the database rows**, in one transaction. If something fails part-way, the transaction rolls back and the session is counted as failed and logged (session id and error class, no personal data). Some of its files may already be gone by then, so for a while rows can point at files that no longer exist; the next run finishes the job, and readers treat a missing file as `410 Gone`, not as a server error. The service never ends up with an encrypted file that nothing points to. A failing session is skipped for the rest of that run, so it can never starve newer ones, and is retried on the next run.

When documents are deleted but the record stays, the session keeps a manifest of what existed (`kind`, `contentType`, `sizeBytes`, `sha256`) and a `documentsDeletedAt` timestamp, and the audit log gets `retention.documents_deleted`. `GET /v1/sessions/:id` then shows `uploaded: []` and `documentsDeletedAt`.

## Deleting a person's data on request

`DELETE /v1/sessions/:id` (API key) erases the session now: documents, results, audit log and the job. It answers `204`, then `404`. A session another tenant owns is a `404`. While the pipeline is reading a session (`PROCESSING`) the answer is `409`; retry in a few seconds. An upload racing the deletion either fails (`404`/`410`) or is cleaned up by its own failure path; a test checks no file survives.

Each erasure leaves a **deletion record** with the tenant id, the session id, the reason (`retention`, `abandoned`, `tenant_request`), how many documents there were, and the time. It holds no personal data, not even the tenant's own `externalRef`, so it is safe to keep as proof of erasure.

## Evidence export (regulated tenants)

Off by default, because it is the one place the API hands decrypted documents to the tenant. With `evidenceExport` on:

- `GET /v1/sessions/:id/evidence` returns JSON: session, the expected identity, the automated results, the human review (including the reviewer's email and reason), the documents' kind, size and SHA-256, and the full audit log. The response carries `X-Evidence-Signature: t=<unix>,v1=<hmac>`, the same scheme as webhooks (`HMAC-SHA256(webhookSecret, "<t>.<raw body>")`), so the tenant can prove the bundle came from us unchanged.
- `GET /v1/sessions/:id/evidence/documents/:kind` returns one decrypted image (`X-Document-Sha256` lets the tenant check it against the bundle). After retention deleted the documents it answers `410`; the bundle still lists them from the manifest.
- Both are tenant-scoped and audit-logged (`evidence.exported`, `evidence.document_exported`).

## Rolling this out

The migration sets every **existing** tenant's document window equal to its record window (5 years by default), so deploying never deletes anything by itself. Only tenants created afterwards get the 30-day default. To shorten an existing tenant deliberately, run `pnpm tenant:update <id> --doc-retention-days=N`. If you want to inspect before anything can be deleted, start the first deployment with `RETENTION_JOB_ENABLED=false`.

## Known gaps

- **All instances must share one storage.** The local-disk driver is single-host: with several hosts each holding its own directory, a job on a host without the file would treat "not there" as erased. Use `STORAGE_DRIVER=s3` ([storage](storage.md)) before running more than one instance, and keep bucket **versioning off**, or deleted objects survive as old versions.

- The S3 driver keeps the same files-before-rows order; bucket versioning must stay off (see [storage](storage.md)).
- Backups are outside this service: a database or disk backup keeps data until the backup itself expires.
- Webhook events (the outbox) are erased with their session; delivered events are also deleted after `WEBHOOK_EVENT_RETENTION_DAYS` (7) and failed ones after `WEBHOOK_FAILED_RETENTION_DAYS` (30). A pending event for a tenant that is down can live as long as its retries last (about a day), then becomes `FAILED`. A decided session is **not** erased by retention while one of its events is still `PENDING`, even with a zero-day window, so a committed decision is never lost before the tenant is told; an explicit `DELETE /v1/sessions/:id` still erases immediately. Failed events are kept for `WEBHOOK_FAILED_RETENTION_DAYS` counted from when they last failed, so a replayed event gets a fresh window.
- Reviewer accounts and the tenant's own copies of data are the tenant's responsibility.
