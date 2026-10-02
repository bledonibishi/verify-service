import { Body, Controller, Delete, Get, HttpCode, Param, ParseEnumPipe, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { DocumentKind, Tenant } from '@prisma/client';
import type { Response } from 'express';
import { EvidenceService } from '../retention/evidence.service';
import { PurgeService } from '../retention/purge.service';
import { ApiKeyGuard } from '../tenants/api-key.guard';
import { CurrentTenant } from '../tenants/current-tenant.decorator';
import { CreateSessionDto } from './sessions.dto';
import { SessionsService } from './sessions.service';

@Controller('v1/sessions')
@UseGuards(ApiKeyGuard)
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly purge: PurgeService,
    private readonly evidence: EvidenceService,
  ) {}

  @Post()
  create(@CurrentTenant() tenant: Tenant, @Body() dto: CreateSessionDto) {
    return this.sessions.create(tenant, dto);
  }

  @Get(':id')
  get(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.get(tenant, id);
  }

  /** Erase a session and its documents now (data-subject request). Leaves a record with no personal data. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    await this.purge.deleteForTenant(tenant.id, id);
  }

  /** Signed evidence bundle; only for tenants with evidence export enabled. */
  @Get(':id/evidence')
  async exportEvidence(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const { body, signature } = await this.evidence.export(tenant, id);
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'X-Evidence-Signature': signature, 'Cache-Control': 'no-store' });
    return body;
  }

  @Get(':id/evidence/documents/:kind')
  async exportDocument(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind', new ParseEnumPipe(DocumentKind)) kind: DocumentKind,
    @Res() res: Response,
  ) {
    const { data, contentType, sha256 } = await this.evidence.document(tenant, id, kind);
    res
      .set({
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        ...(sha256 ? { 'X-Document-Sha256': sha256 } : {}),
      })
      .send(data);
  }
}
