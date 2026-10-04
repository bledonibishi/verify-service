-- AlterTable
ALTER TABLE "reviewers" ADD COLUMN     "totp_enabled_at" TIMESTAMP(3),
ADD COLUMN     "totp_last_step" INTEGER,
ADD COLUMN     "totp_secret_sealed" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "require_reviewer_two_factor" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" TEXT NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_challenges" (
    "id" TEXT NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recovery_codes_reviewer_id_idx" ON "recovery_codes"("reviewer_id");

-- CreateIndex
CREATE UNIQUE INDEX "login_challenges_token_hash_key" ON "login_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "login_challenges_reviewer_id_idx" ON "login_challenges"("reviewer_id");

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "reviewers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "reviewers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
