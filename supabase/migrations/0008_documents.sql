-- 0008_documents.sql — document ingestion ontology (Markdown first; DOCX/PDF/etc later)
-- Two object types (§3a: docs are durable facts about the owner's world):
--   documents        — one row per uploaded file; body is source of truth in Postgres
--   document_chunks  — one row per Chonkie chunk; the RAG granularity unit

CREATE TABLE IF NOT EXISTS documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  source       text NOT NULL DEFAULT 'upload',
  source_id    text,
  mime         text NOT NULL,
  body         text NOT NULL,
  char_count   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  embedded_at  timestamptz          -- null = not yet chunked/embedded
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index  integer NOT NULL,
  text         text NOT NULL,
  token_count  integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

-- embed work-queue (mirrors idx_emails_unembedded from 0006)
CREATE INDEX IF NOT EXISTS idx_documents_unembedded
  ON documents (created_at DESC) WHERE embedded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id
  ON document_chunks (document_id);
