-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "liveness_session_id" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "liveness_min_confidence" DOUBLE PRECISION NOT NULL DEFAULT 90;

-- AlterTable
ALTER TABLE "verification_results" ADD COLUMN     "face_source" TEXT,
ADD COLUMN     "liveness_confidence" DOUBLE PRECISION,
ADD COLUMN     "liveness_provider" TEXT,
ADD COLUMN     "liveness_status" TEXT;
