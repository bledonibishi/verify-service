-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "sha256" TEXT;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "decided_at" TIMESTAMP(3),
ADD COLUMN     "documents_deleted_at" TIMESTAMP(3),
ADD COLUMN     "documents_manifest" JSONB;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "document_retention_days" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "evidence_export" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "record_retention_days" INTEGER NOT NULL DEFAULT 1825;

-- CreateTable
CREATE TABLE "deletion_records" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "document_count" INTEGER NOT NULL,
    "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deletion_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deletion_records_tenant_id_deleted_at_idx" ON "deletion_records"("tenant_id", "deleted_at");

-- Sessions decided before retention existed: start their clock at the decision (or last update).
UPDATE "sessions" SET "decided_at" = COALESCE("reviewed_at", "updated_at") WHERE "status" IN ('APPROVED', 'REJECTED') AND "decided_at" IS NULL;
