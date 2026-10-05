/**
 * One-off check of the real face match, with your own photos:
 *
 *   pnpm check:face fixtures/private/my-id-front.jpg fixtures/private/my-selfie.jpg --send-to-aws
 *
 * Sends BOTH images to AWS Rekognition (CompareFaces) in AWS_REGION, using your .env credentials,
 * so it refuses to run without --send-to-aws. Rekognition does not store the images. Only use
 * photos of yourself or of someone who agreed. The automated tests never contact AWS.
 *
 * Prints only the outcome and the similarity score (0-100), never paths' contents or anything read
 * from the images, so the output is safe to paste into a chat or issue.
 */
import { existsSync, readFileSync } from 'fs';
import { RekognitionProvider } from '../src/face/rekognition.provider';
import { FaceUnavailableError } from '../src/face/face-provider';
import { faceOutcome } from '../src/verification/decision';

if (existsSync('.env')) {
  if (typeof process.loadEnvFile !== 'function') {
    console.error('This check needs Node 20.12 or newer to read .env');
    process.exit(1);
  }
  process.loadEnvFile('.env');
}

async function main() {
  const [idPath, selfiePath, ...flags] = process.argv.slice(2);
  if (!idPath || !selfiePath) {
    console.log('usage: pnpm check:face <id-front-image> <selfie-image> --send-to-aws [--threshold=90]');
    process.exit(2);
  }
  const region = process.env.AWS_REGION;
  if (!flags.includes('--send-to-aws')) {
    console.log(`Not run: this sends both images to AWS Rekognition${region ? ` in ${region}` : ''}. Add --send-to-aws to confirm.`);
    process.exit(2);
  }
  if (!region) {
    console.log('AWS_REGION is not set (expected eu-central-1)');
    process.exit(2);
  }
  const threshold = Number(flags.find((f) => f.startsWith('--threshold='))?.split('=')[1] ?? 90);
  const provider = RekognitionProvider.forRegion(region);
  try {
    const result = await provider.compare(readFileSync(idPath), readFileSync(selfiePath));
    const outcome = faceOutcome(result, threshold);
    console.log(`region: ${region}`);
    console.log(`result: ${outcome.status}${outcome.similarity !== null ? ` (similarity ${outcome.similarity.toFixed(1)}, threshold ${threshold})` : ''}`);
    process.exit(outcome.status === 'match' ? 0 : 1);
  } catch (err) {
    // Fixed text and the error's name only: a provider message could echo request details
    if (err instanceof FaceUnavailableError) console.log('FAIL: AWS rejected the credentials or the IAM user may not be allowed rekognition:CompareFaces');
    else console.log(`FAIL: ${(err as Error).name}`);
    process.exit(2);
  }
}

main();
