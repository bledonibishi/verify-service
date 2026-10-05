import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentKind, Prisma, SessionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { OutboxService } from '../webhooks/outbox.service';
import { WebhookDispatcher } from '../webhooks/dispatcher';
import { OCR_PROVIDER, OcrError, OcrProvider, OcrUnavailableError } from '../ocr/ocr-provider';
import { FACE_PROVIDER, FaceProvider, FaceUnavailableError } from '../face/face-provider';
import { LIVENESS_PROVIDER, LivenessProvider, LivenessUnavailableError } from '../liveness/liveness-provider';
import { checkLicence, LicenceOutcome } from '../documents/licence';
import type { Td1Data } from '../documents/mrz';
import { CheckOutcome, LivenessOutcome, bindFaceToLiveness, livenessOutcome, withLiveness, FaceOutcome, readIdBack, mrzReadable, decide, emptyOutcome, faceOutcome, withFace, withLicence } from './decision';
import { toSummary } from './summary';

const MAX_ATTEMPTS = 3;
const LEASE_MS = 2 * 60_000;

interface ClaimedJob {
  id: string;
  session_id: string;
  attempts: number;
}

/**
 * Runs the verification pipeline off the request path. Jobs live in Postgres; a worker claims one
 * with FOR UPDATE SKIP LOCKED, so any number of instances can run side by side. A job whose
 * worker died keeps its lease until it lapses and is then claimed again.
 */
