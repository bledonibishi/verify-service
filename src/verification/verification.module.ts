import { Module } from '@nestjs/common';
import { OcrModule } from '../ocr/ocr.module';
import { StorageModule } from '../storage/storage.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { VerificationWorker } from './verification.worker';

@Module({
  imports: [OcrModule, StorageModule, WebhooksModule],
  providers: [VerificationWorker],
  exports: [VerificationWorker],
})
export class VerificationModule {}
