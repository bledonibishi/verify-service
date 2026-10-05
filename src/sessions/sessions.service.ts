import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Tenant } from '@prisma/client';
import { randomToken, sha256 } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { reviewSummary } from '../review/review-summary';
import { toSummary } from '../verification/summary';
import { CreateSessionDto } from './sessions.dto';

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly usage: UsageService,
  ) {}

  async create(tenant: Tenant, dto: CreateSessionDto) {
    const token = randomToken();
    // Blank or non-numeric values fall back to the default instead of producing 0 or NaN.
    const configured = parseInt(this.config.get<string>('SESSION_TTL_MINUTES') ?? '', 10);
    const ttlMinutes = Number.isFinite(configured) && configured > 0 ? configured : 60;
    const { session, warn } = await this.prisma.$transaction(async (tx) => {
      // The cap is checked in the same transaction (and under the tenant's lock) as the creation
      const { warn } = await this.usage.assertWithinCap(tx, tenant.id);
      const session = await tx.session.create({
        data: {
          tenantId: tenant.id,
          externalRef: dto.externalRef,
          tokenHash: sha256(token),
          expectedFirstName: dto.firstName,
          expectedLastName: dto.lastName,
          expectedBirthDate: dto.birthDate,
          requireLicence: dto.requireDrivingLicence ?? false,
          expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
          auditLogs: { create: { event: 'session.created' } },
        },
      });
      return { session, warn };
    });
    if (warn) this.usage.logWarning(tenant.id, warn);
    const base = this.config.get<string>('PUBLIC_BASE_URL') ?? '';
    return {
      id: session.id,
      // The token is only ever shown here; only its hash is stored.
      uploadToken: token,
      uploadUrl: `${base}/v1/upload/${token}`,
      // The hosted capture page. The token sits in the URL fragment, which browsers never send to a
      // server, so it stays out of access logs and Referer headers.
      hostedUrl: `${base}/verify#${token}`,
      expiresAt: session.expiresAt,
      status: session.status,
      requireDrivingLicence: session.requireLicence,
    };
  }

  async get(tenant: Tenant, id: string) {
    const session = await this.prisma.session.findFirst({
      where: { id, tenantId: tenant.id },
      include: { documents: { select: { kind: true } }, result: true },
    });
    if (!session) throw new NotFoundException('Session not found');
    // Expiry is only persisted when someone touches the upload link, so report it here too.
    const expired = session.status === 'PENDING' && session.expiresAt.getTime() < Date.now();
    return {
      id: session.id,
      externalRef: session.externalRef,
      status: expired ? 'EXPIRED' : session.status,
      expiresAt: session.expiresAt,
      requireDrivingLicence: session.requireLicence,
      uploaded: session.documents.map((d) => d.kind),
      documentsDeletedAt: session.documentsDeletedAt,
      verification: session.result ? toSummary(session.result) : null,
      review: reviewSummary(session),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}
