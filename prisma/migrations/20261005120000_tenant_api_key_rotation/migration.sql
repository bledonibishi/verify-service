-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "api_key_rotated_at" TIMESTAMP(3),
ADD COLUMN     "previous_api_key_expires_at" TIMESTAMP(3),
ADD COLUMN     "previous_api_key_hash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "tenants_previous_api_key_hash_key" ON "tenants"("previous_api_key_hash");
