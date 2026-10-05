import {
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { randomUUID } from 'crypto';
import { LivenessProvider, LivenessResult, LivenessSession, LivenessUnavailableError } from './liveness-provider';

type Rekognition = Pick<RekognitionClient, 'send'>;
type Sts = Pick<STSClient, 'send'>;

export interface AwsLivenessOptions {
  /** The only European region that offers Face Liveness (Frankfurt does not). */
  region: string;
  /** A role whose only permission is `rekognition:StartFaceLivenessSession`; the browser gets short-lived credentials for it. */
  browserRoleArn: string;
  /** How long the browser's credentials live, in seconds (AWS minimum 900). */
  credentialSeconds?: number;
}

/** What the browser may do with its temporary credentials, and nothing else: run one liveness stream. */
const BROWSER_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 'rekognition:StartFaceLivenessSession', Resource: '*' }],
});

const UNAVAILABLE = new Set([
  'CredentialsProviderError',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'AccessDeniedException',
  'AccessDenied',
  'ExpiredTokenException',
  'InvalidClientTokenId',
  'MalformedPolicyDocument',
  'RegionDisabledException',
]);
/** The user's challenge never completed in a form we can read: not evidence of a spoof. */
const NOT_COMPLETED = new Set(['SessionNotFoundException', 'ValidationException', 'InvalidParameterException']);

/**
 * AWS Rekognition Face Liveness. The server creates the session and later reads the verdict; the
 * browser widget streams the video to AWS directly with short-lived credentials from `createSession`
 * (STS AssumeRole with a session policy that allows exactly one action), so the video never touches
 * this service and no long-lived key reaches a browser. No audit images are requested and nothing
 * is written to an S3 bucket; the reference image comes back in the reply and is only held in memory.
 */
export class AwsLivenessProvider implements LivenessProvider {
  readonly name = 'aws';

  constructor(
    private readonly rekognition: Rekognition,
    private readonly sts: Sts,
    private readonly opts: AwsLivenessOptions,
  ) {
    if (!opts.region) throw new Error('LIVENESS_REGION is required when LIVENESS_PROVIDER=aws');
    if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/.+/.test(opts.browserRoleArn ?? '')) {
      throw new Error('LIVENESS_BROWSER_ROLE_ARN must be the ARN of an IAM role (arn:aws:iam::<account>:role/<name>)');
    }
  }

  static forRegion(region: string, browserRoleArn: string, credentials?: { accessKeyId: string; secretAccessKey: string }, credentialSeconds?: number) {
    const config = { region, ...(credentials ? { credentials } : {}) };
    return new AwsLivenessProvider(new RekognitionClient(config), new STSClient(config), { region, browserRoleArn, credentialSeconds });
  }

  private unavailable(err: unknown): never {
    const name = (err as Error).name;
    if (UNAVAILABLE.has(name)) throw new LivenessUnavailableError(`liveness provider refused the request (${name})`);
    throw err; // throttling, network, 5xx: let the job retry
  }

  async createSession(): Promise<LivenessSession> {
    let sessionId: string;
    try {
      const created = await this.rekognition.send(
        new CreateFaceLivenessSessionCommand({ ClientRequestToken: randomUUID(), Settings: { AuditImagesLimit: 0 } }),
      );
      if (!created.SessionId) throw new LivenessUnavailableError('liveness provider returned no session');
      sessionId = created.SessionId;
    } catch (err) {
      if (err instanceof LivenessUnavailableError) throw err;
      return this.unavailable(err);
    }

    try {
      const assumed = await this.sts.send(
        new AssumeRoleCommand({
          RoleArn: this.opts.browserRoleArn,
          // Shows up in CloudTrail; the provider's session id is a random UUID, not personal data
          RoleSessionName: `liveness-${sessionId}`.replace(/[^\w+=,.@-]/g, '-').slice(0, 64),
          DurationSeconds: Math.max(900, this.opts.credentialSeconds ?? 900),
          Policy: BROWSER_POLICY,
        }),
      );
      const c = assumed.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new LivenessUnavailableError('liveness provider returned no credentials');
      return {
        providerSessionId: sessionId,
        clientConfig: {
          region: this.opts.region,
          // Short-lived and limited to starting a liveness stream. Sent to this one browser only, never logged or stored.
          credentials: {
            accessKeyId: c.AccessKeyId,
            secretAccessKey: c.SecretAccessKey,
            sessionToken: c.SessionToken,
            expiration: c.Expiration?.toISOString(),
          },
        },
      };
    } catch (err) {
      if (err instanceof LivenessUnavailableError) throw err;
      return this.unavailable(err);
    }
  }

  async getResult(providerSessionId: string): Promise<LivenessResult> {
    try {
      const r = await this.rekognition.send(new GetFaceLivenessSessionResultsCommand({ SessionId: providerSessionId }));
      if (r.Status !== 'SUCCEEDED') return { status: 'incomplete', confidence: null };
      const confidence = typeof r.Confidence === 'number' ? r.Confidence : null;
      // SUCCEEDED means the challenge ran to the end; whether the face was live is the confidence, which the
      // tenant's minimum is applied to later. A missing score is "incomplete", never "live".
      if (confidence === null) return { status: 'incomplete', confidence: null };
      const image = r.ReferenceImage?.Bytes;
      return { status: 'live', confidence, ...(image && image.length > 0 ? { referenceImage: Buffer.from(image) } : {}) };
    } catch (err) {
      if (NOT_COMPLETED.has((err as Error).name)) return { status: 'incomplete', confidence: null };
      return this.unavailable(err);
    }
  }
}
