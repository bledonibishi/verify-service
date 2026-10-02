import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { APP_CSS, APP_JS, INDEX_HTML } from './ui';

// No inline script or style, no framing, nothing loaded from elsewhere.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const common = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

@Controller('review')
export class ReviewUiController {
  @Get()
  index(@Res() res: Response) {
    res.set({ ...common, 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' }).send(INDEX_HTML);
  }

  @Get('app.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  js(@Res() res: Response) {
    res.set(common).send(APP_JS);
  }

  @Get('app.css')
  css(@Res() res: Response) {
    res.set({ ...common, 'Content-Type': 'text/css; charset=utf-8' }).send(APP_CSS);
  }
}
