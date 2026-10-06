import { CreateFaceLivenessSessionCommand, GetFaceLivenessSessionResultsCommand } from '@aws-sdk/client-rekognition';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { ConfigService } from '@nestjs/config';
import { AwsLivenessProvider } from './aws-liveness.provider';
import { LivenessUnavailableError } from './liveness-provider';
import { createLivenessProvider } from './liveness.module';

const ROLE = 'arn:aws:iam::111122223333:role/verify-liveness-browser';
const err = (name: string) => Object.assign(new Error(name), { name });

/** Stand-ins for Rekognition and STS: no network, no credentials. */
function fakes(over: { create?: () => unknown; results?: () => unknown; assume?: () => unknown } = {}) {
  const sent: { cmd: string; input: Record<string, unknown> }[] = [];
  const rekognition = {
    send: async (cmd: unknown) => {
      if (cmd instanceof CreateFaceLivenessSessionCommand) {
        sent.push({ cmd: 'create', input: cmd.input as never });
        return over.create ? over.create() : { SessionId: 'live-session-1' };
      }
      if (cmd instanceof GetFaceLivenessSessionResultsCommand) {
        sent.push({ cmd: 'results', input: cmd.input as never });
        return over.results ? over.results() : { Status: 'SUCCEEDED', Confidence: 97.5, ReferenceImage: { Bytes: new Uint8Array([1, 2, 3]) } };
      }
      throw new Error('unexpected command');
    },
  };
  const sts = {
    send: async (cmd: unknown) => {
      if (cmd instanceof AssumeRoleCommand) {
        sent.push({ cmd: 'assume', input: cmd.input as never });
        return over.assume
          ? over.assume()
          : { Credentials: { AccessKeyId: 'ASIATEST', SecretAccessKey: 'secret', SessionToken: 'token', Expiration: new Date('2026-10-05T12:15:00Z') } };
      }
      throw new Error('unexpected command');
    },
  };
  const provider = new AwsLivenessProvider(rekognition as never, sts as never, { region: 'eu-west-1', browserRoleArn: ROLE });
  return { provider, sent };
}

describe('AwsLivenessProvider.createSession', () => {
  it('creates a session without audit images and hands the browser short-lived credentials for one action', async () => {
    const { provider, sent } = fakes();
    const s = await provider.createSession();
    expect(s.providerSessionId).toBe('live-session-1');
    expect(s.clientConfig).toMatchObject({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'ASIATEST', secretAccessKey: 'secret', sessionToken: 'token', expiration: '2026-10-05T12:15:00.000Z' },
    });
    const create = sent.find((c) => c.cmd === 'create')!.input as { Settings: { AuditImagesLimit: number }; ClientRequestToken: string };
    expect(create.Settings.AuditImagesLimit).toBe(0); // no extra images kept at AWS
    expect(create.ClientRequestToken).toMatch(/^[0-9a-f-]{36}$/);
    const assume = sent.find((c) => c.cmd === 'assume')!.input as { RoleArn: string; RoleSessionName: string; DurationSeconds: number; Policy: string };
    expect(assume.RoleArn).toBe(ROLE);
    expect(assume.RoleSessionName).toMatch(/^liveness-[0-9a-f-]{36}$/); // random, nothing about the person
    expect(assume.DurationSeconds).toBe(900);
    // credentials first, then the session: a refusal from STS leaves no session behind
    expect(sent.map((c) => c.cmd)).toEqual(['assume', 'create']);
    // the session policy allows exactly one action
    expect(JSON.parse(assume.Policy).Statement).toEqual([{ Effect: 'Allow', Action: 'rekognition:StartFaceLivenessSession', Resource: '*' }]);
  });

  it('uses a fresh request token for every session', async () => {
    const a = fakes();
    const b = fakes();
    await a.provider.createSession();
    await b.provider.createSession();
    const tokenOf = (f: ReturnType<typeof fakes>) => (f.sent.find((c) => c.cmd === 'create')!.input as { ClientRequestToken: string }).ClientRequestToken;
    expect(tokenOf(a)).not.toBe(tokenOf(b));
  });

  it('creates no Rekognition session when the browser credentials are refused', async () => {
    const { provider, sent } = fakes({ assume: () => { throw err('AccessDenied'); } });
    await expect(provider.createSession()).rejects.toBeInstanceOf(LivenessUnavailableError);
    expect(sent.map((c) => c.cmd)).toEqual(['assume']);
  });

  it('accepts a credential lifetime only within what a role allows by default', () => {
    const make = (credentialSeconds: number) => new AwsLivenessProvider({} as never, {} as never, { region: 'eu-west-1', browserRoleArn: ROLE, credentialSeconds });
    expect(() => make(900)).not.toThrow();
    expect(() => make(3600)).not.toThrow();
    for (const bad of [0, 899, 3601, 43_200, NaN]) expect(() => make(bad)).toThrow('LIVENESS_CREDENTIAL_SECONDS');
  });

  it.each(['AccessDeniedException', 'UnrecognizedClientException', 'ExpiredTokenException', 'CredentialsProviderError'])('reports %s as "unavailable" (retrying will not help)', async (name) => {
    await expect(fakes({ create: () => { throw err(name); } }).provider.createSession()).rejects.toBeInstanceOf(LivenessUnavailableError);
    await expect(fakes({ assume: () => { throw err(name); } }).provider.createSession()).rejects.toBeInstanceOf(LivenessUnavailableError);
  });

  it('lets transient errors through so the caller can retry', async () => {
    await expect(fakes({ create: () => { throw err('ThrottlingException'); } }).provider.createSession()).rejects.toMatchObject({ name: 'ThrottlingException' });
  });

  it('refuses a reply without a session id or credentials', async () => {
    await expect(fakes({ create: () => ({}) }).provider.createSession()).rejects.toBeInstanceOf(LivenessUnavailableError);
    await expect(fakes({ assume: () => ({ Credentials: { AccessKeyId: 'x' } }) }).provider.createSession()).rejects.toBeInstanceOf(LivenessUnavailableError);
  });

  it('rejects a role that is not an IAM role ARN', () => {
    for (const bad of ['', 'role/x', 'arn:aws:s3:::bucket', 'arn:aws:iam::123:role/x']) {
      expect(() => new AwsLivenessProvider({} as never, {} as never, { region: 'eu-west-1', browserRoleArn: bad })).toThrow('LIVENESS_BROWSER_ROLE_ARN');
    }
  });
});

