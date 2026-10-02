import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { DocumentKind, Reviewer } from '@prisma/client';
import type { Response } from 'express';
import { COOKIE_NAME, ReviewAuthService } from './auth.service';
import { DecisionDto, LoginDto } from './review.dto';
import { ReviewAuthGuard, ReviewRequest, readCookie } from './review-auth.guard';
import { ReviewService } from './review.service';

/** Login attempts per minute per IP; read per request so deployments (and tests) can tune it. */
const loginLimit = () => Number(process.env.LOGIN_RATE_LIMIT) || 10;

@Controller('review/api')
export class ReviewController {
  constructor(
    private readonly auth: ReviewAuthService,
    private readonly review: ReviewService,
    private readonly guard: ReviewAuthGuard,
    private readonly config: ConfigService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: loginLimit, ttl: 60_000 } })
  async login(@Req() req: ReviewRequest, @Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    this.guard.checkOrigin(req); // blocks login CSRF too
    const { token, expiresAt, reviewer } = await this.auth.login(dto.email, dto.password);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: (this.config.get<string>('PUBLIC_BASE_URL') ?? '').startsWith('https://'),
      path: '/review',
      expires: expiresAt,
    });
    return { email: reviewer.email, name: reviewer.name };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(ReviewAuthGuard)
  async logout(@Req() req: ReviewRequest, @Res({ passthrough: true }) res: Response) {
    const token = readCookie(req.headers.cookie, COOKIE_NAME);
    if (token) await this.auth.logout(token);
    res.clearCookie(COOKIE_NAME, { path: '/review' });
  }

  @Get('me')
  @UseGuards(ReviewAuthGuard)
  me(@Req() req: ReviewRequest) {
    const r = req.reviewer as Reviewer;
    return { email: r.email, name: r.name };
  }

  @Get('sessions')
  @UseGuards(ReviewAuthGuard)
  queue(@Req() req: ReviewRequest, @Query('cursor') cursor?: string) {
    if (cursor !== undefined && !/^[0-9a-f-]{36}$/.test(cursor)) throw new BadRequestException('Invalid cursor');
    return this.review.queue(req.reviewer as Reviewer, cursor);
  }

  @Get('sessions/:id')
  @UseGuards(ReviewAuthGuard)
  detail(@Req() req: ReviewRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.review.detail(req.reviewer as Reviewer, id);
  }

  @Get('sessions/:id/documents/:kind')
  @UseGuards(ReviewAuthGuard)
  async document(
    @Req() req: ReviewRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind', new ParseEnumPipe(DocumentKind)) kind: DocumentKind,
    @Res() res: Response,
  ) {
    const { data, contentType } = await this.review.document(req.reviewer as Reviewer, id, kind);
    res
      .set({
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': 'inline',
      })
      .send(data);
  }

  @Post('sessions/:id/decision')
  @HttpCode(200)
  @UseGuards(ReviewAuthGuard)
  decide(@Req() req: ReviewRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) {
    const reason = dto.reason?.trim();
    if (dto.decision === 'REJECTED' && !reason) throw new BadRequestException('A reason is required when rejecting');
    return this.review.decide(req.reviewer as Reviewer, id, dto.decision, reason || undefined);
  }
}
