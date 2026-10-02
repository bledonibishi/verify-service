import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Tenant } from '@prisma/client';
import { ApiKeyGuard } from '../tenants/api-key.guard';
import { CurrentTenant } from '../tenants/current-tenant.decorator';
import { CreateSessionDto } from './sessions.dto';
import { SessionsService } from './sessions.service';

@Controller('v1/sessions')
@UseGuards(ApiKeyGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post()
  create(@CurrentTenant() tenant: Tenant, @Body() dto: CreateSessionDto) {
    return this.sessions.create(tenant, dto);
  }

  @Get(':id')
  get(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.get(tenant, id);
  }
}
