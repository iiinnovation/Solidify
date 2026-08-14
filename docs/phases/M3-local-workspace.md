# M3 · 本地工作区与记忆

| | |
|---|---|
| **层** | L5 + 能力层 |
| **工期** | 3–4 周（约 16–19 pd） |
| **前置** | M1 |
| **并行** | 可与 M2 并行（M3 主要在 Rust 侧） |
| **规格** | [specs/workspace-format.md](../specs/workspace-format.md) |
| **特性开关** | `localWorkspace` |

> **归档决定（2026-08-14）**：M3 的本地工作区、文件监听与索引、持久化记忆、迁移接口和工作区 UI 已完成；规格中的 7 个验收场景与 1 万文件压力用例均纳入自动化测试。向量索引按既定降级方案使用 SQLite BLOB 存储，避免 `sqlite-vec` 的跨平台动态加载风险。

## 目标

把「项目」从数据库里的一行记录，变成**用户桌面上一个真实的文件夹**。

这是四根支柱里「文件管理」和「项目作业区」的实现，也是 M4 Skill 体系的前提。工作量的重心在 Rust —— 从 31 行长到约 1.5k 行。

## Demo（验收标准）

> 新建项目，选一个本地文件夹。文件树显示其内容。
>
> 切到 Finder 往里拖一个 Word 文档，回到应用文件树自动出现该文件，AI 立刻能读到它的内容。
>
> 在 Finder 里把整个项目文件夹改名，重新打开，一切正常。

## 任务清单

### A. Rust 能力层（8 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M3-01 | 目录遍历 `list_dir` / `read_tree`（`ignore` crate，支持 .solidifyignore） | `src-tauri/src/fs/tree.rs` | 2pd |
| M3-02 | 文件监听 `watch_dir`（`notify` crate）+ 防抖 + emit 事件 | `src-tauri/src/fs/watcher.rs` | 2pd |
| M3-03 | 大量变更退化为整体重扫（阈值 100） | 同上 | 0.5pd |
| M3-04 | SQLite 接入（`rusqlite` + FTS5 trigram + sqlite-vec） | `src-tauri/src/db/mod.rs` | 2pd |
| M3-05 | 内容检索 command（供 `search_files` 用） | `src-tauri/src/fs/search.rs` | 1pd |
| M3-06 | 沙箱校验复用与加固（M1-22 的扩展） | `src-tauri/src/fs/sandbox.rs` | 0.5pd |

⚠️ M3-04 的两个坑：

- **FTS5 中文分词**：默认分词器不切中文。用 `tokenize='trigram'`（SQLite 3.34+ 内置）。验收必须包含中文检索用例。
- **sqlite-vec 扩展加载**：需要确认目标平台（macOS arm64/x64、Windows）都能加载。若加载困难，降级方案是向量存 BLOB + 应用侧计算余弦相似度（数据量小时可接受）。

### B. 工作区管理（4 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M3-07 | 工作区打开/创建/关闭；`project.json` 读写 | `src/lib/workspace/workspace.ts` | 1.5pd |
| M3-08 | 默认脚手架生成（`.solidify/` + 三个默认目录） | `src/lib/workspace/scaffold.ts` | 0.5pd |
| M3-09 | 索引器：全量扫描 + 增量更新 + 文本抽取入库 | `src/lib/workspace/indexer.ts` | 1.5pd |
| M3-10 | 变更事件消费 → 更新索引 → 刷新 UI | `src/stores/workspace-store.ts` | 0.5pd |

M3-09 的文本抽取复用现有 `src/lib/file-extractor.ts`（mammoth / pdfjs），不重写。

### C. 记忆层（3 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M3-11 | memdir：会话内短期记忆 + 句柄存储落盘 | `src/lib/memory/memdir.ts` | 1pd |
| M3-12 | 长期记忆检索（接入现有 `src/lib/rag/`） | `src/lib/memory/retrieval.ts` | 1pd |
| M3-13 | 查询前预取相关记忆（`before_query` hook） | `src/lib/memory/prefetch.ts` | 1pd |

M1-10 的句柄存储在内存里，M3 改为落 `.solidify/cache/`，接口不变。

### D. 数据迁移（2 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M3-14 | 会话与账本改写到 `.solidify/*.jsonl` | `src/lib/workspace/persistence.ts` | 1pd |
| M3-15 | 云端老项目一次性导出到本地工作区 | `src/lib/migration.ts` 扩展 | 1pd |

M3-15 的边界：**只做导出，不做回传**。导出后云端记录保留只读，本地成为该项目的真相源。已有 `src/lib/migration.ts` 可扩展。

### E. UI（3 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M3-16 | 文件树组件（虚拟滚动，用已有 `@tanstack/react-virtual`） | `src/components/workspace/file-tree.tsx` | 1.5pd |
| M3-17 | 项目选择器 / 新建项目 / 打开文件夹 | `src/components/workspace/project-picker.tsx` | 1pd |
| M3-18 | 文件预览（复用现有 artifact 渲染器族） | `src/components/workspace/file-preview.tsx` | 0.5pd |

### F. 测试（2 pd）

| # | 任务 | 估时 |
|---|---|---|
| M3-19 | [workspace-format.md §11](../specs/workspace-format.md) 的 7 个用例 | 1pd |
| M3-20 | 压力：1 万文件目录的扫描与检索性能 | 1pd |

## 里程碑内的顺序建议

```
第 1 周   A 的 M3-01/02/03（遍历与监听）
第 2 周   A 的 M3-04/05（SQLite 与检索）+ B 起步
第 3 周   B 完成 + C（记忆）
第 4 周   D（迁移）+ E（UI）+ F（测试）
```

Rust 部分先行。前端在 Rust command 就绪前可以用 mock 并行开发 UI。

## 风险

| 风险 | 概率 | 应对 |
|---|---|---|
| 团队 Rust 经验不足 | 高 | 开工前预留 3pd 学习；只用成熟 crate，不自己造轮子；沙箱与索引先写测试再写实现 |
| sqlite-vec 在某平台加载失败 | 中 | 准备 BLOB + 应用侧计算的降级方案 |
| trigram 中文检索质量不够 | 中 | 先验收，不够再评估 ICU 或 jieba 预分词 |
| 监听在大目录上耗资源 | 中 | 限制监听深度；`.gitignore` 风格排除；超阈值退化重扫 |
| 云端老项目迁移丢数据 | 低 | 只导出不删除；迁移后云端记录保留 |

## 完成定义

- [x] Demo 能当着人跑通（含 Finder 里的外部改动被感知）
- [x] [workspace-format.md §11](../specs/workspace-format.md) 的 7 个用例全部通过
- [x] 中文文件名 + 中文内容检索有效
- [x] 删除 `index.db` 后重启能自动重建，无数据丢失
- [x] 1 万文件目录：首次索引 < 60s，增量更新 < 1s
- [x] `flags.localWorkspace = false` 时回退到云端项目模式
