# @verify-service/client

TypeScript client for verify-service. No dependencies; uses the platform `fetch` (Node 18+, browsers).

- `@verify-service/client` for your **server**: `VerifyClient` (create and read sessions, delete, evidence, webhook events) and `constructWebhookEvent` / `verifySignature`.
- `@verify-service/client/browser` for **screens you build yourself**: `UploadClient`, which holds only the one-time upload token and never your API key.

Full guide with examples: [docs/integration.md](../docs/integration.md). Build with `pnpm sdk:build` from the repository root.
