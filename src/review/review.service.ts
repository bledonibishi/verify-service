import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DocumentKind, Reviewer, SessionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { toSummary } from '../verification/summary';
import { reviewSummary } from './review-summary';
import { WebhooksService } from '../webhooks/webhooks.service';

const PAGE = 25;

/** Every query here is filtered by the reviewer's tenant: a reviewer can never reach another tenant's data. */
@Injectable()
export class ReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly webhooks: WebhooksService,
  ) {}

  async queue(reviewer: Reviewer, cursor?: string) {
    const rows = await this.prisma.session.findMany({
      where: { tenantId: reviewer.tenantId, status: SessionStatus.NEEDS_REVIEW },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PAGE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { result: { select: { issueCodes: true } } },
    });
    const page = rows.slice(0, PAGE);
    return {
      items: page.map((s) => ({
        id: s.id,
        externalRef: s.externalRef,
        createdAt: s.createdAt,
        issues: s.result?.issueCodes ?? [],
      })),
      nextCursor: rows.length > PAGE ? page[page.length - 1].id : null,
    };
  }

  private async load(reviewer: Reviewer, id: string) {
    const session = await this.prisma.session.findFirst({
      where: { id, tenantId: reviewer.tenantId },
      include: { documents: { select: { kind: true } }, result: true },
    });
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  async detail(reviewer: Reviewer, id: string) {
    const s = await this.load(reviewer, id);
    return {
      id: s.id,
      externalRef: s.externalRef,
      status: s.status,
      createdAt: s.createdAt,
      // What the tenant said this person is, for the reviewer to compare against the documents
      expected: { firstName: s.expectedFirstName, lastName: s.expectedLastName, birthDate: s.expectedBirthDate },
      documents: s.documents.map((d) => d.kind),
      verification: s.result ? toSummary(s.result) : null,
      review: reviewSummary(s),
    };
  }

  /** Decrypts in memory for this one response; nothing is written back to disk. */
  async document(reviewer: Reviewer, id: string, kind: DocumentKind) {
    const session = await this.prisma.session.findFirst({
      where: { id, tenantId: reviewer.tenantId },
      include: { documents: { where: { kind } } },
    });
    const doc = session?.documents[0];
    if (!session || !doc) throw new NotFoundException('Document not found');
    const data = await this.storage.get(doc.storageKey);
    await this.prisma.auditLog.create({
      data: { sessionId: session.id, event: 'review.document_viewed', detail: { kind, reviewerId: reviewer.id } },
    });
    return { data, contentType: doc.contentType };
  }

  /**
   * Approve or reject a session waiting for review. The status condition makes the decision
   * single-winner: if two reviewers act at once, or the session already moved, the loser gets 409.
   */
  async decide(reviewer: Reviewer, id: string, decision: 'APPROVED' | 'REJECTED', reason?: string) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.session.updateMany({
        where: { id, tenantId: reviewer.tenantId, status: SessionStatus.NEEDS_REVIEW },
        data: { status: decision, reviewedById: reviewer.id, reviewReason: reason ?? null, reviewedAt: new Date(), decidedAt: new Date() },
      });
      if (moved.count === 0) return null;
      await tx.auditLog.create({
        data: { sessionId: id, event: 'review.decided', detail: { decision, reviewerId: reviewer.id, hasReason: !!reason } },
      });
      return tx.session.findFirstOrThrow({ where: { id, tenantId: reviewer.tenantId }, include: { tenant: true, result: true } });
    });
    if (!outcome) {
      const exists = await this.prisma.session.findFirst({ where: { id, tenantId: reviewer.tenantId }, select: { id: true } });
      if (!exists) throw new NotFoundException('Session not found');
      throw new ConflictException('Session is not waiting for review');
    }
    void this.webhooks.send(outcome.tenant, {
      type: 'session.status_changed',
      sessionId: outcome.id,
      externalRef: outcome.externalRef,
      status: outcome.status,
      occurredAt: new Date().toISOString(),
      verification: outcome.result ? toSummary(outcome.result) : undefined,
      review: reviewSummary(outcome),
    });
    return { status: outcome.status };
  }
}
