-- ============================================================================
-- M0-01: 修复 artifact 类型约束漂移
--
-- 前端 src/lib/api/types.ts 支持 6 种 artifact 类型，但初始 schema 的
-- CHECK 约束只列了 5 种，缺 'drawio'。保存 drawio artifact 会触发
-- 约束违反（23514）。此处补齐。
-- ============================================================================

ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_type_check;

ALTER TABLE artifacts ADD CONSTRAINT artifacts_type_check
  CHECK (type IN ('document', 'slides', 'code', 'mermaid', 'chart', 'drawio'));
