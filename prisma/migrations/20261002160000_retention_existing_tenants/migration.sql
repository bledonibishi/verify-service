-- Tenants that existed before retention shipped keep their documents as long as their records,
-- so deploying never deletes anything on its own. New tenants get the 30-day default, and an
-- operator shortens an existing tenant deliberately with `pnpm tenant:update`.
UPDATE "tenants" SET "document_retention_days" = "record_retention_days";
