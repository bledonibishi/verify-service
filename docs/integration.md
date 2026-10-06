# Integrating verify-service

Two ways to collect the photos, one way to hear the result.

```
your server ──create session──▶ verify-service ──▶ hostedUrl
      ▲                                              │ send the user there
      │ webhook (signed) / GET result                ▼
      └──────────────────────────────  user's browser uploads the photos
```

1. **Your server** creates a session with its API key and gets a `hostedUrl`.
2. **The user** opens the `hostedUrl` (in a browser or webview). The hosted page asks for the photos, uploads them and submits.
3. **You** receive a signed webhook when the result is decided, or read it with `GET /v1/sessions/:id`.

Never put the API key in a browser or app: it belongs on your server. The browser only ever holds the one-time upload token inside the `hostedUrl`.

## The client SDK

`sdk/` is a dependency-free TypeScript package (`@verify-service/client`, uses the platform `fetch`, Node 18+). It is marked `private` until you decide how to publish it; for now build it with `pnpm sdk:build` and copy or `pnpm pack` it.

### On your server

```ts
import { VerifyClient, constructWebhookEvent, WebhookSignatureError } from '@verify-service/client';

const verify = new VerifyClient({
  apiKey: process.env.VERIFY_API_KEY!,
  baseUrl: 'https://verify.example.com',
});

// 1. Start a verification and send the user to hostedUrl
const session = await verify.sessions.create({
  externalRef: user.id,          // your own id for the person
  firstName: user.firstName,     // what you expect the ID to say (compared with the card)
  lastName: user.lastName,
  birthDate: user.birthDate,     // YYYY-MM-DD
  requireDrivingLicence: false,  // true: also read and cross-check a driving licence
});
redirect(session.hostedUrl);     // or open it in a webview

// 2. Receive the result (Express shown; the body must be the RAW bytes)
app.post('/webhooks/verify', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = constructWebhookEvent({
      payload: req.body,                                  // Buffer
      signatureHeader: req.header('x-verify-signature'),
      secret: process.env.VERIFY_WEBHOOK_SECRET!,
    });
  } catch (err) {
    if (err instanceof WebhookSignatureError) return res.sendStatus(400); // not from us, or replayed
    throw err;
  }
  if (await alreadyProcessed(event.eventId)) return res.sendStatus(200); // delivery is at-least-once
  await handle(event);   // event.status: APPROVED | REJECTED | NEEDS_REVIEW; event.verification has the details
  res.sendStatus(200);   // any 2xx; anything else is retried for about a day
});

// Or poll
const current = await verify.sessions.get(session.id);
```

Webhook rules (see the README for the full contract): verify the signature on the **raw** body before trusting anything, reject old timestamps (the helper does, 5 minutes by default), and **dedupe on `eventId`**. Events can arrive out of order after retries, so use `status` and `occurredAt`, not arrival order. `verify.webhookEvents.list('FAILED')` shows events that gave up and `retry(id)` replays one.

Check an invoice against your own usage with `verify.usage.get('2026-10')` (totals, add-on counts, your cap) and `verify.usage.events('2026-10')`. If you have a monthly cap, `sessions.create` throws a `VerifyApiError` with `status: 429` and `code: 'monthly_cap_reached'` once it is reached.

Other calls: `verify.sessions.delete(id)` (erase a person now), `evidence(id)` and `evidenceDocument(id, kind)` (tenants with evidence export; pass `webhookSecret` to have the bundle's signature checked for you). Reads and deletes are retried on network errors, 429 and 5xx (a delete whose reply was lost and that then finds nothing to delete counts as done); **creating a session is never retried**, because a repeat would create a second one. Errors are `VerifyApiError` (with `status`, `isNotFound`, `isRateLimited`) or `VerifyNetworkError`.

### In your own screens (browser SDK)

If you build your own capture screens instead of using the hosted page, the browser client holds only the upload token:

```ts
import { UploadClient } from '@verify-service/client/browser';

const upload = new UploadClient({ baseUrl: 'https://verify.example.com', token: session.uploadToken });
const { steps } = await upload.getSession();         // which photos, in order, and which are required
for (const step of steps) await upload.upload(step.kind, photoFor(step.kind)); // JPEG/PNG/WebP, max 8 MB
await upload.submit();                                // the link is then used up
```

The upload endpoints answer CORS for any origin because the one-time token, not the origin, is the credential (no cookies are involved). Nothing else on the service allows cross-origin calls. Uploads are retried on transient failures; `submit` is not, because a repeat after a lost reply would be refused. `410` answers carry a machine-readable `code` (`error.code` on `VerifyApiError`): `session_submitted` (already submitted, so thank the user), `session_expired`, or `session_closed` (look at `getSession()` again to find out which). If a `submit` fails without a clear answer, call `getSession()` before trying again: a `410` with `session_submitted` means it went through.

## The hosted page

`GET /verify#<token>`: a small static page (no framework, no third-party resources) that:

- asks for the ID front and back, the licence front and back when requested, and a selfie, in the order the service returns (`GET /v1/upload/:token`);
- opens the phone's camera through the browser's file picker (`capture`: rear camera for documents, front for the selfie), with a gallery option;
- **shrinks each photo to at most 2000 px and re-encodes it as JPEG in the browser** before upload (phone photos are large; this also turns HEIC and other formats into something the service accepts), and falls back to the original only when the browser cannot and the file is small enough;
- retries transient failures (but never blindly re-sends the final submit: after an unclear failure it first checks whether the submission went through), resumes after a reload, thanks a user who reloads after submitting, (the token is kept in `sessionStorage` and removed from the address bar), and explains expired or used links;
- is available in English, Albanian and Serbian (Latin), chosen from the browser language or `?lang=en|sq|sr`.

The token lives in the URL **fragment**, which browsers never send to servers, so it stays out of access logs and `Referer` headers. The page is served with a strict Content-Security-Policy (no inline script or style, nothing from other origins), `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and cannot be framed (`X-Frame-Options: DENY`). To embed it in your own site, list your origins in `HOSTED_FRAME_ANCESTORS` (space-separated `https://app.example.com`); invalid entries are ignored and the default is no embedding. The frame must be allowed to use the camera, or the face check cannot start (browsers block the camera in a frame from another origin unless the page that embeds it delegates it):

```html
<iframe src="https://verify.example.com/verify#…" allow="camera" title="Identity verification"></iframe>
```

For webviews, make sure camera permission is granted to the webview.

`PUBLIC_BASE_URL` must be the public address users reach; it is what `hostedUrl` is built from.

## Not covered yet

- **Liveness** is available with `LIVENESS_PROVIDER=aws` ([liveness](liveness.md)): the hosted page then asks for a face check instead of a selfie, with a selfie as a fallback. It has not yet been run on a real camera. Without it, sessions land in review rather than auto-approval. **If you build your own screens:** when `getSession()` says `liveness: true`, the selfie is optional and the face check replaces it; the face check itself currently only exists on the hosted page (`/verify/liveness`).
- **No return redirect.** After submitting, the page says the user can close it; there is no `returnUrl`. Show your own screen when the webhook arrives, or poll.
- **Camera guidance.** The page uses the native camera through the file picker: no live preview, edge detection or glare warning.
- **Translations.** The Albanian and Serbian texts were written by the developer, not a native translator; have them reviewed before launch.
- **Browser coverage.** The page's logic is tested in jsdom with stand-ins for the camera and canvas. It has not been exercised in real browsers or webviews yet: try it on an iPhone (Safari), an Android phone (Chrome) and your target webview before relying on it.
