import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

export interface StatusChange {
  sessionId: string;
  externalRef: string;
  status: string;
  /** Automated check results; present once the pipeline has run. */
  verification?: unknown;
  /** Human review decision, present when a reviewer decided the session. */
  review?: unknown;
}

/**
 * Queues webhook events. Call it inside the same transaction that changes the session, so an
 * event exists if and only if the change committed: no lost notification, no phantom one.
 */
@Injectable()
export class OutboxService {
  /** Returns the event id, or null when the tenant has no webhook URL (nothing is queued). */
  async enqueue(tx: Prisma.TransactionClient, tenant: { id: string; webhookUrl: string | null }, change: StatusChange): Promise<string | null> {
    if (!tenant.webhookUrl) return null;
    const id = randomUUID();
    const body = JSON.stringify({
      eventId: id,
      type: 'session.status_changed',
      sessionId: change.sessionId,
      externalRef: change.externalRef,
      status: change.status,
      occurredAt: new Date().toISOString(),
      ...(change.verification !== undefined ? { verification: change.verification } : {}),
      ...(change.review !== undefined ? { review: change.review } : {}),
    });
    await tx.webhookEvent.create({
      data: { id, tenantId: tenant.id, sessionId: change.sessionId, type: 'session.status_changed', body },
    });
    return id;
  }
}
