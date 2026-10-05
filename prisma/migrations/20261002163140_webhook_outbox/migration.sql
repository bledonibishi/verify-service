-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMP(3),
    "last_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_events_status_next_attempt_at_idx" ON "webhook_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_events_tenant_id_created_at_idx" ON "webhook_events"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
