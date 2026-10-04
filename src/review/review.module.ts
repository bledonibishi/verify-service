import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ReviewAuthService } from './auth.service';
import { ReviewAuthGuard } from './review-auth.guard';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';
import { TwoFactorService } from './two-factor.service';
import { ReviewUiController } from './ui.controller';

@Module({
  imports: [StorageModule, WebhooksModule],
  controllers: [ReviewController, ReviewUiController],
  providers: [ReviewAuthService, ReviewAuthGuard, ReviewService, TwoFactorService],
})
export class ReviewModule {}
