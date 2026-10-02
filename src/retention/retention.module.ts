import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { EvidenceService } from './evidence.service';
import { PurgeService } from './purge.service';
import { RetentionScheduler } from './retention.scheduler';
import { RetentionService } from './retention.service';

@Module({
  imports: [StorageModule],
  providers: [PurgeService, RetentionService, RetentionScheduler, EvidenceService],
  exports: [PurgeService, RetentionService, EvidenceService],
})
export class RetentionModule {}
