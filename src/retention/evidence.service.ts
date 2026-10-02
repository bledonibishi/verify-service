import { ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { DocumentKind, Prisma, Tenant } from '@prisma/client';
import { hmacSign } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService, StoredObjectMissingError } from '../storage/storage.service';
import { toSummary } from '../verification/summary';
import { reviewSummary } from '../review/review-summary';

/**
 * Evidence export for regulated tenants who must keep proof of how a person was verified. It is
 * off by default because it hands decrypted documents to the tenant, which the rest of the API
 * never does. Everything is scoped to the calling tenant and every export is audit-logged.
 */
@Injectable()
export class EvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  private requireEnabled(tenant: Tenant) {
    if (!tenant.evidenceExport) throw new ForbiddenException('Evidence export is not enabled for this tenant');
  }

  /**
   * Holds a share lock on the session row while the caller reads and audits. Erasure takes the
   * exclusive lock on the same row, so an export and an erasure run one after the other: the
   * export either completes consistently or finds the session gone (404), never half a session.
   */
  private async withSessionLocked<T>(tenant: Tenant, sessionId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM sessions WHERE id = ${sessionId} AND tenant_id = ${tenant.id} FOR SHARE`);
      if (rows.length === 0) throw new NotFoundException('Session not found');
      return work(tx);
    }, { timeout: 30_000 });
  }

  /** Returns the JSON body and a signature header value (same scheme as webhooks). */
  async export(tenant: Tenant, sessionId: string): Promise<{ body: string; signature: string }> {
    this.requireEnabled(tenant);
    return this.withSessionLocked(tenant, sessionId, async (tx) => {
      // Record the export first, so the signed audit trail includes this very export
      await tx.auditLog.create({ data: { sessionId, event: 'evidence.exported' } });
      const s = await tx.session.findFirstOrThrow({
        where: { id: sessionId, tenantId: tenant.id },
        include: { documents: true, result: true, reviewedBy: { select: { email: true } }, auditLogs: { orderBy: { createdAt: 'asc' } } },
      });
      const manifest = (s.documentsManifest as { kind: string; contentType: string; sizeBytes: number; sha256: string | null }[] | null) ?? [];
      const documents = s.documents.length
        ? s.documents.map((d) => ({ kind: d.kind, contentType: d.contentType, sizeBytes: d.sizeBytes, sha256: d.sha256 }))
        : manifest;
      const body = JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        session: { id: s.id, externalRef: s.externalRef, status: s.status, createdAt: s.createdAt, decidedAt: s.decidedAt, expiresAt: s.expiresAt },
        expectedIdentity: { firstName: s.expectedFirstName, lastName: s.expectedLastName, birthDate: s.expectedBirthDate },
        verification: s.result ? toSummary(s.result) : null,
        review: s.reviewedAt ? { ...reviewSummary(s), reviewer: s.reviewedBy?.email ?? null } : null,
        documents,
        documentsDeletedAt: s.documentsDeletedAt,
        auditLog: s.auditLogs.map((l) => ({ event: l.event, detail: l.detail, at: l.createdAt })),
      });
      const t = Math.floor(Date.now() / 1000);
      return { body, signature: `t=${t},v1=${hmacSign(tenant.webhookSecret, `${t}.${body}`)}` };
    });
  }

  /** One decrypted document, in memory only. */
  async document(tenant: Tenant, sessionId: string, kind: DocumentKind) {
    this.requireEnabled(tenant);
    return this.withSessionLocked(tenant, sessionId, async (tx) => {
      const s = await tx.session.findFirstOrThrow({
        where: { id: sessionId, tenantId: tenant.id },
        include: { documents: { where: { kind } } },
      });
      if (s.documentsDeletedAt) throw new GoneException('Documents were deleted under the retention policy');
      const doc = s.documents[0];
      if (!doc) throw new NotFoundException('Document not found');
      let data: Buffer;
      try {
        data = await this.storage.get(doc.storageKey);
      } catch (err) {
        // An erasure that did not finish (rows survive, file gone) reads as deleted, not as a server error
        if (err instanceof StoredObjectMissingError) throw new GoneException('Document was deleted');
        throw err;
      }
      await tx.auditLog.create({ data: { sessionId, event: 'evidence.document_exported', detail: { kind } } });
      return { data, contentType: doc.contentType, sha256: doc.sha256 };
    });
  }
}
