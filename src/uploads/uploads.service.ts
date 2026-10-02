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
      await this.prisma.session.update({
        where: { id: session.id },
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

    // Re-uploading the same kind replaces the earlier file.
    const existing = session.documents.find((d) => d.kind === kind);
    await this.prisma.document.upsert({
      where: { sessionId_kind: { sessionId: session.id, kind } },
      create: { sessionId: session.id, kind, storageKey, contentType, sizeBytes: data.length },
      update: { storageKey, contentType, sizeBytes: data.length },
    });
    if (existing) await this.storage.delete(existing.storageKey);

    await this.prisma.auditLog.create({
      data: { sessionId: session.id, event: 'document.uploaded', detail: { kind } },
    });
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

    const updated = await this.prisma.session.update({
      where: { id: session.id },
      data: {
        status: SessionStatus.NEEDS_REVIEW,
        auditLogs: { create: { event: 'session.submitted' } },
      },
    });

    await this.webhooks.send(session.tenant, {
      type: 'session.status_changed',
      sessionId: updated.id,
      externalRef: updated.externalRef,
      status: updated.status,
      occurredAt: new Date().toISOString(),
    });
    return { status: updated.status };
  }
}
