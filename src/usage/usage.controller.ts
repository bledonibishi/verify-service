import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Tenant } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApiKeyGuard } from '../tenants/api-key.guard';
import { CurrentTenant } from '../tenants/current-tenant.decorator';
import { aggregateUsage, emptyTotals } from './aggregate';
import { Month, currentMonth, parseMonth } from './month';
import { UsageService } from './usage.service';

const PAGE = 100;

function monthOrThrow(raw?: string): Month {
  if (raw === undefined) return currentMonth();
  const m = parseMonth(raw);
  if (!m) throw new BadRequestException('month must look like 2026-10');
  return m;
}

/** What the tenant has used, so it can check an invoice before it arrives. Tenant-scoped. */
@Controller('v1/usage')
@UseGuards(ApiKeyGuard)
export class UsageController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
  ) {}

  @Get()
  async month(@CurrentTenant() tenant: Tenant, @Query('month') raw?: string) {
    const month = monthOrThrow(raw);
    const totals = (await aggregateUsage(this.prisma, month, tenant.id)).get(tenant.id) ?? emptyTotals();
    const fresh = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      select: { monthlyVerificationCap: true, softLimitPercent: true },
    });
    const cap = fresh.monthlyVerificationCap;
    const committed = month.label === currentMonth().label ? await this.usage.committed(this.prisma, tenant.id, month) : null;
    return {
      month: month.label,
      from: month.from.toISOString(),
      to: month.to.toISOString(),
      verifications: {
        billable: totals.billable,
        nonBillable: totals.nonBillable,
        nonBillableByReason: totals.nonBillableByReason,
        adjustments: totals.adjustments,
        net: totals.net,
      },
      features: totals.features,
      // `committed` is billable verifications this month plus sessions in flight; only meaningful for the current month
      cap: { limit: cap, softLimitPercent: fresh.softLimitPercent, committed, remaining: cap === null || committed === null ? null : Math.max(0, cap - committed) },
    };
  }

  /** The individual events behind the totals, oldest first. Session ids are ones the tenant already holds. */
  @Get('events')
  async events(@CurrentTenant() tenant: Tenant, @Query('month') raw?: string, @Query('cursor') cursor?: string) {
    const month = monthOrThrow(raw);
    if (cursor !== undefined && !/^[0-9a-f-]{36}$/.test(cursor)) throw new BadRequestException('Invalid cursor');
    const rows = await this.prisma.usageEvent.findMany({
      where: { tenantId: tenant.id, occurredAt: { gte: month.from, lt: month.to } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: PAGE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, PAGE);
    return {
      month: month.label,
      items: page.map((e) => ({
        id: e.id,
        kind: e.kind,
        sessionId: e.sessionId,
        occurredAt: e.occurredAt,
        quantity: e.quantity,
        billable: e.billable,
        nonBillableReason: e.nonBillableReason,
        face: e.face,
        liveness: e.liveness,
        licence: e.licence,
        autoDecided: e.autoDecided,
        note: e.note,
      })),
      nextCursor: rows.length > PAGE ? page[page.length - 1].id : null,
    };
  }
}
