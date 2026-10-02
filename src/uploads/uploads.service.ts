import { BadRequestException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { DocumentKind, SessionStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { sha256 } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { detectImageType } from './image-type';

@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly webhooks: WebhooksService,
  ) {}

  /** Resolves a still-open session from its upload token. */
  private async openSession(token: string) {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { tenant: true, documents: true },
    });
    if (!session) throw new NotFoundException('Unknown session');
    if (session.status !== SessionStatus.PENDING) throw new GoneException('Session already submitted');
    if (session.expiresAt.getTime() < Date.now()) {
      // Conditional so a submit that won a race is never overwritten with EXPIRED.
      await this.prisma.session.updateMany({
        where: { id: session.id, status: SessionStatus.PENDING },
        data: { status: SessionStatus.EXPIRED },
      });
      throw new GoneException('Session expired');
    }
    return session;
  }

  async addDocument(token: string, kind: DocumentKind, data: Buffer) {
    const session = await this.openSession(token);
    const contentType = detectImageType(data);
    if (!contentType) throw new BadRequestException('File must be a JPEG, PNG or WebP image');

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
        if (open.count === 0) throw new GoneException('Session is closed');

        const existing = await tx.document.findUnique({
          where: { sessionId_kind: { sessionId: session.id, kind } },
        });
        displacedKey = existing?.storageKey;
        await tx.document.upsert({
          where: { sessionId_kind: { sessionId: session.id, kind } },
          create: { sessionId: session.id, kind, storageKey, contentType, sizeBytes: data.length },
          update: { storageKey, contentType, sizeBytes: data.length },
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
   * Marks the session as submitted. Automated checks arrive in a later step; until then every
   * submission goes to the manual review queue.
   */
  async submit(token: string) {
    const session = await this.openSession(token);
    const kinds = new Set(session.documents.map((d) => d.kind));
    if (!kinds.has(DocumentKind.ID_FRONT) || !kinds.has(DocumentKind.SELFIE)) {
      throw new BadRequestException('ID_FRONT and SELFIE are required before submitting');
    }

    // Atomic claim: only one concurrent submit can move the session out of PENDING.
    const claimed = await this.prisma.session.updateMany({
      where: { id: session.id, status: SessionStatus.PENDING, expiresAt: { gt: new Date() } },
      data: { status: SessionStatus.NEEDS_REVIEW },
    });
    if (claimed.count === 0) throw new GoneException('Session already submitted or expired');
    await this.prisma.auditLog.create({ data: { sessionId: session.id, event: 'session.submitted' } });

    // Fire and forget: a slow tenant endpoint must not hold up the user's request.
    void this.webhooks.send(session.tenant, {
      type: 'session.status_changed',
      sessionId: session.id,
      externalRef: session.externalRef,
      status: SessionStatus.NEEDS_REVIEW,
      occurredAt: new Date().toISOString(),
    });
    return { status: SessionStatus.NEEDS_REVIEW };
  }
}
