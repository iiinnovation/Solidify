-- Add usage tracking table for Phase 4
-- This migration is optional for Phase 2 but prepares for future usage control

CREATE TABLE IF NOT EXISTS usage_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd DECIMAL(10, 6) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for user lookup and date range queries
CREATE INDEX idx_usage_logs_user_id ON usage_logs(user_id);
CREATE INDEX idx_usage_logs_created_at ON usage_logs(created_at DESC);
CREATE INDEX idx_usage_logs_user_date ON usage_logs(user_id, created_at DESC);

-- RLS policies for usage_logs
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

-- Users can read their own usage logs
CREATE POLICY "Users can read own usage logs"
  ON usage_logs FOR SELECT
  USING (auth.uid() = user_id);

-- Only Edge Functions can insert usage logs (via service role)
-- No INSERT policy for regular users

COMMENT ON TABLE usage_logs IS '用量统计表，记录每次 AI 调用的 token 消耗（Phase 4）';
