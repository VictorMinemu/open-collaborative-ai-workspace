-- Phase 5 (D-07, AICHAT-01): organization provider keys move onto SecretReferences. Every model_providers row with
-- a key gets secret_ref = {"provider":"db","secretId":<secret_id>,"organizationId":<organization_id>}.
-- Ids only: app.secrets IS the `db` SecretStore provider, so the ciphertext never moves, is never decrypted,
-- re-encrypted or deleted (it stays sealed with AAD = organization id). Rows without a key (openai-compatible
-- without one, openai-codex subscriptions, mock) keep secret_ref NULL.
-- Idempotent: only rows with secret_id set and secret_ref still NULL are touched; a second run changes nothing.
-- Rollback: `UPDATE app.model_providers SET secret_ref = NULL;` — `secret_id` and the sealed secrets are untouched,
-- so code that reads `secret_id` keeps working; `secret_id` is dropped only by the follow-up in
-- .planning/todos/pending/2026-10-06-drop-model-providers-secret-id.md.
update app.model_providers set secret_ref = jsonb_build_object('provider', 'db', 'secretId', secret_id::text, 'organizationId', organization_id::text) where secret_id is not null and secret_ref is null;
