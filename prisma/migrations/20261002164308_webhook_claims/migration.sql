-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "claims" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failed_at" TIMESTAMP(3);
