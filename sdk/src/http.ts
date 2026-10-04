import { VerifyApiError, VerifyNetworkError, messageOf } from './errors';

export type FetchLike = typeof fetch;

export interface HttpOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Extra attempts for requests that are safe to repeat. Default 2. */
  maxRetries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A request that may be repeated if it fails: reads and deletes, never creates. */
export interface CallOptions {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  retry?: boolean;
  /**
   * For deletes: a 404 that follows a failed attempt whose outcome is unknown (connection lost,
   * timeout, 5xx) means the first attempt got through, so it counts as done. A 404 on the very
   * first attempt is still reported as not found.
   */
  treatMissingAsDone?: boolean;
}

export class Http {
  private readonly fetchFn: FetchLike;
  private readonly base: string;

  constructor(private readonly opts: HttpOptions) {
    this.fetchFn = opts.fetch ?? fetch.bind(globalThis);
    this.base = opts.baseUrl.replace(/\/+$/, '');
  }

  /** Returns the response with its body unread; throws `VerifyApiError` for non-2xx. */
  async call(c: CallOptions): Promise<Response> {
    const retries = c.retry ? this.opts.maxRetries ?? 2 : 0;
    let unknownOutcome = false; // an earlier attempt may have been carried out before it failed
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(this.base + c.path, {
          method: c.method,
          headers: c.headers,
          body: c.body,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
          redirect: 'error',
        });
      } catch (err) {
        if (attempt < retries) {
          unknownOutcome = true;
          await sleep(200 * 2 ** attempt);
          continue;
        }
        throw new VerifyNetworkError('Request failed or timed out', err);
      }
      if (res.ok) return res;
      if (res.status === 404 && c.treatMissingAsDone && unknownOutcome) {
        await res.body?.cancel().catch(() => undefined);
        return new Response(null, { status: 204 });
      }
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        // A 429 was refused before it was acted on; a 5xx may have been acted on
        if (res.status >= 500) unknownOutcome = true;
        await res.body?.cancel().catch(() => undefined);
        await sleep(200 * 2 ** attempt);
        continue;
      }
      const body = await res.json().catch(() => undefined);
      throw new VerifyApiError(res.status, messageOf(body, `Request failed with status ${res.status}`), body);
    }
  }

  async json<T>(c: CallOptions): Promise<T> {
    return (await this.call(c)).json() as Promise<T>;
  }
}
