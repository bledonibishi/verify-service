import { Controller, Get, NotFoundException, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { LIVENESS_HTML, LIVENESS_JS, VERIFY_CSS, VERIFY_HTML, VERIFY_JS } from './page';

const STRICT =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; form-action 'none'; base-uri 'none'";

/**
 * The face check page only. AWS Face Liveness needs WebAssembly (face detection in the browser),
 * the camera stream, the detector's model from AWS's CDN and a WebSocket to Rekognition in the
 * liveness region. Still no inline script or style, and no other origin.
 */
const livenessPolicy = (region: string) =>
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; " +
  "media-src 'self' blob: mediastream:; worker-src 'self' blob:; " +
  `connect-src 'self' https://cdn.liveness.rekognition.amazonaws.com https://streaming-rekognition.${region}.amazonaws.com wss://streaming-rekognition.${region}.amazonaws.com; ` +
  "form-action 'none'; base-uri 'none'";

/**
 * No inline script or style, nothing from other origins. Photos preview from blob: URLs and the
 * page talks only to this service. `frame-ancestors` is 'none' unless HOSTED_FRAME_ANCESTORS lists
 * the origins allowed to embed the page (for example a tenant's own site).
 */
@Controller('verify')
export class HostedController {
  private readonly widget = new Map<string, Buffer | null>();

  constructor(private readonly config: ConfigService) {}

  private headers(contentType: string, policy = STRICT) {
    const ancestors = (this.config.get<string>('HOSTED_FRAME_ANCESTORS') ?? '').trim();
    // Only plain origins are accepted; anything else falls back to "no embedding"
    const safe = ancestors
      .split(/\s+/)
      .filter((o) => /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(o))
      .join(' ');
    return {
      'Content-Type': contentType,
      'Content-Security-Policy': `${policy}; frame-ancestors ${safe || "'none'"}`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      // The camera is the point of the page; everything else is off
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
      // X-Frame-Options cannot list origins, so with an allowlist it is SAMEORIGIN: browsers that
      // understand frame-ancestors ignore it and use the list; an old browser that does not is
      // refused embedding by anyone else instead of being left unprotected
      'X-Frame-Options': safe ? 'SAMEORIGIN' : 'DENY',
    };
  }

  /** Only a well-formed AWS region name goes into the policy header. */
  private livenessRegion(): string {
    const r = this.config.get<string>('LIVENESS_REGION') || 'eu-west-1';
    return /^[a-z]{2}(-[a-z]+)+-\d$/.test(r) ? r : 'eu-west-1';
  }

  /** The built widget (pnpm build:liveness). Read once; missing files answer 404 and the page offers the selfie instead. */
  private widgetFile(name: string): Buffer {
    if (!this.widget.has(name)) {
      const dir = resolve(this.config.get<string>('LIVENESS_WIDGET_DIR') || 'liveness-dist');
      let data: Buffer | null = null;
      try {
        data = readFileSync(join(dir, name));
      } catch {
        data = null;
      }
      this.widget.set(name, data);
    }
    const data = this.widget.get(name);
    if (!data) throw new NotFoundException('The face check is not installed on this server');
    return data;
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

  @Get('liveness')
  liveness(@Res() res: Response) {
    res.set(this.headers('text/html; charset=utf-8', livenessPolicy(this.livenessRegion()))).send(LIVENESS_HTML);
  }

  @Get('liveness.js')
  livenessJs(@Res() res: Response) {
    res.set(this.headers('text/javascript; charset=utf-8')).send(LIVENESS_JS);
  }

  // Large and the same for everyone: revalidated (ETag) rather than downloaded every time
  @Get('liveness-widget.js')
  widgetJs(@Res() res: Response) {
    res.set({ ...this.headers('text/javascript; charset=utf-8'), 'Cache-Control': 'no-cache' }).send(this.widgetFile('liveness-widget.js'));
  }

  @Get('liveness-widget.css')
  widgetCss(@Res() res: Response) {
    res.set({ ...this.headers('text/css; charset=utf-8'), 'Cache-Control': 'no-cache' }).send(this.widgetFile('liveness-widget.css'));
  }
}
