# Testing verify-service safely on your own computer

For the owner. Follow this whenever you run the service to try it out, with fake data or with your own real documents. Everything here runs on your machine; nothing reaches AWS or the internet unless a step says so.

## The rules (read once)

1. **Real documents are only ever yours, or someone's who agreed.** Never a customer's or patient's.
2. **Real photos live in `fixtures/private/`** (git-ignored, so they cannot be committed). Never copy them anywhere else, never paste them or text read from them into a chat, an issue or a pull request. To share output, use the pass/fail and "shape" commands below.
3. **Never edit `.env` for testing.** Override settings on the command line (step 2 below) so your real AWS keys are not used by accident. `.env` here points at real S3, KMS and Rekognition: a normal start would upload your photos to your real bucket.
4. **Plain `http` is only for `localhost` or your home network,** and only with fake or your own data. Real customers need HTTPS.
5. **Clean up afterwards** (last section).

## 1. One-time setup

```sh
git checkout dev && git pull
pnpm install
docker compose up -d db          # Postgres on localhost:5434
pnpm prisma migrate deploy
brew install tesseract           # reads the ID text (macOS); apt install tesseract-ocr on Linux
```

## 2. Start the service in local-only mode

```sh
STORAGE_DRIVER=local STORAGE_KEY_PROVIDER=env FACE_PROVIDER=none LIVENESS_PROVIDER=none pnpm start:dev
```

What each setting does: photos go to the `./storage` folder (encrypted), the local key is used instead of KMS, and face matching and liveness are off so no photo is sent to Rekognition. The service is at `http://localhost:4100`. Leave this terminal running.

Using a different terminal for everything below.

## 3. Create a throwaway tenant and reviewer

```sh
pnpm tenant:create "local-test" http://localhost:9/none
```

This prints the **API key** (shown once; keep it in your terminal only) and a webhook secret. The webhook address is a dead local port on purpose, so nothing is sent anywhere. Note the tenant id on the first line.

```sh
pnpm reviewer create <tenantId> you@example.com "Your Name"
```

This prints a one-time password for the review screen. Use one you do not use anywhere else.

## 4. Test with FAKE data

You do not need a real card to see the whole flow.

**a) The reader, with a fictional card.** The tests use a made-up person. Feed its text to the checker:

```sh
printf 'IDRKSID00000016<<<<<<<<<<<<<<<\n9005156F2901318RKS1000000001<6\nTESTI<<DEMA<<<<<<<<<<<<<<<<<<<\n' | pnpm check:mrz
```

You should see the structure and all check digits pass. Change one digit and run it again to see it fail.

**b) The full flow with any pictures.** Use any photos for ID front, ID back and selfie (stock images, a drawing). The ID back will not contain a readable MRZ, so the case lands in review with `MRZ_NOT_FOUND`. That is a valid test of the review path.

```sh
curl -s -X POST localhost:4100/v1/sessions -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"externalRef":"demo-1","firstName":"Test","lastName":"Person","birthDate":"1990-05-15"}'
```

Open the `hostedUrl` from the reply in your browser, upload the three photos and submit. Then open `http://localhost:4100/review`, sign in, and open the case. Approve one case and reject another (a reason is required). `GET /v1/sessions/<id>` with the API key shows the final status.

## 5. Test with YOUR OWN real card

1. Put the photos in `fixtures/private/` only (for example `my-id-back.jpg`).
2. Check how well the card reads, without printing anything personal:
   ```sh
   pnpm check:photo fixtures/private/my-id-back.jpg --shape
   ```
   It prints pass/fail per check digit and, on failure, the text with digits as 9 and letters as A. That output is safe to share. `--variants` adds the shape of each cleaned-up reading.
3. Run the full flow as in 4b, but upload your real photos on the capture page, with `firstName`, `lastName` and `birthDate` set to what is on your card. The review screen should then show "match" for surname, given names and date of birth.
4. Face match is off in this mode. To try the real face match once, with two photos of yourself, and only if the IAM user has `rekognition:CompareFaces`:
   ```sh
   pnpm check:face fixtures/private/my-id-front.jpg fixtures/private/my-selfie.jpg --send-to-aws
   ```
   This **does** send both images to AWS Rekognition in `eu-central-1` (it refuses to run without the flag). It prints only the outcome and a similarity score.

## 6. Testing from a phone or the pharmacy software on your network (http)

Fake or your own data only, and only on your home or office network.

1. Find your computer's local address (System Settings → Network), for example `192.168.1.20`.
2. Start the service as in step 2, with the public address set so the links are right:
   ```sh
   PUBLIC_BASE_URL=http://192.168.1.20:4100 STORAGE_DRIVER=local STORAGE_KEY_PROVIDER=env FACE_PROVIDER=none LIVENESS_PROVIDER=none pnpm start:dev
   ```
3. On the phone (same Wi-Fi), open the `hostedUrl` from a new session. The phone camera works through the file picker over http; a live camera preview does not (browsers require HTTPS for that), and nothing needs it yet.
4. The reviewer password and cookie travel unencrypted on http, so use a throwaway password.

## 7. See what the pharmacy software would receive

The webhook is signed and sent to the tenant's webhook address. For a real receiver, create the tenant with its local address (for example `http://localhost:3000/webhooks/verify`) or change it later:

```sh
pnpm tenant:update <tenantId> --webhook-url=http://localhost:3000/webhooks/verify
pnpm tenant:update <tenantId> --webhook-url=none      # stop sending webhooks
```

Failed deliveries are retried for about a day. To see them: `GET /v1/webhook-events?status=FAILED` with the API key.

## 8. Rotate or revoke the test key

```sh
pnpm tenant:rotate-key <tenantId>                  # new key, old one stops at once
pnpm tenant:rotate-key <tenantId> --grace-hours=24 # old one works another 24 h
```

## 9. Clean up afterwards

```sh
# stop the service: Ctrl-C in its terminal
rm -rf ./storage                  # the encrypted photos from the run
docker compose down -v            # optional: empties the local database too
```

Your originals in `fixtures/private/` stay; delete them yourself when you no longer need them. Check that nothing personal is staged before any commit: `git status` must not list `fixtures/` or `storage/`.

## If something goes wrong

| What you see | What it means |
| --- | --- |
| `MRZ: not found` / `MRZ not read` | The photo is too blurry, dark or cropped. Retake it flat, well lit, with the bottom three lines fully in the picture. |
| `FACE_UNAVAILABLE` on a case | Expected in local mode (face matching is off). |
| `401` from the API | Wrong or rotated API key. |
| Case stays `PROCESSING` | The worker needs a few seconds, or `tesseract` is missing (`tesseract --version`). |
| The service cannot reach the database | `docker compose up -d db`, then `pnpm prisma migrate deploy`. |
| `FAIL: AWS rejected the credentials` (check:face) | The IAM user lacks `rekognition:CompareFaces`, or the keys in `.env` are not the ones you think. |
