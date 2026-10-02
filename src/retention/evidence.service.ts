import { ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { DocumentKind, Tenant } from '@prisma/client';
import { hmacSign } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
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

  /** Returns the JSON body and a signature header value (same scheme as webhooks). */
  async export(tenant: Tenant, sessionId: string): Promise<{ body: string; signature: string }> {
    this.requireEnabled(tenant);
    const s = await this.prisma.session.findFirst({
      where: { id: sessionId, tenantId: tenant.id },
      include: { documents: true, result: true, reviewedBy: { select: { email: true } }, auditLogs: { orderBy: { createdAt: 'asc' } } },
    });
    if (!s) throw new NotFoundException('Session not found');

    const manifest = (s.documentsManifest as { kind: string; contentType: string; sizeBytes: number; sha256: string | null }[] | null) ?? [];
    const documents = s.documents.length
      ? s.documents.map((d) => ({ kind: d.kind, contentType: d.contentType, sizeBytes: d.sizeBytes, sha256: d.sha256 }))
      : manifest;

    await this.prisma.auditLog.create({ data: { sessionId: s.id, event: 'evidence.exported' } });

    const body = JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      session: {
        id: s.id,
        externalRef: s.externalRef,
        status: s.status,
        createdAt: s.createdAt,
        decidedAt: s.decidedAt,
        expiresAt: s.expiresAt,
      },
      expectedIdentity: { firstName: s.expectedFirstName, lastName: s.expectedLastName, birthDate: s.expectedBirthDate },
      verification: s.result ? toSummary(s.result) : null,
      review: s.reviewedAt ? { ...reviewSummary(s), reviewer: s.reviewedBy?.email ?? null } : null,
      documents,
      documentsDeletedAt: s.documentsDeletedAt,
      auditLog: s.auditLogs.map((l) => ({ event: l.event, detail: l.detail, at: l.createdAt })),
    });
    const t = Math.floor(Date.now() / 1000);
    return { body, signature: `t=${t},v1=${hmacSign(tenant.webhookSecret, `${t}.${body}`)}` };
  }

  /** One decrypted document, in memory only. */
  async document(tenant: Tenant, sessionId: string, kind: DocumentKind) {
    this.requireEnabled(tenant);
    const s = await this.prisma.session.findFirst({
      where: { id: sessionId, tenantId: tenant.id },
      include: { documents: { where: { kind } } },
    });
    if (!s) throw new NotFoundException('Session not found');
    if (s.documentsDeletedAt) throw new GoneException('Documents were deleted under the retention policy');
    const doc = s.documents[0];
    if (!doc) throw new NotFoundException('Document not found');
    const data = await this.storage.get(doc.storageKey);
    await this.prisma.auditLog.create({ data: { sessionId: s.id, event: 'evidence.document_exported', detail: { kind } } });
    return { data, contentType: doc.contentType, sha256: doc.sha256 };
  }
}
