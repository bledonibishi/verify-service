import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentKind, Prisma, SessionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { OCR_PROVIDER, OcrProvider, OcrUnavailableError } from '../ocr/ocr-provider';
import { CheckOutcome, checkIdBack, decide, emptyOutcome } from './decision';
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
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly webhooks: WebhooksService,
    private readonly config: ConfigService,
    @Inject(OCR_PROVIDER) private readonly ocr: OcrProvider,
  ) {}

  onApplicationBootstrap() {
    if (this.config.get('VERIFICATION_WORKER_ENABLED') === 'false') return;
    const interval = this.int('VERIFICATION_POLL_MS', 2000);
    this.timer = setInterval(() => void this.wake(), interval);
    void this.wake();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  private int(key: string, fallback: number): number {
    const n = parseInt(this.config.get<string>(key) ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  /** Starts draining the queue unless a drain is already running (then it loops once more). */
  wake(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          while (!this.stopped && (await this.tick())) {
            /* keep going until the queue is empty */
          }
        } while (this.rerun && !this.stopped);
      } catch (err) {
        this.logger.error(`Worker loop failed: ${(err as Error).name}`);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Claims and processes one job. Returns false when there was nothing to do. */
  async tick(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;
    try {
      if (job.attempts > MAX_ATTEMPTS) {
        // The worker died repeatedly while holding this job: stop retrying.
        await this.finish(job, emptyOutcome('PIPELINE_ERROR'), 'none');
      } else {
        const outcome = await this.run(job);
        if (outcome) await this.finish(job, outcome.outcome, outcome.provider);
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

  /** Reads the ID back and checks it. Returns null when the session is no longer ours to decide. */
  private async run(job: ClaimedJob): Promise<{ outcome: CheckOutcome; provider: string } | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: job.session_id },
      include: { documents: true },
    });
    if (!session || session.status !== SessionStatus.PROCESSING) {
      await this.prisma.verificationJob.update({ where: { id: job.id }, data: { status: 'DONE', lockedUntil: null } });
      return null;
    }
    const back = session.documents.find((d) => d.kind === DocumentKind.ID_BACK);
    if (!back) return { outcome: emptyOutcome('ID_BACK_MISSING'), provider: 'none' };

    const image = await this.storage.get(back.storageKey);
    let text: string;
    try {
      text = (await this.ocr.readText(image)).text;
    } catch (err) {
      // Without an OCR engine retrying is pointless; hand the session to a person right away.
      if (err instanceof OcrUnavailableError) return { outcome: emptyOutcome('OCR_UNAVAILABLE'), provider: this.ocr.name };
      throw err;
    }
    const outcome = checkIdBack(text, {
      firstName: session.expectedFirstName ?? undefined,
      lastName: session.expectedLastName ?? undefined,
      birthDate: session.expectedBirthDate ?? undefined,
    });
    return { outcome, provider: this.ocr.name };
  }

  /** Records the result and moves the session, only if it is still PROCESSING. */
  private async finish(job: ClaimedJob, outcome: CheckOutcome, provider: string) {
    const committed = await this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({ where: { id: job.session_id }, include: { tenant: true } });
      if (!session) return null;
      const decision = decide(outcome, session.tenant.autoApprove);
      // The status condition is the single decider: if another worker or a reviewer already
      // moved the session, this update matches nothing and no result is written.
      const moved = await tx.session.updateMany({
        where: { id: session.id, status: SessionStatus.PROCESSING },
        data: { status: decision },
      });
      await tx.verificationJob.update({ where: { id: job.id }, data: { status: 'DONE', lockedUntil: null } });
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
          ocrProvider: provider,
        },
      });
      await tx.auditLog.create({
        data: {
          sessionId: session.id,
          event: 'verification.completed',
          detail: { decision, issues: outcome.issueCodes },
        },
      });
      return { session, result };
    });
    if (!committed) return;
    const { session, result } = committed;
    void this.webhooks.send(session.tenant, {
      type: 'session.status_changed',
      sessionId: session.id,
      externalRef: session.externalRef,
      status: result.decision,
      occurredAt: new Date().toISOString(),
      verification: toSummary(result),
    });
  }

  /** Transient failure: retry with backoff, then give up and send the session to a person. */
  private async fail(job: ClaimedJob, err: unknown) {
    // Only the error class is logged: messages from OCR or storage could carry document text.
    this.logger.warn(`Verification job ${job.id} attempt ${job.attempts} failed: ${(err as Error).name}`);
    try {
      if (job.attempts >= MAX_ATTEMPTS) {
        await this.finish(job, emptyOutcome('PIPELINE_ERROR'), this.ocr.name);
        return;
      }
      const base = this.int('VERIFICATION_RETRY_BASE_MS', 5000);
      await this.prisma.verificationJob.update({
        where: { id: job.id },
        data: { status: 'QUEUED', lockedUntil: null, runAfter: new Date(Date.now() + base * job.attempts ** 2) },
      });
    } catch (inner) {
      // The lease will lapse and the job will be claimed again.
      this.logger.error(`Could not record failure for job ${job.id}: ${(inner as Error).name}`);
    }
  }
}
