import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Tenant } from '@prisma/client';
import { randomToken, sha256 } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSessionDto } from './sessions.dto';

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async create(tenant: Tenant, dto: CreateSessionDto) {
    const token = randomToken();
    const ttlMinutes = Number(this.config.get('SESSION_TTL_MINUTES') ?? 60);
    const session = await this.prisma.session.create({
      data: {
        tenantId: tenant.id,
        externalRef: dto.externalRef,
        tokenHash: sha256(token),
        expectedFirstName: dto.firstName,
        expectedLastName: dto.lastName,
        expectedBirthDate: dto.birthDate,
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
        auditLogs: { create: { event: 'session.created' } },
      },
    });
    const base = this.config.get<string>('PUBLIC_BASE_URL') ?? '';
    return {
      id: session.id,
      // The token is only ever shown here; only its hash is stored.
      uploadToken: token,
      uploadUrl: `${base}/v1/upload/${token}`,
      expiresAt: session.expiresAt,
      status: session.status,
    };
  }

  async get(tenant: Tenant, id: string) {
    const session = await this.prisma.session.findFirst({
      where: { id, tenantId: tenant.id },
      include: { documents: { select: { kind: true } } },
    });
    if (!session) throw new NotFoundException('Session not found');
    return {
      id: session.id,
      externalRef: session.externalRef,
      status: session.status,
      expiresAt: session.expiresAt,
      uploaded: session.documents.map((d) => d.kind),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}
