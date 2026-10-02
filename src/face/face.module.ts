import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FACE_PROVIDER, FaceProvider, FaceUnavailableError } from './face-provider';
import { RekognitionProvider } from './rekognition.provider';

const disabled: FaceProvider = {
  name: 'none',
  compare: async () => {
    throw new FaceUnavailableError('face matching is not configured');
  },
};

@Module({
  providers: [
    {
      provide: FACE_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): FaceProvider => {
        // Off unless explicitly enabled: images are only sent to a third party by opt-in.
        const name = config.get<string>('FACE_PROVIDER') ?? 'none';
        if (name === 'none') return disabled;
        if (name === 'rekognition') {
          const region = config.get<string>('AWS_REGION');
          if (!region) throw new Error('AWS_REGION is required when FACE_PROVIDER=rekognition');
          return RekognitionProvider.forRegion(region);
        }
        throw new Error(`Unknown FACE_PROVIDER "${name}"`);
      },
    },
  ],
  exports: [FACE_PROVIDER],
})
export class FaceModule {}
