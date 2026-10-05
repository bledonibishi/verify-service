-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentKind" ADD VALUE 'LICENCE_FRONT';
ALTER TYPE "DocumentKind" ADD VALUE 'LICENCE_BACK';

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "require_licence" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "verification_results" ADD COLUMN     "licence_birth_date_match" TEXT,
ADD COLUMN     "licence_dates_valid" BOOLEAN,
ADD COLUMN     "licence_expired" BOOLEAN,
ADD COLUMN     "licence_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "licence_found" BOOLEAN,
ADD COLUMN     "licence_given_names_match" TEXT,
ADD COLUMN     "licence_personal_number_match" TEXT,
ADD COLUMN     "licence_repaired" BOOLEAN,
ADD COLUMN     "licence_surname_match" TEXT;
