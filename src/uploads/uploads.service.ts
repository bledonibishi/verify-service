import { BadRequestException, ConflictException, GoneException, HttpException, Inject, Injectable, NotImplementedException, NotFoundException } from '@nestjs/common';
import { DocumentKind, SessionStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { sha256 } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { LIVENESS_PROVIDER, LivenessProvider, LivenessUnavailableError } from '../liveness/liveness-provider';
import { VerificationWorker } from '../verification/verification.worker';
import { detectImageType } from './image-type';

/** A 410 with a machine-readable reason, so a client can tell "already submitted" from "expired". */
/** Face checks one link may start: enough for a few honest retries, not for an endless loop. */
export const MAX_LIVENESS_STARTS = 5;

const gone = (message: string, code: 'session_submitted' | 'session_expired' | 'session_closed') =>
  new GoneException({ statusCode: 410, error: 'Gone', message, code });

@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly worker: VerificationWorker,
    @Inject(LIVENESS_PROVIDER) private readonly liveness: LivenessProvider,
  ) {}

  /** Resolves a still-open session from its upload token. */
  private async openSession(token: string) {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { tenant: true, documents: true },
    });
    if (!session) throw new NotFoundException('Unknown session');
    if (session.status === SessionStatus.EXPIRED) throw gone('Session expired', 'session_expired');
    if (session.status !== SessionStatus.PENDING) throw gone('Session already submitted', 'session_submitted');
    if (session.expiresAt.getTime() < Date.now()) {
      // Conditional so a submit that won a race is never overwritten with EXPIRED.
      await this.prisma.session.updateMany({
        where: { id: session.id, status: SessionStatus.PENDING },
        data: { status: SessionStatus.EXPIRED },
      });
      throw gone('Session expired', 'session_expired');
    }
    return session;
  }

  /**
   * What the end user's page needs to know, from the token alone. Deliberately holds nothing about
   * the person (no names, no reference): only which pictures to ask for and what is already here.
   */
  async describe(token: string) {
    const session = await this.openSession(token);
    const steps: { kind: DocumentKind; required: boolean }[] = [
      { kind: DocumentKind.ID_FRONT, required: true },
      // Without the back, the machine-readable zone cannot be checked and a person must review
      { kind: DocumentKind.ID_BACK, required: session.requireLicence },
      ...(session.requireLicence
        ? [
            { kind: DocumentKind.LICENCE_FRONT, required: true },
            { kind: DocumentKind.LICENCE_BACK, required: false },
          ]
        : []),
      { kind: DocumentKind.SELFIE, required: true },
    ];
    return {
      status: session.status,
      expiresAt: session.expiresAt,
      requireDrivingLicence: session.requireLicence,
      steps,
      uploaded: session.documents.map((d) => d.kind),
      liveness: this.liveness.name !== 'none',
    };
  }

  /**
   * Starts a liveness challenge for the session. The client widget runs it against the provider;
   * the pipeline reads the verdict after submit. Calling again replaces the earlier challenge.
   */
  async startLiveness(token: string) {
    const session = await this.openSession(token);
    // A link may start only a few challenges: each one creates a session at the provider, and a
    // repeated or scripted start would otherwise create them without end. Reserved before the call.
    const reserved = await this.prisma.session.updateMany({
      where: { id: session.id, status: SessionStatus.PENDING, expiresAt: { gt: new Date() }, livenessStarts: { lt: MAX_LIVENESS_STARTS } },
      data: { livenessStarts: { increment: 1 } },
    });
    if (reserved.count === 0) {
      const now = await this.prisma.session.findUnique({ where: { id: session.id } });
      if (!now || now.status !== SessionStatus.PENDING || now.expiresAt.getTime() <= Date.now()) throw gone('Session is closed', 'session_closed');
      throw new HttpException({ statusCode: 429, message: 'Too many face checks were started for this link', code: 'liveness_attempts_exceeded' }, 429);
    }
    let created;
    try {
      created = await this.liveness.createSession();
    } catch (err) {
      if (err instanceof LivenessUnavailableError) throw new NotImplementedException('Liveness is not available');
      throw err;
    }
    // Optimistic: only replace the challenge this request saw. Two concurrent starts cannot both
    // succeed, so a client is never handed an id that another request has already replaced.
    const stored = await this.prisma.session.updateMany({
      where: {
        id: session.id,
        status: SessionStatus.PENDING,
        expiresAt: { gt: new Date() },
        livenessSessionId: session.livenessSessionId,
      },
      data: { livenessSessionId: created.providerSessionId },
    });
    if (stored.count === 0) {
      const now = await this.prisma.session.findUnique({ where: { id: session.id } });
      if (!now || now.status !== SessionStatus.PENDING || now.expiresAt.getTime() <= Date.now()) {
        throw gone('Session is closed', 'session_closed');
      }
      throw new ConflictException('A liveness challenge was started elsewhere; retry');
    }
    await this.prisma.auditLog.create({ data: { sessionId: session.id, event: 'liveness.started' } });
    return { provider: this.liveness.name, sessionId: created.providerSessionId, ...(created.clientConfig ?? {}) };
  }

  async addDocument(token: string, kind: DocumentKind, data: Buffer) {
    const session = await this.openSession(token);
    // Data minimisation: a second government document is only taken when the session asked for it
    if ((kind === DocumentKind.LICENCE_FRONT || kind === DocumentKind.LICENCE_BACK) && !session.requireLicence) {
      throw new BadRequestException('This session does not take a driving licence');
    }
    const contentType = detectImageType(data);
    if (!contentType) throw new BadRequestException('File must be a JPEG, PNG or WebP image');

    const digest = sha256(data);
    const storageKey = `${session.tenantId}/${session.id}/${randomUUID()}`;
    await this.storage.put(storageKey, data);

    let displacedKey: string | undefined;
    try {
      await this.prisma.$transaction(async (tx) => {
        // Re-check the session inside the transaction. The row lock this update takes makes a
        // concurrent submit wait, so a document can never change after the session closes.
        const open = await tx.session.updateMany({
          where: { id: session.id, status: SessionStatus.PENDING, expiresAt: { gt: new Date() } },
          data: { updatedAt: new Date() },
        });
        if (open.count === 0) throw gone('Session is closed', 'session_closed');

        const existing = await tx.document.findUnique({
          where: { sessionId_kind: { sessionId: session.id, kind } },
        });
        displacedKey = existing?.storageKey;
        await tx.document.upsert({
          where: { sessionId_kind: { sessionId: session.id, kind } },
          create: { sessionId: session.id, kind, storageKey, contentType, sizeBytes: data.length, sha256: digest },
          update: { storageKey, contentType, sizeBytes: data.length, sha256: digest },
        });
        await tx.auditLog.create({
          data: { sessionId: session.id, event: 'document.uploaded', detail: { kind } },
        });
      });
    } catch (err) {
      // Don't leave an encrypted ID image on disk with no database row pointing at it.
      await this.storage.delete(storageKey).catch(() => undefined);
      throw err;
    }
    if (displacedKey) await this.storage.delete(displacedKey).catch(() => undefined);
  }

  /**
   * Marks the session as submitted and queues the automated checks. The HTTP request returns
   * straight away; the worker decides the outcome and sends the webhook.
   */
  async submit(token: string) {
    const session = await this.openSession(token);
    const kinds = new Set(session.documents.map((d) => d.kind));
    if (!kinds.has(DocumentKind.ID_FRONT) || !kinds.has(DocumentKind.SELFIE)) {
      throw new BadRequestException('ID_FRONT and SELFIE are required before submitting');
    }
    if (session.requireLicence && (!kinds.has(DocumentKind.ID_BACK) || !kinds.has(DocumentKind.LICENCE_FRONT))) {
      throw new BadRequestException('ID_BACK and LICENCE_FRONT are required for a session that asks for a driving licence');
    }

    // Atomic claim: only one concurrent submit can move the session out of PENDING. The job is
    // created in the same transaction so a PROCESSING session can never lack its job.
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.session.updateMany({
        where: { id: session.id, status: SessionStatus.PENDING, expiresAt: { gt: new Date() } },
        data: { status: SessionStatus.PROCESSING },
      });
      if (claimed.count === 0) throw gone('Session already submitted or expired', 'session_closed');
      await tx.verificationJob.create({ data: { sessionId: session.id } });
      await tx.auditLog.create({ data: { sessionId: session.id, event: 'session.submitted' } });
    });

    void this.worker.wake();
    return { status: SessionStatus.PROCESSING };
  }
}