describe('AwsLivenessProvider.getResult', () => {
  it('reports a finished challenge as live with its score, and hands over the reference image', async () => {
    const { provider, sent } = fakes();
    const r = await provider.getResult('live-session-1');
    expect(r).toMatchObject({ status: 'live', confidence: 97.5 });
    expect(r.referenceImage).toEqual(Buffer.from([1, 2, 3]));
    expect(sent.find((c) => c.cmd === 'results')!.input).toEqual({ SessionId: 'live-session-1' });
  });

  it('does not call a low score "not live" itself: the tenant minimum decides later', async () => {
    const r = await fakes({ results: () => ({ Status: 'SUCCEEDED', Confidence: 12 }) }).provider.getResult('s');
    expect(r).toMatchObject({ status: 'live', confidence: 12 });
    expect(r.referenceImage).toBeUndefined();
  });

  it.each(['CREATED', 'IN_PROGRESS', 'FAILED', 'EXPIRED', undefined])('treats status %s as incomplete, never as live', async (Status) => {
    const r = await fakes({ results: () => ({ Status, Confidence: 99 }) }).provider.getResult('s');
    expect(r).toEqual({ status: 'incomplete', confidence: null });
  });

  it('a succeeded session with no score is incomplete, not live', async () => {
    expect(await fakes({ results: () => ({ Status: 'SUCCEEDED' }) }).provider.getResult('s')).toEqual({ status: 'incomplete', confidence: null });
  });

  it('an unknown or expired session id is incomplete', async () => {
    for (const name of ['SessionNotFoundException', 'ValidationException']) {
      expect(await fakes({ results: () => { throw err(name); } }).provider.getResult('s')).toEqual({ status: 'incomplete', confidence: null });
    }
  });

  it('refused credentials are unavailable; transient errors are retried', async () => {
    await expect(fakes({ results: () => { throw err('AccessDeniedException'); } }).provider.getResult('s')).rejects.toBeInstanceOf(LivenessUnavailableError);
    await expect(fakes({ results: () => { throw err('InternalServerError'); } }).provider.getResult('s')).rejects.toMatchObject({ name: 'InternalServerError' });
  });
});

describe('LIVENESS_PROVIDER configuration', () => {
  const build = async (values: Record<string, string>) => createLivenessProvider({ get: (k: string) => values[k] } as unknown as ConfigService);

  it('is off by default and when "none"', async () => {
    expect((await build({})).name).toBe('none');
    expect((await build({ LIVENESS_PROVIDER: 'none' })).name).toBe('none');
  });

  it('starts the AWS provider with a role, defaulting to Ireland', async () => {
    expect((await build({ LIVENESS_PROVIDER: 'aws', LIVENESS_BROWSER_ROLE_ARN: ROLE })).name).toBe('aws');
  });

  it('fails at start, with a clear message, when the AWS settings are incomplete or wrong', async () => {
    await expect(build({ LIVENESS_PROVIDER: 'aws' })).rejects.toThrow('LIVENESS_BROWSER_ROLE_ARN');
    await expect(build({ LIVENESS_PROVIDER: 'aws', LIVENESS_BROWSER_ROLE_ARN: 'nope' })).rejects.toThrow('LIVENESS_BROWSER_ROLE_ARN');
    await expect(build({ LIVENESS_PROVIDER: 'aws', LIVENESS_BROWSER_ROLE_ARN: ROLE, LIVENESS_ACCESS_KEY_ID: 'AKIA' })).rejects.toThrow('both');
    await expect(build({ LIVENESS_PROVIDER: 'nonsense' })).rejects.toThrow('Unknown LIVENESS_PROVIDER');
    await expect(build({ LIVENESS_PROVIDER: 'aws', LIVENESS_BROWSER_ROLE_ARN: ROLE, LIVENESS_CREDENTIAL_SECONDS: '7200' })).rejects.toThrow('LIVENESS_CREDENTIAL_SECONDS');
    await expect(build({ LIVENESS_PROVIDER: 'aws', LIVENESS_BROWSER_ROLE_ARN: ROLE, LIVENESS_CREDENTIAL_SECONDS: 'ten' })).rejects.toThrow('LIVENESS_CREDENTIAL_SECONDS');
    expect((await build({ LIVENESS_PROVIDER: 'aws', LIVENESS_BROWSER_ROLE_ARN: ROLE, LIVENESS_CREDENTIAL_SECONDS: '1800' })).name).toBe('aws');
  });
});
