import { VerifyApiError } from './errors';
import { Http, HttpOptions } from './http';
import type {
  CreateSessionInput,
  CreatedSession,
  DocumentKind,
  EvidenceBundle,
  Session,
  WebhookEventRecord,
} from './types';
import { verifySignature } from './webhooks';

export interface VerifyClientOptions extends HttpOptions {
  /** Your tenant API key. Keep it on your server: never ship it to a browser or app. */
  apiKey: string;
  /** The webhook secret, only needed to verify evidence bundles. */
  webhookSecret?: string;
}

const enc = encodeURIComponent;

/**
 * Server-side client. Reads (and deletes) are retried on network errors, 429 and 5xx; creating a
 * session is never retried automatically because a repeat would create a second session.
 */
export class VerifyClient {
  private readonly http: Http;
  private readonly auth: Record<string, string>;

  readonly sessions: {
    create(input: CreateSessionInput): Promise<CreatedSession>;
    get(id: string): Promise<Session>;
    /** Erase a session and its documents now (data-subject request). */
    delete(id: string): Promise<void>;
    /** Signed evidence bundle; only for tenants with evidence export enabled. */
    evidence(id: string): Promise<{ bundle: EvidenceBundle; raw: string; signature: string }>;
    /** One decrypted document and its SHA-256, for tenants with evidence export enabled. */
    evidenceDocument(id: string, kind: DocumentKind): Promise<{ data: Uint8Array; contentType: string; sha256: string | null }>;
  };

  readonly webhookEvents: {
    list(status?: 'PENDING' | 'DELIVERED' | 'FAILED'): Promise<WebhookEventRecord[]>;
    /** Re-queue an event that gave up. */
    retry(id: string): Promise<void>;
  };

  constructor(private readonly opts: VerifyClientOptions) {
    if (!opts.apiKey) throw new Error('apiKey is required');
    if (!opts.baseUrl) throw new Error('baseUrl is required');
    this.http = new Http(opts);
    this.auth = { authorization: `Bearer ${opts.apiKey}` };

    this.sessions = {
      create: (input) =>
        this.http.json<CreatedSession>({ method: 'POST', path: '/v1/sessions', headers: { ...this.auth, 'content-type': 'application/json' }, body: JSON.stringify(input) }),
      get: (id) => this.http.json<Session>({ method: 'GET', path: `/v1/sessions/${enc(id)}`, headers: this.auth, retry: true }),
      delete: async (id) => {
        await this.http.call({ method: 'DELETE', path: `/v1/sessions/${enc(id)}`, headers: this.auth, retry: true });
      },
      evidence: async (id) => {
        const res = await this.http.call({ method: 'GET', path: `/v1/sessions/${enc(id)}/evidence`, headers: this.auth, retry: true });
        const raw = await res.text();
        const signature = res.headers.get('x-evidence-signature') ?? '';
        // Refuse a bundle that does not verify, when we know the secret to check it with
        if (this.opts.webhookSecret) verifySignature({ payload: raw, signatureHeader: signature, secret: this.opts.webhookSecret });
        return { bundle: JSON.parse(raw) as EvidenceBundle, raw, signature };
      },
      evidenceDocument: async (id, kind) => {
        const res = await this.http.call({ method: 'GET', path: `/v1/sessions/${enc(id)}/evidence/documents/${enc(kind)}`, headers: this.auth, retry: true });
        return {
          data: new Uint8Array(await res.arrayBuffer()),
          contentType: res.headers.get('content-type') ?? 'application/octet-stream',
          sha256: res.headers.get('x-document-sha256'),
        };
      },
    };

    this.webhookEvents = {
      list: async (status) => {
        const q = status ? `?status=${enc(status)}` : '';
        const r = await this.http.json<{ items: WebhookEventRecord[] }>({ method: 'GET', path: `/v1/webhook-events${q}`, headers: this.auth, retry: true });
        return r.items;
      },
      retry: async (id) => {
        await this.http.call({ method: 'POST', path: `/v1/webhook-events/${enc(id)}/retry`, headers: this.auth });
      },
    };
  }
}

export { VerifyApiError };
