-- Workout app tables (same Supabase project as LifeHub)

CREATE TABLE IF NOT EXISTS wk_store (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE wk_store ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wk_store_public" ON wk_store
  FOR ALL USING (true) WITH CHECK (true);
