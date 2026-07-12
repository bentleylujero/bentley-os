-- 0005_email_intelligence.sql
-- M3: email body storage + triage classification fields.
-- body: full decoded text/plain (or stripped html) — feeds Pass-2 classification,
--   embeddings, and future pattern detection (unsubscribe suggestions, Q&A).
-- reason: marionette's one-line "why this matters" consequence assessment.
-- confidence: marionette's Pass-1 self-reported certainty (0-100); low values
--   trigger Pass-2 full-body re-classification.
-- classified_at: null = never judged; classifier only touches WHERE classified_at IS NULL.

ALTER TABLE emails ADD COLUMN IF NOT EXISTS body          text;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS reason        text;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS confidence    smallint;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS classified_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_emails_unclassified
  ON emails (received_at DESC)
  WHERE classified_at IS NULL;
