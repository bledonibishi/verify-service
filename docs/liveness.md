# Liveness (AWS Face Liveness)

Liveness checks that the selfie shows a real person in front of the camera, not a printed photo, a screen or a mask. Face matching alone cannot tell the difference, and the service never approves a case automatically without a passed liveness check ([README](../README.md)).

## Status

| Part | State |
| --- | --- |
| Server: create a session, hand the browser short-lived credentials, read the verdict, use the reference image for the face match | **Built and tested** with stand-ins for AWS (`src/liveness/aws-liveness.provider.ts`) |
| `pnpm check:liveness`: tries the AWS set-up (IAM, role, region) with no browser | **Built**; run it yourself once the role exists |
| The browser widget on the capture page (the challenge itself) | **Not built yet** (next step; see "What is missing") |

Until the widget exists, setting `LIVENESS_PROVIDER=aws` would create sessions nobody can complete, so leave it `none` in production.

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
- **Cost.** AWS bills per check, whether it passes or fails ([pricing page](https://aws.amazon.com/rekognition/pricing/)).

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

## What is missing: the browser widget

AWS only offers the challenge as a widget (`FaceLivenessDetector`, part of Amplify UI, a React component) that streams the camera to Rekognition. The hosted page is plain JavaScript with a strict content security policy, so the widget has to be added as a separate bundle (React and the Amplify packages built into one script served from this origin) and the page's policy has to allow, for that step only, connections to `rekognition.eu-west-1.amazonaws.com` and `wss://streaming-rekognition.eu-west-1.amazonaws.com`, plus the WebAssembly and worker features the widget's face detector needs. It also needs testing on real phones and browsers, which cannot be done from the automated tests. This is the next piece of work.
