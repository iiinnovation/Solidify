-- Solidify RLS Policies Migration
-- Phase 2: Row Level Security

-- ============================================================================
-- Enable RLS on all tables
-- ============================================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_entries ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 1. Profiles Policies
-- ============================================================================

-- Users can read their own profile
CREATE POLICY "Users can read own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

-- Users can update their own profile
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);

-- ============================================================================
-- 2. Projects Policies
-- ============================================================================

-- Users can read their own projects
CREATE POLICY "Users can read own projects"
  ON projects FOR SELECT
  USING (auth.uid() = owner_id);

-- Users can create projects
CREATE POLICY "Users can create projects"
  ON projects FOR INSERT
  WITH CHECK (auth.uid() = owner_id);

-- Users can update their own projects
CREATE POLICY "Users can update own projects"
  ON projects FOR UPDATE
  USING (auth.uid() = owner_id);

-- Users can delete their own projects
CREATE POLICY "Users can delete own projects"
  ON projects FOR DELETE
  USING (auth.uid() = owner_id);

-- ============================================================================
-- 3. Conversations Policies
-- ============================================================================

-- Users can read conversations in their projects
CREATE POLICY "Users can read own conversations"
  ON conversations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = conversations.project_id
        AND projects.owner_id = auth.uid()
    )
  );

-- Users can create conversations in their projects
CREATE POLICY "Users can create conversations"
  ON conversations FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = conversations.project_id
        AND projects.owner_id = auth.uid()
    )
  );

-- Users can update conversations in their projects
CREATE POLICY "Users can update own conversations"
  ON conversations FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = conversations.project_id
        AND projects.owner_id = auth.uid()
    )
  );

-- Users can delete conversations in their projects
CREATE POLICY "Users can delete own conversations"
  ON conversations FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = conversations.project_id
        AND projects.owner_id = auth.uid()
    )
  );

-- ============================================================================
-- 4. Messages Policies
-- ============================================================================

-- Users can read messages in their conversations
CREATE POLICY "Users can read own messages"
  ON messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM conversations
      JOIN projects ON projects.id = conversations.project_id
      WHERE conversations.id = messages.conversation_id
        AND projects.owner_id = auth.uid()
    )
  );

-- Users can create messages in their conversations
CREATE POLICY "Users can create messages"
  ON messages FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations
      JOIN projects ON projects.id = conversations.project_id
      WHERE conversations.id = messages.conversation_id
        AND projects.owner_id = auth.uid()
    )
  );

-- Users can update messages in their conversations
CREATE POLICY "Users can update own messages"
  ON messages FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM conversations
      JOIN projects ON projects.id = conversations.project_id
      WHERE conversations.id = messages.conversation_id
        AND projects.owner_id = auth.uid()
    )
  );

-- Users can delete messages in their conversations
CREATE POLICY "Users can delete own messages"
  ON messages FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM conversations
      JOIN projects ON projects.id = conversations.project_id
      WHERE conversations.id = messages.conversation_id
        AND projects.owner_id = auth.uid()
    )
  );

-- ============================================================================
-- 5. Artifacts Policies
-- ============================================================================

-- Users can read artifacts in their conversations
CREATE POLICY "Users can read own artifacts"
  ON artifacts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM conversations
      JOIN projects ON projects.id = conversations.project_id
      WHERE conversations.id = artifacts.conversation_id
        AND projects.owner_id = auth.uid()
    )
  );

-- Users can create artifacts in their conversations
CREATE POLICY "Users can create artifacts"
  ON artifacts FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations
      JOIN projects ON projects.id = conversations.project_id
      WHERE conversations.id = artifacts.conversation_id
        AND projects.owner_id = auth.uid()
    )
  );

-- Users can update artifacts in their conversations
CREATE POLICY "Users can update own artifacts"
  ON artifacts FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM conversations
      JOIN projects ON projects.id = conversations.project_id
      WHERE conversations.id = artifacts.conversation_id
        AND projects.owner_id = auth.uid()
    )
  );

-- Users can delete artifacts in their conversations
CREATE POLICY "Users can delete own artifacts"
  ON artifacts FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM conversations
      JOIN projects ON projects.id = conversations.project_id
      WHERE conversations.id = artifacts.conversation_id
        AND projects.owner_id = auth.uid()
    )
  );

-- ============================================================================
-- 6. Knowledge Entries Policies (Phase 3)
-- ============================================================================

-- Users can read global knowledge (project_id IS NULL) and their project knowledge
CREATE POLICY "Users can read knowledge entries"
  ON knowledge_entries FOR SELECT
  USING (
    project_id IS NULL
    OR EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = knowledge_entries.project_id
        AND projects.owner_id = auth.uid()
    )
  );

-- Users can create knowledge entries in their projects
CREATE POLICY "Users can create knowledge entries"
  ON knowledge_entries FOR INSERT
  WITH CHECK (
    project_id IS NULL -- Allow global knowledge creation (admin only in future)
    OR EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = knowledge_entries.project_id
        AND projects.owner_id = auth.uid()
    )
  );

-- Users can update knowledge entries in their projects
CREATE POLICY "Users can update own knowledge entries"
  ON knowledge_entries FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = knowledge_entries.project_id
        AND projects.owner_id = auth.uid()
    )
  );

-- Users can delete knowledge entries in their projects
CREATE POLICY "Users can delete own knowledge entries"
  ON knowledge_entries FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = knowledge_entries.project_id
        AND projects.owner_id = auth.uid()
    )
  );

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON POLICY "Users can read own profile" ON profiles IS '用户只能读取自己的资料';
COMMENT ON POLICY "Users can read own projects" ON projects IS '用户只能读取自己创建的项目';
COMMENT ON POLICY "Users can read own conversations" ON conversations IS '用户只能读取自己项目下的对话';
COMMENT ON POLICY "Users can read own messages" ON messages IS '用户只能读取自己对话中的消息';
COMMENT ON POLICY "Users can read own artifacts" ON artifacts IS '用户只能读取自己对话中的 Artifacts';
COMMENT ON POLICY "Users can read knowledge entries" ON knowledge_entries IS '用户可以读取全局知识和自己项目的知识';
