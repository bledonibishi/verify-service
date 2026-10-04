-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "monthly_verification_cap" INTEGER,
ADD COLUMN     "soft_limit_notified_month" TEXT,
ADD COLUMN     "soft_limit_percent" INTEGER NOT NULL DEFAULT 80;

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'verification',
    "session_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "non_billable_reason" TEXT,
    "face" BOOLEAN NOT NULL DEFAULT false,
    "liveness" BOOLEAN NOT NULL DEFAULT false,
    "licence" BOOLEAN NOT NULL DEFAULT false,
    "auto_decided" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_events_tenant_id_occurred_at_idx" ON "usage_events"("tenant_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "usage_events_session_id_kind_key" ON "usage_events"("session_id", "kind");

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
