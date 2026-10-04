import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { SessionsController } from './sessions/sessions.controller';
import { SessionsService } from './sessions/sessions.service';
import { ApiKeyGuard } from './tenants/api-key.guard';
import { StorageModule } from './storage/storage.module';
import { UploadCorsMiddleware } from './uploads/upload-cors.middleware';
import { UploadsController } from './uploads/uploads.controller';
import { UploadsService } from './uploads/uploads.service';
import { RetentionModule } from './retention/retention.module';
import { ReviewModule } from './review/review.module';
import { HostedController } from './hosted/hosted.controller';
import { LivenessModule } from './liveness/liveness.module';
import { VerificationModule } from './verification/verification.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    // Under jest the app never reads a developer's .env (it holds real credentials); tests set what they need.
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: process.env.NODE_ENV === 'test' }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.THROTTLE_LIMIT) || 60 }]),
    PrismaModule,
    StorageModule,
    WebhooksModule,
    VerificationModule,
    LivenessModule,
    ReviewModule,
    RetentionModule,
  ],
  controllers: [SessionsController, UploadsController, HostedController],
  providers: [
    SessionsService,
    UploadsService,
    ApiKeyGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(UploadCorsMiddleware).forRoutes('v1/upload');
  }
}
