import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Tenant } from '@prisma/client';
import { TenantRequest } from './api-key.guard';

export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): Tenant => {
  return ctx.switchToHttp().getRequest<TenantRequest>().tenant as Tenant;
});
