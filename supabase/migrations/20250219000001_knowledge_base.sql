-- Knowledge Base System Migration
-- 为知识库系统添加 pgvector 支持和相关函数

-- ============================================================================
-- 1. Enable pgvector extension
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- 2. Update knowledge_entries table (已在 initial_schema.sql 中创建)
-- ============================================================================
-- 添加向量相似度搜索索引
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_embedding
ON knowledge_entries USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- 添加全文搜索索引
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_content_fts
ON knowledge_entries USING gin(to_tsvector('simple', content));

CREATE INDEX IF NOT EXISTS idx_knowledge_entries_title_fts
ON knowledge_entries USING gin(to_tsvector('simple', title));

-- ============================================================================
-- 3. Vector Search Function (向量相似度搜索)
-- ============================================================================
CREATE OR REPLACE FUNCTION search_knowledge_vector(
  query_embedding VECTOR(1536),
  project_id_param UUID,
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  content TEXT,
  source_type TEXT,
  metadata JSONB,
  similarity FLOAT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ke.id,
    ke.title,
    ke.content,
    ke.source_type,
    ke.metadata,
    1 - (ke.embedding <=> query_embedding) as similarity,
    ke.created_at
  FROM knowledge_entries ke
  WHERE
    (ke.project_id = project_id_param OR ke.project_id IS NULL)
    AND ke.embedding IS NOT NULL
    AND 1 - (ke.embedding <=> query_embedding) > match_threshold
  ORDER BY ke.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION search_knowledge_vector IS '向量相似度搜索知识库，返回最相关的知识条目';

-- ============================================================================
-- 4. Hybrid Search Function (混合搜索：向量 + 全文)
-- ============================================================================
CREATE OR REPLACE FUNCTION search_knowledge_hybrid(
  query_text TEXT,
  query_embedding VECTOR(1536),
  project_id_param UUID,
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  content TEXT,
  source_type TEXT,
  metadata JSONB,
  similarity FLOAT,
  text_rank FLOAT,
  combined_score FLOAT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  WITH vector_search AS (
    SELECT
      ke.id,
      ke.title,
      ke.content,
      ke.source_type,
      ke.metadata,
      ke.created_at,
      1 - (ke.embedding <=> query_embedding) as similarity
    FROM knowledge_entries ke
    WHERE
      (ke.project_id = project_id_param OR ke.project_id IS NULL)
      AND ke.embedding IS NOT NULL
  ),
  text_search AS (
    SELECT
      ke.id,
      ts_rank(to_tsvector('simple', ke.title || ' ' || ke.content), plainto_tsquery('simple', query_text)) as rank
    FROM knowledge_entries ke
    WHERE
      (ke.project_id = project_id_param OR ke.project_id IS NULL)
      AND (
        to_tsvector('simple', ke.title) @@ plainto_tsquery('simple', query_text)
        OR to_tsvector('simple', ke.content) @@ plainto_tsquery('simple', query_text)
      )
  )
  SELECT
    vs.id,
    vs.title,
    vs.content,
    vs.source_type,
    vs.metadata,
    vs.similarity,
    COALESCE(ts.rank, 0) as text_rank,
    (vs.similarity * 0.7 + COALESCE(ts.rank, 0) * 0.3) as combined_score,
    vs.created_at
  FROM vector_search vs
  LEFT JOIN text_search ts ON vs.id = ts.id
  WHERE vs.similarity > match_threshold
  ORDER BY combined_score DESC
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION search_knowledge_hybrid IS '混合搜索（向量 + 全文），提供更准确的搜索结果';

-- ============================================================================
-- 5. Batch Insert Function (批量插入知识条目)
-- ============================================================================
CREATE OR REPLACE FUNCTION insert_knowledge_batch(
  entries JSONB
)
RETURNS TABLE (
  id UUID,
  success BOOLEAN,
  error TEXT
) AS $$
DECLARE
  entry JSONB;
BEGIN
  FOR entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    BEGIN
      INSERT INTO knowledge_entries (
        project_id,
        source_type,
        source_id,
        title,
        content,
        embedding,
        metadata
      ) VALUES (
        (entry->>'project_id')::UUID,
        entry->>'source_type',
        (entry->>'source_id')::UUID,
        entry->>'title',
        entry->>'content',
        (entry->>'embedding')::VECTOR(1536),
        (entry->'metadata')::JSONB
      )
      RETURNING knowledge_entries.id INTO id;

      success := TRUE;
      error := NULL;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      id := NULL;
      success := FALSE;
      error := SQLERRM;
      RETURN NEXT;
    END;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION insert_knowledge_batch IS '批量插入知识条目，返回每条的插入结果';

-- ============================================================================
-- 6. Statistics Function (知识库统计)
-- ============================================================================
CREATE OR REPLACE FUNCTION get_knowledge_stats(
  project_id_param UUID
)
RETURNS TABLE (
  total_entries BIGINT,
  by_source_type JSONB,
  total_size_bytes BIGINT,
  avg_content_length FLOAT,
  created_today BIGINT,
  created_this_week BIGINT,
  created_this_month BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT as total_entries,
    jsonb_object_agg(
      source_type,
      count
    ) as by_source_type,
    SUM(LENGTH(content))::BIGINT as total_size_bytes,
    AVG(LENGTH(content))::FLOAT as avg_content_length,
    COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::BIGINT as created_today,
    COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days')::BIGINT as created_this_week,
    COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '30 days')::BIGINT as created_this_month
  FROM knowledge_entries
  WHERE project_id = project_id_param OR project_id IS NULL
  GROUP BY ()
  CROSS JOIN LATERAL (
    SELECT source_type, COUNT(*) as count
    FROM knowledge_entries
    WHERE project_id = project_id_param OR project_id IS NULL
    GROUP BY source_type
  ) source_counts;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION get_knowledge_stats IS '获取知识库统计信息';

-- ============================================================================
-- 7. Cleanup Function (清理孤立的知识条目)
-- ============================================================================
CREATE OR REPLACE FUNCTION cleanup_orphaned_knowledge()
RETURNS TABLE (
  deleted_count BIGINT
) AS $$
BEGIN
  -- 删除引用了不存在的 conversation 或 artifact 的知识条目
  WITH deleted AS (
    DELETE FROM knowledge_entries ke
    WHERE
      ke.source_type = 'conversation'
      AND ke.source_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM conversations c WHERE c.id = ke.source_id
      )
    OR
      ke.source_type = 'artifact'
      AND ke.source_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM artifacts a WHERE a.id = ke.source_id
      )
    RETURNING ke.id
  )
  SELECT COUNT(*)::BIGINT FROM deleted INTO deleted_count;

  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION cleanup_orphaned_knowledge IS '清理孤立的知识条目（引用的源已被删除）';

-- ============================================================================
-- 8. Grant permissions
-- ============================================================================
-- 授予 authenticated 用户执行这些函数的权限
GRANT EXECUTE ON FUNCTION search_knowledge_vector TO authenticated;
GRANT EXECUTE ON FUNCTION search_knowledge_hybrid TO authenticated;
GRANT EXECUTE ON FUNCTION insert_knowledge_batch TO authenticated;
GRANT EXECUTE ON FUNCTION get_knowledge_stats TO authenticated;
GRANT EXECUTE ON FUNCTION cleanup_orphaned_knowledge TO authenticated;
