import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Month, currentMonth } from './month';

type Tx = Prisma.TransactionClient;

/** Metering reads and the monthly cap. The usage rows themselves are written by the verification worker. */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Verifications that count against a cap: billable ones this month, plus sessions in flight
   * (waiting for photos, or being processed), which are about to cost money. Our own failures do not count.
   */
  async committed(db: Tx | PrismaService, tenantId: string, month: Month, now = new Date()): Promise<number> {
    // One statement, so both counts come from the same snapshot. Read separately, a verification
    // completing between the two reads (leaving PROCESSING and gaining its usage event in one
    // transaction) would be missed by both and let a session slip past the cap.
    const rows = await db.$queryRaw<{ used: bigint }[]>(Prisma.sql`
      SELECT
        (SELECT COALESCE(SUM(quantity), 0) FROM usage_events
          WHERE tenant_id = ${tenantId} AND kind = 'verification' AND billable
            AND occurred_at >= ${month.from} AND occurred_at < ${month.to})
        +
        (SELECT COUNT(*) FROM sessions
          WHERE tenant_id = ${tenantId}
            AND (status = 'PROCESSING' OR (status = 'PENDING' AND expires_at > ${now})))
        AS used`);
    return Number(rows[0].used);
  }

  /**
   * Called inside the transaction that creates a session. The tenant's lock serialises creations, so
   * parallel requests cannot all slip under the cap. Answers 429 once the cap is reached.
   */
  async assertWithinCap(tx: Tx, tenantId: string): Promise<{ warn?: { used: number; cap: number } }> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;
    const t = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { monthlyVerificationCap: true, softLimitPercent: true, softLimitNotifiedMonth: true },
    });
    const cap = t.monthlyVerificationCap;
    if (cap === null) return {};

    const month = currentMonth();
    const used = await this.committed(tx, tenantId, month);
    if (used >= cap) {
      throw new HttpException(
        { statusCode: 429, error: 'Too Many Requests', message: 'Monthly verification limit reached', code: 'monthly_cap_reached', limit: cap },
        429,
      );
    }
    // Warn once a month when this session takes usage past the soft limit
    if ((used + 1) * 100 >= cap * t.softLimitPercent && t.softLimitNotifiedMonth !== month.label) {
      await tx.tenant.update({ where: { id: tenantId }, data: { softLimitNotifiedMonth: month.label } });
      return { warn: { used: used + 1, cap } };
    }
    return {};
  }

  logWarning(tenantId: string, warn: { used: number; cap: number }) {
    this.logger.warn(`Tenant ${tenantId} reached ${warn.used} of its ${warn.cap} monthly verifications`);
  }
}
