import { Module } from '@nestjs/common';
import { FaceModule } from '../face/face.module';
import { LivenessModule } from '../liveness/liveness.module';
import { OcrModule } from '../ocr/ocr.module';
import { StorageModule } from '../storage/storage.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { VerificationWorker } from './verification.worker';

@Module({
  imports: [OcrModule, FaceModule, LivenessModule, StorageModule, WebhooksModule],
  providers: [VerificationWorker],
  exports: [VerificationWorker],
})
export class VerificationModule {}
