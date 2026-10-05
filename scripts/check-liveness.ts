/**
 * One-off check of the AWS Face Liveness set-up (IAM, region, role), before any browser is involved:
 *
 *   pnpm check:liveness --send-to-aws
 *
 * Asks AWS (in LIVENESS_REGION, default eu-west-1) to create one liveness session and to issue the
 * short-lived browser credentials for it, then reads the session back (it will say "incomplete":
 * nobody took the challenge). No video, no face, no personal data is involved. It does call AWS, so
 * it refuses to run without --send-to-aws; the automated tests never contact AWS.
 *
 * Prints only what worked or failed and when the credentials would expire; never a key or token.
 */
import { existsSync } from 'fs';
import { createLivenessProvider } from '../src/liveness/liveness.module';
import { LivenessUnavailableError } from '../src/liveness/liveness-provider';

if (existsSync('.env')) {
  if (typeof process.loadEnvFile !== 'function') {
    console.error('This check needs Node 20.12 or newer to read .env');
    process.exit(1);
  }
  process.loadEnvFile('.env');
}

async function main() {
  const get = (k: string) => process.env[k];
  if (!process.argv.includes('--send-to-aws')) {
    console.log(`Not run: this calls AWS Rekognition and STS in ${get('LIVENESS_REGION') || 'eu-west-1'}. Add --send-to-aws to confirm.`);
    process.exit(2);
  }
  if (get('LIVENESS_PROVIDER') !== 'aws') {
    console.log('Not run: LIVENESS_PROVIDER is not "aws" in .env (see docs/liveness.md)');
    process.exit(2);
  }
  let provider;
  try {
    provider = createLivenessProvider({ get } as never);
  } catch (err) {
    console.log(`FAIL  configuration: ${(err as Error).message}`);
    process.exit(1);
  }
  try {
    const s = await provider.createSession();
    const creds = (s.clientConfig as { credentials?: { expiration?: string } } | undefined)?.credentials;
    console.log(`  ok    created a liveness session in ${(s.clientConfig as { region?: string } | undefined)?.region}`);
    console.log(`  ok    issued browser credentials${creds?.expiration ? ` (valid until ${creds.expiration})` : ''}`);
    const r = await provider.getResult(s.providerSessionId);
    console.log(`  ok    read the session back: ${r.status} (expected "incomplete": nobody took the challenge)`);
    console.log('All checks passed.');
  } catch (err) {
    if (err instanceof LivenessUnavailableError) {
      console.log(`  FAIL  ${err.message}. Check the IAM permissions and the role's trust policy in docs/liveness.md`);
    } else {
      console.log(`  FAIL  ${(err as Error).name}`);
    }
    process.exit(1);
  }
}

main();
