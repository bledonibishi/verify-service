# Liveness (AWS Face Liveness)

Liveness checks that the selfie shows a real person in front of the camera, not a printed photo, a screen or a mask. Face matching alone cannot tell the difference, and the service never approves a case automatically without a passed liveness check ([README](../README.md)).

## Status

| Part | State |
| --- | --- |
| Server: create a session, hand the browser short-lived credentials, read the verdict, use the reference image for the face match | **Built and tested** with stand-ins for AWS (`src/liveness/aws-liveness.provider.ts`) |
| `pnpm check:liveness`: tries the AWS set-up (IAM, role, region) with no browser | **Built**, and passed against real AWS |
| Capture page: a face check step in place of the selfie, with "send a selfie instead" as a fallback | **Built and tested** in jsdom |
| The face check page (`/verify/liveness`) running the AWS widget | **Built**; the widget bundle builds in the tests, but it has **not yet run on a real camera**. Test it as below before enabling it for real people. |

## How it works

```
browser ── POST /v1/upload/<token>/liveness ──▶ verify-service ──CreateFaceLivenessSession──▶ AWS Rekognition (eu-west-1)
   ▲                                                  │  AssumeRole (policy: StartFaceLivenessSession only)  ──▶ AWS STS
   └── session id + 15-minute credentials ◀───────────┘
browser ══ video stream (WebRTC) ══▶ AWS Rekognition (eu-west-1)         the video never touches this service
pipeline ── GetFaceLivenessSessionResults ──▶ confidence + one reference image ──▶ face match against the ID front
```

- **The video goes from the browser straight to AWS in Ireland.** This service never receives it.
- **No long-lived key reaches a browser.** The credentials are short-lived (15 minutes), limited by a session policy to starting a liveness stream, and sent only to the browser that started that session. The reply is `Cache-Control: no-store`, and nothing logs it.
- **No audit images are requested and no S3 bucket is involved.** The reference image comes back in the reply and stays in memory only, used for the face match against the ID front (so the match is against the person who passed the challenge, not the uploaded selfie).
- **What the verdict means.** A finished session has a confidence score. A score below the tenant's minimum (default 90; `--liveness-threshold`) counts as *not live* and the case goes to review. A session that was not finished, expired or unknown counts as *incomplete*, never as live. Nothing is rejected automatically.
- **Cost.** AWS bills per check, whether it passes or fails ([pricing page](https://aws.amazon.com/rekognition/pricing/)). One link may start at most **5** challenges (`POST …/liveness` then answers `429` with `code: "liveness_attempts_exceeded"`), so a repeated or scripted start cannot create provider sessions without end; the browser credentials are issued before the session is created, so a refused request leaves nothing behind. `LIVENESS_CREDENTIAL_SECONDS` must be 900 to 3600 (an IAM role allows one hour unless its maximum session duration is raised).

## Region and data protection

Face Liveness is available in Europe only in **Ireland (`eu-west-1`)**, not Frankfurt. So the selfie *video* is processed in Ireland, while documents stay in Frankfurt. Both are in the EU/EEA, but it is a second region: record it in the DPIA ([dpia](dpia.md)) and tell users in the privacy notice shown on the capture page. Rekognition does not store the video after the check.

## AWS set-up (once)

1. **The browser role.** IAM → Roles → Create role → *Custom trust policy*, with this trust policy (replace the account id and the server user's name; the user is the one created in step 2):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "AWS": "arn:aws:iam::<account-id>:user/verify-service-liveness" },
       "Action": "sts:AssumeRole"
     }]
   }
   ```
   Give it this one permission (inline policy) and name the role `verify-liveness-browser`:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{ "Effect": "Allow", "Action": "rekognition:StartFaceLivenessSession", "Resource": "*" }]
   }
   ```
