import { BadRequestException, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards, ConflictException, NotFoundException } from '@nestjs/common';
import { Tenant, WebhookEventStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApiKeyGuard } from '../tenants/api-key.guard';
import { CurrentTenant } from '../tenants/current-tenant.decorator';
import { WebhookDispatcher } from './dispatcher';

/** Lets a tenant see whether its webhooks arrived, and replay one that gave up. Tenant-scoped. */
@Controller('v1/webhook-events')
@UseGuards(ApiKeyGuard)
export class WebhookEventsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: WebhookDispatcher,
  ) {}

  @Get()
  async list(@CurrentTenant() tenant: Tenant, @Query('status') status?: string) {
    if (status !== undefined && !(Object.values(WebhookEventStatus) as string[]).includes(status)) throw new BadRequestException('status must be PENDING, DELIVERED or FAILED');
    const rows = await this.prisma.webhookEvent.findMany({
      where: { tenantId: tenant.id, ...(status ? { status: status as WebhookEventStatus } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      items: rows.map((e) => ({
        id: e.id,
        sessionId: e.sessionId,
        type: e.type,
        status: e.status,
        attempts: e.attempts,
        lastError: e.lastError,
        nextAttemptAt: e.status === 'PENDING' ? e.nextAttemptAt : null,
        deliveredAt: e.deliveredAt,
        createdAt: e.createdAt,
      })),
    };
  }

  /** Re-queue an event that exhausted its attempts, for example after fixing the receiving endpoint. */
  @Post(':id/retry')
  @HttpCode(202)
  async retry(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const reset = await this.prisma.webhookEvent.updateMany({
      where: { id, tenantId: tenant.id, status: 'FAILED' },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lockedUntil: null, failedAt: null },
    });
    if (reset.count === 0) {
      const exists = await this.prisma.webhookEvent.findFirst({ where: { id, tenantId: tenant.id }, select: { id: true } });
      if (!exists) throw new NotFoundException('Event not found');
      throw new ConflictException('Only failed events can be retried');
    }
    void this.dispatcher.wake();
    return { status: 'PENDING' };
  }
}
