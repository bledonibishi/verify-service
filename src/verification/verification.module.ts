import { Module } from '@nestjs/common';
import { FaceModule } from '../face/face.module';
import { OcrModule } from '../ocr/ocr.module';
import { StorageModule } from '../storage/storage.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { VerificationWorker } from './verification.worker';

@Module({
  imports: [OcrModule, FaceModule, StorageModule, WebhooksModule],
  providers: [VerificationWorker],
  exports: [VerificationWorker],
})
export class VerificationModule {}
