-- 0006_email_embeddings.sql
-- Adds embedding-status tracking to emails. The vector itself lives in Qdrant
-- (the derived index, §3a utility); the FACT "this email is embedded" is a fact
-- about the email, so it lives on the email as a column — not a shadow table.
-- Mirrors the classify work-queue pattern (0005's idx_emails_unclassified).

alter table emails add column if not exists embedded_at timestamptz;

create index if not exists idx_emails_unembedded
  on emails (received_at desc)
  where body is not null and embedded_at is null;
