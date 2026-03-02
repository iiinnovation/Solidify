-- Solidify Templates Migration
-- Phase 2: Template System

-- ============================================================================
-- Templates Table (模板)
-- ============================================================================
CREATE TABLE templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  skill_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  variables JSONB NOT NULL DEFAULT '[]',
  is_public BOOLEAN NOT NULL DEFAULT false,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for templates
CREATE INDEX idx_templates_owner_id ON templates(owner_id);
CREATE INDEX idx_templates_project_id ON templates(project_id);
CREATE INDEX idx_templates_skill_id ON templates(skill_id);
CREATE INDEX idx_templates_is_public ON templates(is_public) WHERE is_public = true;
CREATE INDEX idx_templates_created_at ON templates(created_at DESC);

-- Trigger: Auto-update updated_at
CREATE TRIGGER update_templates_updated_at
  BEFORE UPDATE ON templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON TABLE templates IS '模板表，支持用户自定义文档模板和变量替换';
COMMENT ON COLUMN templates.owner_id IS '模板创建者';
COMMENT ON COLUMN templates.project_id IS '项目专属模板（null 表示全局模板）';
COMMENT ON COLUMN templates.skill_id IS '关联的技能 ID（null 表示通用模板）';
COMMENT ON COLUMN templates.variables IS '变量定义列表（JSON 数组）';
COMMENT ON COLUMN templates.is_public IS '是否公开（团队共享）';
COMMENT ON COLUMN templates.usage_count IS '使用次数统计';
