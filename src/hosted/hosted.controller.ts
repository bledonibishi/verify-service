import { Controller, Get, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { VERIFY_CSS, VERIFY_HTML, VERIFY_JS } from './page';

/**
 * No inline script or style, nothing from other origins. Photos preview from blob: URLs and the
 * page talks only to this service. `frame-ancestors` is 'none' unless HOSTED_FRAME_ANCESTORS lists
 * the origins allowed to embed the page (for example a tenant's own site).
 */
@Controller('verify')
export class HostedController {
  constructor(private readonly config: ConfigService) {}

  private headers(contentType: string) {
    const ancestors = (this.config.get<string>('HOSTED_FRAME_ANCESTORS') ?? '').trim();
    // Only plain origins are accepted; anything else falls back to "no embedding"
    const safe = ancestors
      .split(/\s+/)
      .filter((o) => /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(o))
      .join(' ');
    return {
      'Content-Type': contentType,
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; " +
        `form-action 'none'; base-uri 'none'; frame-ancestors ${safe || "'none'"}`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      // The camera is the point of the page; everything else is off
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
      ...(safe ? {} : { 'X-Frame-Options': 'DENY' }),
    };
  }

  @Get()
  index(@Res() res: Response) {
    res.set(this.headers('text/html; charset=utf-8')).send(VERIFY_HTML);
  }

  @Get('app.js')
  js(@Res() res: Response) {
    res.set(this.headers('text/javascript; charset=utf-8')).send(VERIFY_JS);
  }

  @Get('app.css')
  css(@Res() res: Response) {
    res.set(this.headers('text/css; charset=utf-8')).send(VERIFY_CSS);
  }
}
