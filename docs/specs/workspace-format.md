# spec · 工作区格式

> 约束模块：`src/lib/workspace/`、`src-tauri/src/fs/`　对应里程碑：[M3](../phases/M3-local-workspace.md)
> 相关决策：[ADR-0001](../04-decisions.md#adr-0001)、[ADR-0006](../04-decisions.md#adr-0006)

## 1. 核心原则

**一个项目 = 一个用户可见的普通目录。**

用户能用 Finder / 资源管理器打开它、拖拽文件进去、备份、放进网盘或 Git。应用不劫持、不隐藏、不用私有格式包装用户的文件。

这条原则推导出三个约束：

1. 用户的文件保持**原样**存放，不重命名、不加元数据后缀
2. 应用的元数据全部收在 `.solidify/` 一个隐藏目录里
3. 用户在应用外修改文件，应用必须能感知并同步

## 2. 目录结构

```
~/Solidify/客户A-数字化方案/          ← 项目根 = 工作区根 = 沙箱边界
│
├── .solidify/                       ← 应用元数据，用户不需要关心
│   ├── project.json                 项目标识、配置、云端映射
│   ├── policy.json                  项目级权限策略（可选）
│   ├── conversations/
│   │   └── <conv-id>.jsonl          消息流，追加式
│   ├── ledger/
│   │   └── <run-id>.jsonl           运行账本，追加式
│   ├── artifacts/
│   │   └── <artifact-id>/
│   │       ├── meta.json
│   │       ├── v1.md
│   │       └── v2.md                版本化，不覆盖
│   ├── skills/                      项目级 Skill（覆盖用户级同名）
│   ├── cache/                       可安全删除的派生物（缩略图、抽取文本）
│   └── index.db                     SQLite：文件索引 + FTS + 向量
│
├── 01-输入材料/                      ← 以下全是用户自己的文件
├── 02-过程/
└── 03-交付物/
    ├── 需求规格.md
    └── 方案汇报.pptd/                PPTD 就是个普通目录
        ├── deck.pptd
        ├── pages/
        └── media/
```

`01-` `02-` `03-` 是新建项目时的默认脚手架，用户可以随意改。应用不依赖任何固定子目录名。

## 3. project.json

```json
{
  "schemaVersion": 1,
  "id": "prj_01HQZX8K9M2N",
  "name": "客户A-数字化方案",
  "createdAt": "2026-08-11T10:00:00Z",
  "stage": "solution",
  "sync": {
    "enabled": true,
    "remoteProjectId": "uuid-in-supabase",
    "lastSyncedAt": "2026-08-11T14:30:00Z"
  },
  "defaults": {
    "model": "claude-sonnet-4",
    "skills": ["requirement-analysis", "solution-design"]
  }
}
```

`id` 用本地生成的稳定标识，**不用 Supabase 的 UUID** —— 项目在没有云端账号时也要能存在。云端 id 放在 `sync.remoteProjectId` 里做映射。

## 4. 本地索引（index.db）

见 [ADR-0006](../04-decisions.md#adr-0006)。

```sql
-- 文件索引
CREATE TABLE files (
  path         TEXT PRIMARY KEY,      -- 相对项目根
  size         INTEGER NOT NULL,
  mtime        INTEGER NOT NULL,
  content_hash TEXT,                  -- 用于检测内容变化
  kind         TEXT,                  -- doc/sheet/slide/image/pdf/code/other
  extracted_at INTEGER                -- 文本抽取时间，NULL = 未抽取
);

-- 全文检索（trigram 分词，见 ADR-0006 已知问题）
CREATE VIRTUAL TABLE files_fts USING fts5(
  path, content, tokenize='trigram'
);

-- 向量（sqlite-vec）
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[1536]
);

CREATE TABLE chunks (
  chunk_id TEXT PRIMARY KEY,
  path     TEXT NOT NULL,
  ordinal  INTEGER NOT NULL,
  text     TEXT NOT NULL,
  FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
);
```

⚠️ **索引是派生数据**。删掉 `index.db` 后应用必须能自动重建，且不丢失任何真相。任何数据都不得只存在于索引里。

## 5. 文件变更监听

Rust 侧用 `notify` crate，向前端 emit 事件：

```rust
#[derive(Serialize, Clone)]
pub struct FsChangeEvent {
    pub kind: FsChangeKind,   // Created | Modified | Removed | Renamed
    pub path: String,         // 相对项目根
    pub is_dir: bool,
}
```

处理规则：

| 情况 | 处理 |
|---|---|
| `.solidify/cache/` 内变更 | 忽略 |
| `.solidify/` 其他变更 | 忽略（应用自己写的） |
| 用户文件新增/修改 | 防抖 500ms → 更新索引 → 刷新文件树 |
| 用户文件删除 | 更新索引；若被 artifact 或引用指向，标记为失效而非静默删除 |
| 重命名 | 尽量识别为 rename（同 hash），保持引用有效 |
| 一次性大量变更（如解压、git checkout） | 超过阈值（100 个）则退化为整体重扫，不逐个处理 |

**必须防抖**。编辑器保存文件常触发多次事件（写临时文件 → rename），不防抖会重复索引。

## 6. 忽略规则

遍历与索引时跳过：

```
.git/  node_modules/  .DS_Store  Thumbs.db
~$*                          Office 临时文件
*.tmp  *.swp  *.crdownload    传输中/临时文件
.solidify/cache/
```

以及用户在项目根放的 `.solidifyignore`（gitignore 语法）。Rust 侧用 `ignore` crate 直接支持。

## 7. 路径处理

| 场景 | 规则 |
|---|---|
| 存储 | 一律存**相对项目根**的路径，用 `/` 分隔 |
| 展示 | 按平台转换分隔符 |
| 传给工具 | 相对路径，由 Rust 侧解析为绝对路径 |
| 沙箱校验 | canonicalize 后判断是否在项目根之下，见 [tool-interface.md §8](tool-interface.md) |

存相对路径的原因：整个项目目录可以被拷贝、改名、换机器，内部引用不失效。

## 8. 与 Supabase 的同步

**单向快照，不做双向同步**（[ADR-0001](../04-decisions.md#adr-0001)）。

| 同步 | 不同步 |
|---|---|
| 项目元数据（名称、阶段、成员） | 用户文件原文 |
| artifact 的元信息与内容（文本类） | 大文件、媒体、导出物 |
| 知识条目与向量 | index.db |
| 用量统计 | ledger 明细（只传聚合） |

冲突处理：本地永远赢。云端快照被覆盖时不提示。真正需要多人协作的场景在 M6 之后单独设计。

## 9. Web 端降级

Web 端没有文件系统。降级方案：

- 项目变为「云端项目」，文件走 Supabase Storage 的虚拟目录
- `tauri-only` 工具在注册表中被过滤掉，模型看不到它们
- UI 明确提示当前为受限模式
- **不做** File System Access API 适配（浏览器兼容性与权限模型差异大，不值得）

## 10. 新建项目流程

```
用户点"新建项目"
  → 选择父目录（默认 ~/Solidify/）
  → 输入名称
  → 创建目录 + .solidify/ + 默认脚手架子目录
  → 初始化 index.db
  → 启动 watcher
  → 打开工作区
```

以及「打开已有目录为项目」：选一个已存在的目录 → 若无 `.solidify/` 则创建 → 首次全量索引（显示进度）。

## 11. 验收测试

| 用例 | 期望 |
|---|---|
| Finder 中新增文件 | 500ms 内文件树出现，索引更新，AI 可读到 |
| Finder 中删除被引用的文件 | 引用标记失效，不崩溃 |
| 整个项目目录改名后重新打开 | 一切正常（相对路径生效） |
| 删除 index.db 后重启 | 自动重建，无数据丢失 |
| 解压一个含 500 个文件的压缩包 | 退化为整体重扫，UI 不卡死 |
| 项目内放 node_modules | 被忽略，不进索引 |
| 中文文件名 + 中文内容检索 | 能检索到（trigram 生效） |
