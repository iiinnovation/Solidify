-- Knowledge Base RLS Policies
-- 为知识库表添加行级安全策略

-- ============================================================================
-- 1. Enable RLS on knowledge_entries
-- ============================================================================
ALTER TABLE knowledge_entries ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 2. Select Policy (查询权限)
-- ============================================================================
-- 用户可以查询自己项目的知识条目 + 全局知识条目（project_id IS NULL）
CREATE POLICY "Users can view their project knowledge and global knowledge"
ON knowledge_entries
FOR SELECT
TO authenticated
USING (
  project_id IS NULL  -- 全局知识（所有人可见）
  OR
  project_id IN (
    SELECT p.id FROM projects p WHERE p.owner_id = auth.uid()
  )
);

-- ============================================================================
-- 3. Insert Policy (插入权限)
-- ============================================================================
-- 用户只能向自己的项目插入知识条目
CREATE POLICY "Users can insert knowledge to their projects"
ON knowledge_entries
FOR INSERT
TO authenticated
WITH CHECK (
  project_id IS NULL  -- 允许创建全局知识（可选，根据需求调整）
  OR
  project_id IN (
    SELECT p.id FROM projects p WHERE p.owner_id = auth.uid()
  )
);

-- ============================================================================
-- 4. Update Policy (更新权限)
-- ============================================================================
-- 用户只能更新自己项目的知识条目
CREATE POLICY "Users can update their project knowledge"
ON knowledge_entries
FOR UPDATE
TO authenticated
USING (
  project_id IN (
    SELECT p.id FROM projects p WHERE p.owner_id = auth.uid()
  )
)
WITH CHECK (
  project_id IN (
    SELECT p.id FROM projects p WHERE p.owner_id = auth.uid()
  )
);

-- ============================================================================
-- 5. Delete Policy (删除权限)
-- ============================================================================
-- 用户只能删除自己项目的知识条目
CREATE POLICY "Users can delete their project knowledge"
ON knowledge_entries
FOR DELETE
TO authenticated
USING (
  project_id IN (
    SELECT p.id FROM projects p WHERE p.owner_id = auth.uid()
  )
);

-- ============================================================================
-- 6. Comments
-- ============================================================================
COMMENT ON POLICY "Users can view their project knowledge and global knowledge" ON knowledge_entries IS '用户可以查看自己项目的知识和全局知识';
COMMENT ON POLICY "Users can insert knowledge to their projects" ON knowledge_entries IS '用户可以向自己的项目插入知识';
COMMENT ON POLICY "Users can update their project knowledge" ON knowledge_entries IS '用户可以更新自己项目的知识';
COMMENT ON POLICY "Users can delete their project knowledge" ON knowledge_entries IS '用户可以删除自己项目的知识';
