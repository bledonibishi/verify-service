-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "face_match_threshold" DOUBLE PRECISION NOT NULL DEFAULT 90;

-- AlterTable
ALTER TABLE "verification_results" ADD COLUMN     "face_provider" TEXT,
ADD COLUMN     "face_similarity" DOUBLE PRECISION,
ADD COLUMN     "face_status" TEXT;
