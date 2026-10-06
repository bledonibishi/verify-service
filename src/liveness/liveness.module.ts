import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AwsLivenessProvider } from './aws-liveness.provider';
import { LIVENESS_PROVIDER, LivenessProvider, LivenessUnavailableError } from './liveness-provider';

const disabled: LivenessProvider = {
  name: 'none',
  createSession: async () => {
    throw new LivenessUnavailableError('liveness is not configured');
  },
  getResult: async () => {
    throw new LivenessUnavailableError('liveness is not configured');
  },
};

export function createLivenessProvider(config: ConfigService): LivenessProvider {
  // Off unless explicitly enabled: video is only sent to a third party by opt-in.
  const name = config.get<string>('LIVENESS_PROVIDER') ?? 'none';
  if (name === 'none') return disabled;
  if (name === 'aws') {
    // Face Liveness exists in Ireland, not Frankfurt: a different region from the rest of the data, on purpose
    const region = config.get<string>('LIVENESS_REGION') || 'eu-west-1';
    const roleArn = config.get<string>('LIVENESS_BROWSER_ROLE_ARN');
    if (!roleArn) throw new Error('LIVENESS_BROWSER_ROLE_ARN is required when LIVENESS_PROVIDER=aws');
    const id = config.get<string>('LIVENESS_ACCESS_KEY_ID');
    const secret = config.get<string>('LIVENESS_SECRET_ACCESS_KEY');
    if (!!id !== !!secret) throw new Error('Set both LIVENESS_ACCESS_KEY_ID and LIVENESS_SECRET_ACCESS_KEY, or neither');
    const rawSeconds = config.get<string>('LIVENESS_CREDENTIAL_SECONDS');
    const seconds = rawSeconds ? Number(rawSeconds) : NaN;
    if (rawSeconds && !Number.isInteger(seconds)) throw new Error('LIVENESS_CREDENTIAL_SECONDS must be a whole number of seconds (900 to 3600)');
    return AwsLivenessProvider.forRegion(region, roleArn, id && secret ? { accessKeyId: id, secretAccessKey: secret } : undefined, Number.isFinite(seconds) ? seconds : undefined);
  }
  throw new Error(`Unknown LIVENESS_PROVIDER "${name}"`);
}

@Module({
  providers: [
    {
      provide: LIVENESS_PROVIDER,
      inject: [ConfigService],
      useFactory: createLivenessProvider,
    },
  ],
  exports: [LIVENESS_PROVIDER],
})
export class LivenessModule {}
