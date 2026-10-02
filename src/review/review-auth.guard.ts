import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reviewer } from '@prisma/client';
import { COOKIE_NAME, ReviewAuthService } from './auth.service';

export interface ReviewRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  reviewer?: Reviewer;
}

export function readCookie(header: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(header) ? header.join(';') : header;
  for (const part of (raw ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null; // malformed escape: treat as no cookie, never a server error
      }
    }
  }
  return null;
}

/**
 * Cookie session auth for the review API. The cookie is SameSite=Strict; on top of that, any
 * request that changes state must come from our own origin (checked via Origin when the browser
 * sends it), which closes the cross-site request forgery gap for older browsers.
 */
@Injectable()
export class ReviewAuthGuard implements CanActivate {
  constructor(
    private readonly auth: ReviewAuthService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ReviewRequest>();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) this.checkOrigin(req);
    const token = readCookie(req.headers.cookie, COOKIE_NAME);
    const reviewer = token ? await this.auth.authenticate(token) : null;
    if (!reviewer) throw new UnauthorizedException('Not signed in');
    req.reviewer = reviewer;
    return true;
  }

  checkOrigin(req: Pick<ReviewRequest, 'headers'>) {
    const origin = req.headers.origin;
    if (!origin) return; // non-browser client, or same-origin request without the header
    const allowed = new URL(this.config.get<string>('PUBLIC_BASE_URL') || 'http://localhost').origin;
    const host = req.headers.host;
    const ok = origin === allowed || (typeof host === 'string' && (origin === `http://${host}` || origin === `https://${host}`));
    if (!ok) throw new ForbiddenException('Cross-origin request refused');
  }
}
