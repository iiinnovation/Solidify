-- 创建 attachments 表
CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  extracted_content TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_attachments_message_id ON attachments(message_id);
CREATE INDEX idx_attachments_created_at ON attachments(created_at DESC);

-- RLS 策略
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "用户可以查看自己消息的附件"
  ON attachments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      JOIN projects p ON c.project_id = p.id
      WHERE m.id = attachments.message_id
        AND p.owner_id = auth.uid()
    )
  );

CREATE POLICY "用户可以上传附件到自己的消息"
  ON attachments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      JOIN projects p ON c.project_id = p.id
      WHERE m.id = attachments.message_id
        AND p.owner_id = auth.uid()
    )
  );

CREATE POLICY "用户可以删除自己的附件"
  ON attachments FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      JOIN projects p ON c.project_id = p.id
      WHERE m.id = attachments.message_id
        AND p.owner_id = auth.uid()
    )
  );

-- 创建 Storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('solidify-files', 'solidify-files', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS 策略
-- 注意：Storage 路径格式为 attachments/{message_id}/{filename}
-- 需要验证用户是否拥有该 message 对应的 project

CREATE POLICY "用户可以上传文件到自己的消息"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'solidify-files'
    AND auth.uid() IS NOT NULL
    AND (
      -- 提取路径中的 message_id (格式: attachments/{message_id}/{filename})
      EXISTS (
        SELECT 1 FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
        JOIN projects p ON c.project_id = p.id
        WHERE m.id::text = split_part(name, '/', 2)
          AND p.owner_id = auth.uid()
      )
    )
  );

CREATE POLICY "用户可以查看自己的文件"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'solidify-files'
    AND auth.uid() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
        JOIN projects p ON c.project_id = p.id
        WHERE m.id::text = split_part(name, '/', 2)
          AND p.owner_id = auth.uid()
      )
    )
  );

CREATE POLICY "用户可以删除自己的文件"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'solidify-files'
    AND auth.uid() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
        JOIN projects p ON c.project_id = p.id
        WHERE m.id::text = split_part(name, '/', 2)
          AND p.owner_id = auth.uid()
      )
    )
  );
