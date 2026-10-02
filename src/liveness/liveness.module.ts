import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

@Module({
  providers: [
    {
      provide: LIVENESS_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): LivenessProvider => {
        // No real provider yet: the AWS Face Liveness adapter arrives with the browser widget.
        const name = config.get<string>('LIVENESS_PROVIDER') ?? 'none';
        if (name === 'none') return disabled;
        throw new Error(`Unknown LIVENESS_PROVIDER "${name}"`);
      },
    },
  ],
  exports: [LIVENESS_PROVIDER],
})
export class LivenessModule {}
