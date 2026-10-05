# Data protection impact assessment (outline)

Status: **outline pre-filled from what the service actually does; the owner and a lawyer complete the judgement parts** (marked `[owner]`). A DPIA is required before processing that is likely to result in a high risk to people, and identity documents plus face matching are that. Nothing here is legal advice. Kosovo reference: Law No. 06/L-082 on Protection of Personal Data; `[lawyer: confirm the DPIA provision and whether the Information and Privacy Agency (IPA) must be consulted or notified before biometric processing starts (Art. 83 in the research notes)]`.

## 1. Description of the processing

**Purpose.** Verify, for a tenant company, that a person who applies to it holds a genuine, unexpired Kosovo identity card and is the person in the photo, so the tenant can onboard them (e.g. a bank, a telehealth service).

**Roles.** The tenant decides why and how its customers are verified: **controller**. This service verifies on the tenant's behalf: **processor**. `[owner + lawyer: confirm per customer; if you decide purposes yourself for any data (e.g. product improvement), you are a controller for that part and need your own legal basis.]` A **data processing agreement** with each tenant is required.

**Data subjects.** Individuals the tenant asks to verify (adults). `[owner: confirm no minors.]`

**Data processed, by category:**

| Data | Where | Kept |
| --- | --- | --- |
| Photos: ID front, ID back, optional licence, selfie | Encrypted object storage (S3, KMS keys, `eu-central-1`) | `documentRetentionDays` after decision (default 30) |
| Parsed ID values (name, birth date, document and personal numbers) | In memory only during the check; **not stored** | Not kept |
| What the tenant told us (expected name, date of birth, own reference) | Database | `recordRetentionDays` (default 5 years) |
| Result: pass/fail per check, issue codes, face similarity score, decision | Database | `recordRetentionDays` |
| Face templates | Created by AWS Rekognition for a comparison; **Rekognition does not store the images** | Not kept by us |
| Reviewer accounts (email, password hash, 2FA secret sealed) | Database | While the account exists |
| Audit events (document views, decisions) | Database | With the session |
| Usage events (ids, timestamps, flags, no personal data) | Database | Accounting period `[accountant]` |

**Special category.** Face comparison for identification is **biometric data**; ID documents also carry the national personal number. Treat both as high-risk.

**Recipients and transfers.** AWS (S3, KMS, Rekognition) in `eu-central-1` (Germany); AWS Face Liveness, if enabled, in `eu-west-1` (Ireland) because it is not offered in Frankfurt. Both are inside the EU/EEA. `[lawyer: Kosovo rules on transfers to EU/EEA processors and the DPA with AWS]`. Tenants receive results by webhook. No data is sent to advertisers or analytics.

**Flow:** capture page or app → upload (TLS) → encrypted at once → job queue → OCR on our server (Tesseract, nothing leaves) → optional Rekognition comparison → decision → webhook to tenant → manual review if needed (tenant's staff) → deletion after retention.

## 2. Necessity and proportionality

- **Legal basis** (controller's, per tenant): `[tenant: legal obligation (AML/KYC for banks), contract, or consent; consent is hard to make valid where refusing means no service.]`
- **Is it needed?** Identity verification at onboarding is the purpose; the less intrusive option is a manual check by a person. `[owner: why remote automatic verification is justified for these tenants.]`
- **Data minimisation, as built:** MRZ values are used in memory and not stored; licence documents are only accepted when the tenant asked for them; images are deleted after the retention window (`0` days possible); nothing is used for training; the usage log holds no personal data; the results and webhooks carry pass/fail and issue codes, not the MRZ values (a reviewer does see the document images themselves, and the name and birth date the tenant supplied).
- **Accuracy:** check digits and layout rules for the MRZ; face similarity against a tenant threshold (default 90); anything uncertain or repaired goes to a **person** (nothing is rejected automatically; the only automatic outcome is approval, and only when every check passes).
- **Automated decisions:** there is no automatic rejection; a person decides every negative or uncertain case. `[lawyer: whether automatic approval alone engages the automated-decision provisions.]`
- **Transparency:** the capture page must tell the person who verifies them, why, what is stored and for how long, who receives it, their rights, and how to reach the controller. The page is configurable per tenant `[owner: check the text in en/sq/sr with native speakers and add the tenant's privacy notice link]`.
- **Rights:** access, correction, erasure, objection. Erasure is built in (`DELETE /v1/sessions/:id`, files first then rows); access and correction go through the tenant. `[owner: define how a tenant forwards and how fast you answer.]`

## 3. Risks to people and measures

Score each: likelihood and severity (low/medium/high) `[owner]`. Starting points:

| Risk | Example | Measures in place | Residual / to do |
| --- | --- | --- | --- |
| Unauthorised access to documents | Stolen cloud key, compromised server | Encryption before storage; KMS with per-object context; no data-key cache; CloudTrail on every decrypt; tenant isolation tests on every endpoint; reviewer 2FA | Set CloudWatch alarms; pentest; breach plan ([breach-response](breach-response.md)) |
| Cross-tenant exposure | One customer reads another's sessions | Every query filtered by tenant; isolation tests | Pentest |
| Identity theft with leaked copies | Documents sold or reused | Short default retention (30 days); deletion API; documents are never in logs | Offer tenants `documentRetentionDays` as low as possible |
| Wrong refusal / false match | Honest person turned away, impostor passes | No automatic rejection; human review; threshold per tenant; liveness required for automatic approval (not available yet, so nothing auto-approves) | Measure real error rates before enabling auto-approval; a fallback path |
| Bias in face matching | Lower accuracy for some groups | Human review for every non-clear result | `[owner: test on the tenants' real population; ask AWS for its accuracy documentation]` |
| Over-retention | Records outlive the purpose | Per-tenant windows; automated job; erasure; backups noted | Define backup expiry |
| Insider misuse | A reviewer browses documents | Per-tenant reviewer accounts; every document view audit-logged; no export unless the tenant enabled it | Review the audit log periodically; assignment/locking later |
| Loss of availability or integrity | Key deleted, bucket lost | KMS deletion waiting period; documented restore needed | Backup and restore test |
| Presentation attack | Printed or screen photo as a selfie | Face match alone cannot detect it | **Liveness before auto-approval** |
| Function creep | Using the data for something else | Purpose limited to verification; no secondary use in code | Contractual ban in the DPA |

## 4. Consultation

- `[owner]` Ask each tenant's data-protection contact to review their part.
- `[owner]` Ask a small sample of real users (or your own testers) whether the notice is understandable.
- `[lawyer]` Decide whether the IPA must be consulted or notified before launch.

## 5. Sign-off and review

| | |
| --- | --- |
| Measures approved by | `[owner]` `[date]` |
| Residual risks accepted by | `[owner]` `[date]` |
| Legal review by | `[lawyer]` `[date]` |
| Next review | when liveness is added, when a new document type or tenant type is added, when a provider or region changes, and in any case yearly |

## 6. Before launch checklist

- [ ] DPA signed with each tenant; controller/processor roles written down.
- [ ] Sub-processor terms with AWS accepted; regions recorded here.
- [ ] Capture-page notice reviewed in en/sq/sr and linked to the tenant's privacy notice.
- [ ] Retention values chosen per tenant (documents as short as the tenant can accept).
- [ ] IPA notification/consultation question answered.
- [ ] Breach plan drilled ([breach-response](breach-response.md)); alarms on.
- [ ] Penetration test done by someone independent.
- [ ] Error-rate test on real documents; auto-approval stays off until liveness and measured accuracy are in place.
