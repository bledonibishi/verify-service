import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Tenant } from '@prisma/client';
import { sha256 } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';

export interface TenantRequest {
  headers: Record<string, string | string[] | undefined>;
  tenant?: Tenant;
}

/** Authenticates server-to-server calls with `Authorization: Bearer <api key>`. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<TenantRequest>();
    const header = req.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    const match = value?.match(/^Bearer (.+)$/);
    if (!match) throw new UnauthorizedException('Missing API key');

    const tenant = await this.prisma.tenant.findUnique({
      where: { apiKeyHash: sha256(match[1]) },
    });
    if (!tenant) throw new UnauthorizedException('Invalid API key');
    req.tenant = tenant;
    return true;
  }
}
