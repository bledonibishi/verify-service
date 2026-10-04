import { VerifyApiError } from './errors';
import { Http, HttpOptions } from './http';
import type { DocumentKind, UploadSessionInfo } from './types';

export interface UploadClientOptions extends Omit<HttpOptions, 'maxRetries'> {
  /** The `uploadToken` your server received when it created the session. */
  token: string;
}

/**
 * Runs in the user's browser (or app) and holds only the one-time upload token: never your API
 * key. Uploads are retried on network errors, 429 and 5xx. For a ready-made screen, send the
 * user to the session's `hostedUrl` instead.
 */
export class UploadClient {
  private readonly http: Http;
  private readonly prefix: string;

  constructor(opts: UploadClientOptions) {
    if (!opts.token) throw new Error('token is required');
    // Re-uploading a picture replaces the earlier one, so repeating an upload is safe
    this.http = new Http({ ...opts, maxRetries: 3 });
    this.prefix = `/v1/upload/${encodeURIComponent(opts.token)}`;
  }

  /** Which pictures to ask for, and which are already uploaded. */
  getSession(): Promise<UploadSessionInfo> {
    return this.http.json<UploadSessionInfo>({ method: 'GET', path: this.prefix, retry: true });
  }

  /** `file` must be a JPEG, PNG or WebP of at most 8 MB. */
  async upload(kind: DocumentKind, file: Blob, filename = `${kind.toLowerCase()}.jpg`): Promise<void> {
    const body = new FormData();
    body.append('file', file, filename);
    await this.http.call({ method: 'POST', path: `${this.prefix}/${kind}`, body, retry: true });
  }

  /** Start a liveness challenge; returns what the provider's widget needs. Answers 501 when none is configured. */
  startLiveness(): Promise<{ provider: string; sessionId: string; [key: string]: unknown }> {
    return this.http.json({ method: 'POST', path: `${this.prefix}/liveness` });
  }

  /** Finish. Not retried: a repeat after success would fail with "already submitted". */
  async submit(): Promise<{ status: string }> {
    return this.http.json({ method: 'POST', path: `${this.prefix}/submit` });
  }
}

export { VerifyApiError, VerifyNetworkError } from './errors';
export type * from './types';
