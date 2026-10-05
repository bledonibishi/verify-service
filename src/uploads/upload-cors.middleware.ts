import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Lets a tenant's own web page call the upload endpoints directly (the browser SDK). These
 * endpoints are authorised by the one-time token in the URL, never by cookies or ambient
 * credentials, so any origin may call them: a page that does not hold the token cannot do
 * anything with them. Credentials are not allowed, and nothing else on the service gets CORS.
 */
@Injectable()
export class UploadCorsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    next();
  }
}
