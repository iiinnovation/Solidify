-- 全文搜索索引
-- 为消息和 Artifacts 内容创建全文搜索索引

-- 为 messages 表创建全文搜索索引
CREATE INDEX idx_messages_content_fts
ON messages USING gin(to_tsvector('simple', content));

-- 为 artifacts 表创建全文搜索索引
CREATE INDEX idx_artifacts_content_fts
ON artifacts USING gin(to_tsvector('simple', content));

-- 为 artifacts 标题创建全文搜索索引
CREATE INDEX idx_artifacts_title_fts
ON artifacts USING gin(to_tsvector('simple', title));

-- 为 conversations 标题创建全文搜索索引
CREATE INDEX idx_conversations_title_fts
ON conversations USING gin(to_tsvector('simple', title));

-- 全文搜索函数
-- 使用 auth.uid() 确保用户只能搜索自己的数据
CREATE OR REPLACE FUNCTION search_content(
  search_query TEXT
)
RETURNS TABLE (
  result_type TEXT,
  result_id UUID,
  conversation_id UUID,
  title TEXT,
  content TEXT,
  rank REAL
) AS $$
BEGIN
  RETURN QUERY
  -- 搜索消息
  SELECT
    'message'::TEXT as result_type,
    m.id as result_id,
    m.conversation_id,
    c.title,
    m.content,
    ts_rank(to_tsvector('simple', m.content), plainto_tsquery('simple', search_query)) as rank
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  JOIN projects p ON p.id = c.project_id
  WHERE p.owner_id = auth.uid()
    AND to_tsvector('simple', m.content) @@ plainto_tsquery('simple', search_query)

  UNION ALL

  -- 搜索 Artifacts
  SELECT
    'artifact'::TEXT as result_type,
    a.id as result_id,
    a.conversation_id,
    a.title,
    a.content,
    ts_rank(to_tsvector('simple', a.title || ' ' || a.content), plainto_tsquery('simple', search_query)) as rank
  FROM artifacts a
  JOIN conversations c ON c.id = a.conversation_id
  JOIN projects p ON p.id = c.project_id
  WHERE p.owner_id = auth.uid()
    AND (
      to_tsvector('simple', a.title) @@ plainto_tsquery('simple', search_query)
      OR to_tsvector('simple', a.content) @@ plainto_tsquery('simple', search_query)
    )

  UNION ALL

  -- 搜索对话标题
  SELECT
    'conversation'::TEXT as result_type,
    c.id as result_id,
    c.id as conversation_id,
    c.title,
    ''::TEXT as content,
    ts_rank(to_tsvector('simple', c.title), plainto_tsquery('simple', search_query)) as rank
  FROM conversations c
  JOIN projects p ON p.id = c.project_id
  WHERE p.owner_id = auth.uid()
    AND to_tsvector('simple', c.title) @@ plainto_tsquery('simple', search_query)

  ORDER BY rank DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION search_content IS '全文搜索函数，搜索消息、Artifacts 和对话标题';
