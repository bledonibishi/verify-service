-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "review_reason" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "reviewed_by_id" TEXT;

-- CreateTable
CREATE TABLE "reviewers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviewers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviewer_sessions" (
    "id" TEXT NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviewer_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reviewers_email_key" ON "reviewers"("email");

-- CreateIndex
CREATE INDEX "reviewers_tenant_id_idx" ON "reviewers"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviewer_sessions_token_hash_key" ON "reviewer_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "reviewer_sessions_reviewer_id_idx" ON "reviewer_sessions"("reviewer_id");

-- CreateIndex
CREATE INDEX "sessions_tenant_id_status_created_at_idx" ON "sessions"("tenant_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "reviewers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviewers" ADD CONSTRAINT "reviewers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviewer_sessions" ADD CONSTRAINT "reviewer_sessions_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "reviewers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