2. **The server's user.** IAM → Users → create `verify-service-liveness` (no console access), attach this inline policy, and create an access key for it:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["rekognition:CreateFaceLivenessSession", "rekognition:GetFaceLivenessSessionResults"], "Resource": "*" },
       { "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::<account-id>:role/verify-liveness-browser" }
     ]
   }
   ```
   A dedicated user keeps this separate from the face-match and storage users. (The face-match user can be given these permissions instead, in which case leave `LIVENESS_ACCESS_KEY_ID` unset and the default credentials are used.)
3. **Settings** (in `.env`, or the server's settings file; see `.env.example`):
   ```
   LIVENESS_PROVIDER=aws
   LIVENESS_REGION=eu-west-1
   LIVENESS_BROWSER_ROLE_ARN=arn:aws:iam::<account-id>:role/verify-liveness-browser
   LIVENESS_ACCESS_KEY_ID=<the new user's key id>
   LIVENESS_SECRET_ACCESS_KEY=<its secret>
   ```
4. **Try it** (calls AWS once, with no video and no face):
   ```sh
   pnpm check:liveness --send-to-aws
   ```
   Expected: "created a liveness session", "issued browser credentials" and "read the session back: incomplete". A failure names the missing permission; the usual causes are a wrong account id in the trust policy, or the server user lacking `sts:AssumeRole` on the role.

## The face check in the capture flow

- With `LIVENESS_PROVIDER=aws`, the capture page asks for the ID photos and then a **face check** instead of a selfie. "Start the face check" opens `/verify/liveness`, which runs the AWS widget and returns to the capture page when done. The token stays in the tab's `sessionStorage`. Only when the browser blocks storage does it travel to the face check page and back in the URL *fragment*, the same way it arrived in the link (browsers never send the fragment to a server). The outcome (`done`, `cancelled`, `selfie`) comes back in the query; it holds nothing secret, and a "done" only counts if the service has a challenge on record, whose verdict the pipeline reads itself.
- **Embedded in a tenant's page:** the iframe needs `allow="camera"` ([integration](integration.md)); without it the browser blocks the camera and the page offers the selfie.
- **Fallback:** "Cannot do the face check? Send a selfie instead" switches to the plain selfie upload (old browser, no camera permission, a widget error). Such a case cannot be approved automatically, because there is no liveness result, but it can be reviewed.
- **Server rules:** submitting needs the ID front and either a selfie or a started face check. The face match uses the image captured during the challenge; with neither image the case reports `SELFIE_MISSING` and goes to review.
- **Separate page, separate policy.** Only `/verify/liveness` is allowed WebAssembly (`'wasm-unsafe-eval'`, for the face detector), the camera stream (`blob:`, `mediastream:`), the detector's model from `https://cdn.liveness.rekognition.amazonaws.com`, and the WebSocket to `streaming-rekognition.<region>.amazonaws.com`. Still no inline script or style, no `eval`, no other origin. The capture page keeps its strict policy.
- **The widget bundle** (`liveness-widget/`, React and the AWS Amplify liveness component) is built by `pnpm build` into `liveness-dist/` and served at `/verify/liveness-widget.js` and `.css`. If it is not built, the face check page says it cannot start and offers the selfie. Its Albanian and Serbian texts cover the main instructions and were written by the developer: have them reviewed.

## Testing it on a real camera

The automated tests cannot open a camera. Do this once with your own face before enabling it for anyone else.

**On your laptop (simplest).** Browsers allow the camera on `localhost`:

```sh
pnpm build                       # builds the widget too
LIVENESS_PROVIDER=aws STORAGE_DRIVER=local STORAGE_KEY_PROVIDER=env FACE_PROVIDER=none PUBLIC_BASE_URL=http://localhost:4100 pnpm start:dev
```

(`LIVENESS_REGION`, `LIVENESS_BROWSER_ROLE_ARN` and the `LIVENESS_*` keys come from your `.env`. This **does** stream your face to AWS in Ireland for the check.) Create a session, open its `hostedUrl` in Chrome or Safari on the laptop, upload any ID photos, then do the face check. After submitting, `GET /v1/sessions/<id>` should show `liveness.status: "live"` with a confidence, and `face.source: "liveness"` once face matching is on.

**On a phone.** Phones only allow the camera on `https` pages, so `http://192.168…` will not work. A free temporary HTTPS address for your laptop: install Cloudflare's tunnel (`brew install cloudflared`), run `cloudflared tunnel --url http://localhost:4100`, and start the service with `PUBLIC_BASE_URL` set to the `https://….trycloudflare.com` address it prints and `TRUST_PROXY=1`. Use it only with your own data, and stop the tunnel afterwards.

**What to report back** if it fails: the screen you reached, and anything red in the browser's developer console that mentions "Content Security Policy" or "Refused to" (it names a blocked address or feature, no personal data). That is the most likely kind of problem on a first run.
