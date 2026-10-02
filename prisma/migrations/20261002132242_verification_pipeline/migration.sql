-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "auto_approve" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "verification_jobs" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_results" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "auto_decided" BOOLEAN NOT NULL,
    "mrz_found" BOOLEAN NOT NULL,
    "mrz_valid" BOOLEAN NOT NULL,
    "ocr_repaired" BOOLEAN NOT NULL,
    "surname_match" TEXT,
    "given_names_match" TEXT,
    "birth_date_match" TEXT,
    "expired" BOOLEAN,
    "checks" JSONB NOT NULL,
    "issue_codes" TEXT[],
    "ocr_provider" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "verification_jobs_session_id_key" ON "verification_jobs"("session_id");

-- CreateIndex
CREATE INDEX "verification_jobs_status_run_after_idx" ON "verification_jobs"("status", "run_after");

-- CreateIndex
CREATE UNIQUE INDEX "verification_results_session_id_key" ON "verification_results"("session_id");

-- AddForeignKey
ALTER TABLE "verification_jobs" ADD CONSTRAINT "verification_jobs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