@Injectable()
export class VerificationWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(VerificationWorker.name);
  private timer?: NodeJS.Timeout;
  private readonly loops = new Set<Promise<void>>();
  private stopped = false;
  private readonly enabled: boolean;
  private readonly concurrency: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly outbox: OutboxService,
    private readonly dispatcher: WebhookDispatcher,
    private readonly config: ConfigService,
    @Inject(OCR_PROVIDER) private readonly ocr: OcrProvider,
    @Inject(FACE_PROVIDER) private readonly face: FaceProvider,
    @Inject(LIVENESS_PROVIDER) private readonly liveness: LivenessProvider,
  ) {
    this.enabled = config.get('VERIFICATION_WORKER_ENABLED') !== 'false';
    this.concurrency = Math.max(1, this.int('VERIFICATION_CONCURRENCY', 2));
  }

  onApplicationBootstrap() {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.wake(), this.int('VERIFICATION_POLL_MS', 2000));
    void this.wake();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all(this.loops);
  }

  private int(key: string, fallback: number): number {
    const n = parseInt(this.config.get<string>(key) ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  /**
   * Tops up the drain loops to the concurrency limit, so one slow OCR call never blocks the rest
   * of the queue. A worker disabled by configuration never claims jobs, however it is woken.
   */
  wake(): Promise<void> {
    if (!this.enabled || this.stopped) return Promise.resolve();
    while (this.loops.size < this.concurrency) {
      const loop: Promise<void> = this.drain().finally(() => this.loops.delete(loop));
      this.loops.add(loop);
    }
    return Promise.all(this.loops).then(() => undefined);
  }

  private async drain() {
    try {
      while (!this.stopped && (await this.tick())) {
        /* keep going until the queue is empty */
      }
    } catch (err) {
      this.logger.error(`Worker loop failed: ${(err as Error).name}`);
    }
  }

  /** Matches the job only while this attempt still holds it; each claim bumps `attempts`. */
  private fence(job: ClaimedJob) {
    return { id: job.id, status: 'RUNNING' as const, attempts: job.attempts };
  }

  /** Claims and processes one job. Returns false when there was nothing to do. */
  async tick(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;
    try {
      if (job.attempts > MAX_ATTEMPTS) {
        // The worker died repeatedly while holding this job: stop retrying.
        await this.finish(job, emptyOutcome('PIPELINE_ERROR'), { ocr: 'none', face: null, liveness: null });
      } else {
        const outcome = await this.run(job);
        if (outcome) await this.finish(job, outcome.outcome, outcome.providers);
      }
    } catch (err) {
      await this.fail(job, err);
    }
    return true;
  }

  private async claim(): Promise<ClaimedJob | null> {
    const rows = await this.prisma.$queryRaw<ClaimedJob[]>(Prisma.sql`
      UPDATE verification_jobs
      SET status = 'RUNNING', attempts = attempts + 1,
          locked_until = now() + ${LEASE_MS} * interval '1 millisecond', updated_at = now()
      WHERE id = (
        SELECT id FROM verification_jobs
        WHERE (status = 'QUEUED' AND run_after <= now())
           OR (status = 'RUNNING' AND locked_until < now())
        ORDER BY run_after
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, session_id, attempts`);
    return rows[0] ?? null;
  }

  /** Runs the document and face checks. Returns null when the session is no longer ours to decide. */
  private async run(job: ClaimedJob): Promise<{ outcome: CheckOutcome; providers: { ocr: string; face: string | null; liveness: string | null } } | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: job.session_id },
      include: { documents: true, tenant: true },
    });
    if (!session || session.status !== SessionStatus.PROCESSING) {
      await this.prisma.verificationJob.updateMany({ where: this.fence(job), data: { status: 'DONE', lockedUntil: null } });
      return null;
    }
    const doc = (kind: DocumentKind) => session.documents.find((d) => d.kind === kind);

    const back = doc(DocumentKind.ID_BACK);
    let mrz: CheckOutcome;
    let idData: Td1Data | null = null; // the ID's values, in memory only, for the licence cross-check
    let ocrName = this.ocr.name;
    if (!back) {
      mrz = emptyOutcome('ID_BACK_MISSING');
      ocrName = 'none';
    } else {
      const image = await this.storage.get(back.storageKey);
      try {
        const { text } = await this.ocr.readText(image, { accept: (t) => mrzReadable(t) });
        const read = readIdBack(text, {
          firstName: session.expectedFirstName ?? undefined,
          lastName: session.expectedLastName ?? undefined,
          birthDate: session.expectedBirthDate ?? undefined,
        });
        mrz = read.outcome;
        idData = read.data;
      } catch (err) {
        // Without an OCR engine retrying is pointless; record it and let a person decide.
        if (!(err instanceof OcrUnavailableError)) throw err;
        mrz = emptyOutcome('OCR_UNAVAILABLE');
      }
    }

    if (session.requireLicence) {
      const licence = await this.checkLicenceDocument(doc(DocumentKind.LICENCE_FRONT), idData);
      mrz = withLicence(mrz, licence.outcome, licence.missingCode);
    }

    const live = await this.checkLiveness(job, session.livenessSessionId, session.tenant.livenessMinConfidence);
    const { face, missing, source, outage: faceOutage } = await this.checkFace(job, session.documents, session.tenant.faceMatchThreshold, live.referenceImage);
    const outcome = bindFaceToLiveness({
      ...withFace(withLiveness(mrz, live.outcome, live.performed), face, missing),
      faceSource: face ? source : null,
      outages: [...(faceOutage ? ['face_unavailable'] : []), ...(live.outage ? ['liveness_unavailable'] : [])],
    });
    return {
      outcome,
      providers: { ocr: ocrName, face: face ? this.face.name : null, liveness: live.outcome ? this.liveness.name : null },
    };
  }

  /** Reads the driving licence front and cross-checks it against the ID. Values stay in this function. */
  private async checkLicenceDocument(
    front: { storageKey: string } | undefined,
    idData: Td1Data | null,
  ): Promise<{ outcome: LicenceOutcome | null; missingCode?: string }> {
    if (!front) return { outcome: null, missingCode: 'LICENCE_FRONT_MISSING' };
    const image = await this.storage.get(front.storageKey);
    try {
      const { text } = await this.ocr.readText(image, { mode: 'text' });
      return { outcome: checkLicence(text, idData) };
    } catch (err) {
      if (!(err instanceof OcrUnavailableError)) throw err;
      return { outcome: null, missingCode: 'OCR_UNAVAILABLE' };
    }
  }

  /** Reads the liveness verdict. The reference image, if any, stays in memory for the face match. */
  private async checkLiveness(
    job: ClaimedJob,
    providerSessionId: string | null,
    minConfidence: number,
  ): Promise<{ outcome: LivenessOutcome | null; performed: boolean; referenceImage?: Buffer; outage?: boolean }> {
    if (!providerSessionId) return { outcome: null, performed: false };
    try {
      const r = await this.liveness.getResult(providerSessionId);
      return { outcome: livenessOutcome(r, minConfidence), performed: true, referenceImage: r.referenceImage };
    } catch (err) {
      if (!(err instanceof LivenessUnavailableError)) throw err;
      const configured = this.liveness.name !== 'none';
      if (configured) this.logger.warn(`Liveness unavailable for job ${job.id}: ${err.message}`);
      return { outcome: null, performed: true, outage: configured };
    }
  }

  /** ID portrait vs selfie. `face` is null when no comparison happened; `missing` says why if documents were absent. */
  private async checkFace(
    job: ClaimedJob,
    documents: { kind: DocumentKind; storageKey: string }[],
    threshold: number,
    referenceImage?: Buffer,
  ): Promise<{ face: FaceOutcome | null; missing: string[]; source: 'liveness' | 'selfie'; outage?: boolean }> {
    const front = documents.find((d) => d.kind === DocumentKind.ID_FRONT);
    const selfie = documents.find((d) => d.kind === DocumentKind.SELFIE);
    const source = referenceImage ? 'liveness' : 'selfie';
    if (!front || !selfie) {
      return { face: null, missing: [...(front ? [] : ['ID_FRONT_MISSING']), ...(selfie ? [] : ['SELFIE_MISSING'])], source };
    }
    try {
      // The image captured during the liveness challenge wins over the uploaded selfie, so the
      // match is against the person who actually passed liveness.
      const [idImage, selfieImage] = await Promise.all([
        this.storage.get(front.storageKey),
        referenceImage ?? this.storage.get(selfie.storageKey),
      ]);
      return { face: faceOutcome(await this.face.compare(idImage, selfieImage), threshold), missing: [], source };
    } catch (err) {
      if (!(err instanceof FaceUnavailableError)) throw err;
      // Every session now goes to review; make a broken deployment visible (but not a deliberate "none").
      const configured = this.face.name !== 'none';
      if (configured) this.logger.warn(`Face matching unavailable for job ${job.id}: ${err.message}`);
      return { face: null, missing: [], source, outage: configured };
    }
  }

  /** Records the result and moves the session, only if it is still PROCESSING. */
  private async finish(job: ClaimedJob, rawOutcome: CheckOutcome, providers: { ocr: string; face: string | null; liveness: string | null }) {
    const committed = await this.prisma.$transaction(async (tx) => {
      let outcome = rawOutcome;
      // Ownership fence: if our lease lapsed and another worker re-claimed the job, we are stale
      // and must not record anything.
      const owned = await tx.verificationJob.updateMany({ where: this.fence(job), data: { status: 'DONE', lockedUntil: null } });
      if (owned.count === 0) return null;
      const session = await tx.session.findUnique({ where: { id: job.session_id }, include: { tenant: true } });
      if (!session) return null;
      // Whatever ended the pipeline early (an error, a give-up), a session that required a licence
      // still records that it was required and not checked, instead of dropping the requirement.
      if (session.requireLicence && !outcome.licenceRequired) {
        outcome = withLicence(outcome, null, 'LICENCE_NOT_CHECKED');
      }
      const decision = decide(outcome, session.tenant.autoApprove);
      // The status condition is the single decider: if another worker or a reviewer already
      // moved the session, this update matches nothing and no result is written.
      const moved = await tx.session.updateMany({
        where: { id: session.id, status: SessionStatus.PROCESSING },
        data: { status: decision, ...(decision === 'APPROVED' ? { decidedAt: new Date() } : {}) },
      });
      if (moved.count === 0) return null;
      const result = await tx.verificationResult.create({
        data: {
          sessionId: session.id,
          decision,
          autoDecided: decision === 'APPROVED',
          mrzFound: outcome.mrzFound,
          mrzValid: outcome.mrzValid,
          ocrRepaired: outcome.ocrRepaired,
          surnameMatch: outcome.identity?.surname ?? null,
          givenNamesMatch: outcome.identity?.givenNames ?? null,
          birthDateMatch: outcome.identity?.birthDate ?? null,
          expired: outcome.expired,
          checks: outcome.checks,
          issueCodes: outcome.issueCodes,
          ocrProvider: providers.ocr,
          faceStatus: outcome.face?.status ?? null,
          faceSimilarity: outcome.face?.similarity ?? null,
          faceProvider: providers.face,
          faceSource: outcome.faceSource,
          livenessStatus: outcome.liveness?.status ?? null,
          livenessConfidence: outcome.liveness?.confidence ?? null,
          livenessProvider: providers.liveness,
          ...(outcome.licenceRequired
            ? {
                licenceFound: outcome.licence?.found ?? false,
                licenceFields: outcome.licence?.fields ?? [],
                licenceExpired: outcome.licence?.expired ?? null,
                licenceDatesValid: outcome.licence?.datesValid ?? null,
                licenceRepaired: outcome.licence?.repaired ?? null,
                licencePersonalNumberMatch: outcome.licence?.personalNumber ?? null,
                licenceSurnameMatch: outcome.licence?.surname ?? null,
                licenceGivenNamesMatch: outcome.licence?.givenNames ?? null,
                licenceBirthDateMatch: outcome.licence?.birthDate ?? null,
              }
            : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          sessionId: session.id,
          event: 'verification.completed',
          detail: { decision, issues: outcome.issueCodes },
        },
      });
      // Metering, in the same transaction as the decision: a completed verification is counted once
      // (unique per session), and one that failed because of us is recorded but not billed.
      const ourFailure = outcome.issueCodes.includes('PIPELINE_ERROR') ? 'pipeline_error' : outcome.issueCodes.includes('OCR_UNAVAILABLE') ? 'ocr_unavailable' : outcome.outages?.[0] ?? null;
      await tx.usageEvent.createMany({
        data: [
          {
            tenantId: session.tenantId,
            sessionId: session.id,
            kind: 'verification',
            occurredAt: new Date(),
            billable: ourFailure === null,
            nonBillableReason: ourFailure,
            face: providers.face !== null,
            liveness: providers.liveness !== null,
            licence: outcome.licenceRequired && outcome.licence !== null,
            autoDecided: decision === 'APPROVED',
          },
        ],
        skipDuplicates: true,
      });
      // Queued in this transaction: the webhook exists if and only if the decision committed
      const queued = await this.outbox.enqueue(tx, session.tenant, {
        sessionId: session.id,
        externalRef: session.externalRef,
        status: result.decision,
        verification: toSummary(result),
      });
      return { queued };
    });
    if (committed?.queued) void this.dispatcher.wake();
  }

  /** Transient failure: retry with backoff, then give up and send the session to a person. */
  private async fail(job: ClaimedJob, err: unknown) {
    // Only the error class is logged: messages from OCR or storage could carry document text.
    this.logger.warn(`Verification job ${job.id} attempt ${job.attempts} failed: ${(err as Error).name}${err instanceof OcrError ? ` (${err.reason})` : ''}`);
    try {
      if (job.attempts >= MAX_ATTEMPTS) {
        await this.finish(job, emptyOutcome('PIPELINE_ERROR'), { ocr: this.ocr.name, face: null, liveness: null });
        return;
      }
      const base = this.int('VERIFICATION_RETRY_BASE_MS', 5000);
      await this.prisma.verificationJob.updateMany({
        where: this.fence(job),
        data: { status: 'QUEUED', lockedUntil: null, runAfter: new Date(Date.now() + base * job.attempts ** 2) },
      });
    } catch (inner) {
      // The lease will lapse and the job will be claimed again.
      this.logger.error(`Could not record failure for job ${job.id}: ${(inner as Error).name}`);
    }
  }
}
