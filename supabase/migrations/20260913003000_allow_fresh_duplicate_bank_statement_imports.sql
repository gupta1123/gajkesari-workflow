-- Every deliberate bank-statement upload is a new analysis run. Keep the
-- source hash for audit and transaction-level idempotency, but do not use it
-- as an import cache key.
drop index if exists public.bank_statement_imports_company_source_sha256_key;
