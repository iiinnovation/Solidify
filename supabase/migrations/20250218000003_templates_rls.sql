-- Solidify Templates RLS Policies
-- Row Level Security for templates table

-- ============================================================================
-- Enable RLS
-- ============================================================================
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- Policies
-- ============================================================================

-- Policy: 用户可以查看自己的模板
CREATE POLICY "Users can view their own templates"
  ON templates
  FOR SELECT
  USING (auth.uid() = owner_id);

-- Policy: 用户可以查看公开模板
CREATE POLICY "Users can view public templates"
  ON templates
  FOR SELECT
  USING (is_public = true);

-- Policy: 用户可以创建模板
CREATE POLICY "Users can create templates"
  ON templates
  FOR INSERT
  WITH CHECK (auth.uid() = owner_id);

-- Policy: 用户可以更新自己的模板
CREATE POLICY "Users can update their own templates"
  ON templates
  FOR UPDATE
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

-- Policy: 用户可以删除自己的模板
CREATE POLICY "Users can delete their own templates"
  ON templates
  FOR DELETE
  USING (auth.uid() = owner_id);

-- ============================================================================
-- RPC Function: Increment template usage count
-- ============================================================================
CREATE OR REPLACE FUNCTION increment_template_usage(template_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE templates
  SET usage_count = usage_count + 1
  WHERE id = template_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION increment_template_usage(UUID) TO authenticated;

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON POLICY "Users can view their own templates" ON templates IS '用户可以查看自己创建的模板';
COMMENT ON POLICY "Users can view public templates" ON templates IS '所有用户可以查看公开模板';
COMMENT ON POLICY "Users can create templates" ON templates IS '用户可以创建模板';
COMMENT ON POLICY "Users can update their own templates" ON templates IS '用户只能更新自己的模板';
COMMENT ON POLICY "Users can delete their own templates" ON templates IS '用户只能删除自己的模板';
COMMENT ON FUNCTION increment_template_usage(UUID) IS '增加模板使用次数';
