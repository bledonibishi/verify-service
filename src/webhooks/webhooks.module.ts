import { Module } from '@nestjs/common';
import { WebhookDispatcher } from './dispatcher';
import { OutboxService } from './outbox.service';
import { WebhookEventsController } from './webhook-events.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  controllers: [WebhookEventsController],
  providers: [WebhooksService, OutboxService, WebhookDispatcher],
  exports: [OutboxService, WebhookDispatcher],
})
export class WebhooksModule {}
