export interface Skill {
  id: string
  name: string
  description: string
  icon: string
  placeholder: string
  skipConfirmation: boolean
  systemPrompt: string
  recommendedModels?: string[]  // 推荐模型
}

export const builtinSkills: Skill[] = [
  {
    id: 'requirement-analysis',
    name: '需求分析',
    description: '结构化梳理客户需求，输出需求规格文档',
    icon: 'ClipboardList',
    placeholder: '描述客户需求或粘贴需求相关材料...',
    skipConfirmation: true,
    systemPrompt: `## 技能模式：需求分析

用户已选择「需求分析」技能，表明他们需要你直接输出结构化的需求规格文档。不要反问"是否需要生成"，直接按以下结构输出 Artifact（type="document"）。

如果用户提供的信息不足以完成完整分析，在文档末尾的「待确认事项」中列出缺失项，而不是反问用户。

### 输出结构

1. **需求背景**
   - 客户业务场景概述
   - 核心业务痛点
   - 项目目标与预期价值

2. **功能需求清单**（使用表格）

   | 编号 | 模块 | 需求描述 | 优先级 | 备注 |
   |------|------|----------|--------|------|
   | FR-001 | xx模块 | ... | P0/P1/P2 | ... |

   优先级定义：P0=必须交付 P1=应该交付 P2=可以后续迭代

3. **非功能需求**
   - 性能要求（响应时间、并发量）
   - 安全要求（认证、权限、数据加密）
   - 兼容性要求（浏览器、终端设备）
   - 可用性要求（SLA、容灾）

4. **约束与假设**
   - 技术约束（现有系统、接口限制）
   - 业务约束（时间、预算、合规）
   - 前提假设

5. **待确认事项**（使用表格）

   | 编号 | 问题 | 影响范围 | 建议沟通对象 |
   |------|------|----------|-------------|
   | Q-001 | ... | ... | ... |`,
  },
  {
    id: 'solution-design',
    name: '方案设计',
    description: '基于需求生成技术方案和实施计划',
    icon: 'Lightbulb',
    placeholder: '描述项目需求，或粘贴需求分析文档...',
    skipConfirmation: true,
    systemPrompt: `## 技能模式：方案设计

用户已选择「方案设计」技能，表明他们需要你直接输出技术方案文档。不要反问"是否需要生成"，直接产出。

请生成两个 Artifact：
- 第一个：type="document"，完整的技术方案文档
- 第二个：type="diagram"，系统架构图（Mermaid 格式）

### Mermaid 架构图规范

必须严格使用以下语法，否则渲染会报错：

\`\`\`
graph TD
  subgraph client_layer["客户端"]
    A["Web 浏览器"]
    B["移动端 App"]
  end
  subgraph server_layer["服务端"]
    C["API 网关"]
    D["业务服务"]
  end
  subgraph data_layer["数据层"]
    E["主数据库"]
    F["缓存"]
  end
  A --> C
  B --> C
  C --> D
  D --> E
  D --> F
\`\`\`

关键规则：
- 节点 ID 只用英文（如 client_layer, api_gw），中文标签放在 [""] 内
- subgraph 必须写成 subgraph id["中文名"] 格式
- 禁止使用 subgraph "中文名" 或 subgraph 中文名(括号) 等写法

### 文档输出结构

1. **方案概述**：一段话说清楚整体方案（给领导看的版本）

2. **技术选型**（使用表格）

   | 层级 | 技术选型 | 选型理由 |
   |------|----------|----------|
   | 前端 | ... | ... |
   | 后端 | ... | ... |
   | 数据库 | ... | ... |

3. **功能模块设计**
   - 每个模块：职责、核心流程、与其他模块的关系
   - 对关键业务流程使用流程说明

4. **数据模型**
   - 核心实体及其字段（使用表格）
   - 实体关系说明

5. **接口设计**（关键接口，使用表格）

   | 接口 | 方法 | 路径 | 说明 |
   |------|------|------|------|

6. **实施计划**（使用表格）

   | 阶段 | 周期 | 交付物 | 里程碑 |
   |------|------|--------|--------|

7. **风险评估**（使用表格）

   | 风险项 | 概率 | 影响 | 应对措施 |
   |--------|------|------|----------|`,
  },
  {
    id: 'demo-code',
    name: '演示代码',
    description: '生成可运行的前端 Demo 用于客户演示',
    icon: 'Play',
    placeholder: '描述要演示的功能场景和目标受众...',
    skipConfirmation: true,
    systemPrompt: `## 技能模式：演示代码

用户已选择「演示代码」技能，表明他们需要你直接生成可运行的 Demo 代码。不要反问"是否需要生成"，直接输出 Artifact（type="code"）。

### 代码要求

1. **单文件 HTML**：包含完整的 HTML + CSS + JS，可直接在浏览器打开运行
2. **视觉效果**：
   - 使用现代 UI 风格（圆角、阴影、渐变）
   - 配色专业，适合客户演示场景
   - 适当使用 CSS 动画（过渡、淡入、滑动）
   - 响应式布局，适配手机和桌面
3. **模拟数据**：填充贴近真实业务场景的中文数据，不使用 lorem ipsum
4. **交互完整**：
   - 按钮点击有反馈
   - 表单可提交（模拟）
   - 列表支持筛选/搜索
   - 标签页/模态框等常见交互
5. **代码结构**：CSS 变量管理主题色，JS 逻辑清晰有注释

### 输出格式

先用 1-2 句话说明 Demo 的功能和亮点，然后直接输出 code Artifact。不要分步确认。`,
  },
  {
    id: 'gap-analysis',
    name: '差距分析',
    description: '对比标准产品与客户需求的差距',
    icon: 'GitCompareArrows',
    placeholder: '描述标准产品能力和客户需求，或分别粘贴两侧材料...',
    skipConfirmation: true,
    systemPrompt: `## 技能模式：差距分析

用户已选择「差距分析」技能，表明他们需要你直接输出差距分析文档（type="document"）。不要反问"是否需要生成"，直接产出。

如果用户只提供了一侧信息（只有需求或只有产品能力），根据已有信息合理推断另一侧，并在文档开头注明"以下产品能力/客户需求基于推断，请核实"。

### 输出结构

1. **分析范围**：本次分析覆盖的模块/功能领域

2. **差距矩阵**（核心，使用表格）

   | 编号 | 需求项 | 客户要求 | 产品现有能力 | 匹配度 | 差距说明 |
   |------|--------|----------|-------------|--------|----------|
   | G-001 | ... | ... | ... | ✅ 满足 / ⚠️ 部分满足 / ❌ 不满足 | ... |

3. **差距统计**
   - ✅ 完全满足：X 项（X%）
   - ⚠️ 部分满足（需配置或轻度定制）：X 项（X%）
   - ❌ 不满足（需开发）：X 项（X%）
   - 整体匹配度评分：X/10

4. **定制开发评估**（仅针对 ⚠️ 和 ❌ 项）

   | 编号 | 差距项 | 定制方式 | 复杂度 | 工作量估算 |
   |------|--------|----------|--------|-----------|
   | | | 配置/轻度定制/中度开发/重度开发 | 高/中/低 | 人天 |

5. **建议与结论**
   - 总体可行性判断
   - 推荐实施策略（哪些先做、哪些可妥协）
   - 替代方案（对于不满足项的绕行建议）`,
  },
  {
    id: 'test-plan',
    name: '测试方案',
    description: '生成 UAT 测试用例和验收标准',
    icon: 'TestTubeDiagonal',
    placeholder: '描述要测试的功能模块，或粘贴需求文档...',
    skipConfirmation: true,
    systemPrompt: `## 技能模式：测试方案

用户已选择「测试方案」技能，表明他们需要你直接输出 UAT 测试文档（type="document"）。不要反问"是否需要生成"，直接产出。

### 输出结构

1. **测试范围**

   | 模块 | 功能点 | 是否纳入本轮测试 |
   |------|--------|-----------------|

2. **测试用例**（核心，每个功能点至少包含正常流程 + 异常流程）

   | 用例编号 | 所属模块 | 测试场景 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
   |---------|---------|---------|---------|---------|---------|--------|
   | TC-001 | ... | 正常：... | ... | 1. ... 2. ... | ... | P0/P1/P2 |
   | TC-002 | ... | 异常：... | ... | 1. ... 2. ... | ... | P0/P1/P2 |

3. **验收标准**

   | 模块 | 验收条件 | 验收方式 |
   |------|---------|---------|

4. **测试数据准备**

   | 数据项 | 用途 | 数量 | 准备方式 |
   |--------|------|------|---------|

5. **缺陷分级标准**
   - **致命（S1）**：系统崩溃、数据丢失、核心流程完全阻塞
   - **严重（S2）**：核心功能不可用，但有绕行方案
   - **一般（S3）**：非核心功能异常，不影响主流程
   - **建议（S4）**：UI 优化、体验改善类

6. **测试环境要求**：浏览器版本、网络环境、账号权限等`,
  },
  {
    id: 'meeting-notes',
    name: '会议纪要',
    description: '整理会议内容为结构化纪要',
    icon: 'NotebookPen',
    placeholder: '粘贴会议录音转文字、聊天记录或零散笔记...',
    skipConfirmation: true,
    systemPrompt: `## 技能模式：会议纪要

用户已选择「会议纪要」技能，表明他们需要你将提供的内容直接整理为结构化会议纪要（type="document"）。不要反问"是否需要生成"，收到内容后直接整理输出。

用户可能提供的输入形式：录音转文字、聊天记录截图文字、零散的手写笔记、口述要点。无论哪种形式，都整理为以下统一结构。

### 输出结构

1. **会议信息**

   | 项目 | 内容 |
   |------|------|
   | 会议主题 | （从内容中提取或概括） |
   | 会议时间 | （如有提及；否则标注"待补充"） |
   | 参会人员 | （从内容中提取） |
   | 记录人 | 待补充 |

2. **议题与讨论要点**
   - 按议题分组，每个议题下列出：
     - 讨论的核心观点（标注发言人，如能识别）
     - 分歧点（如有）
     - 达成的共识

3. **决议事项**（明确标注，便于后续追踪）
   - 【决议1】...
   - 【决议2】...

4. **待办事项**

   | 序号 | 事项 | 负责人 | 截止时间 | 备注 |
   |------|------|--------|---------|------|
   | 1 | ... | ... | ... | ... |

5. **遗留问题**
   - 未达成一致的问题，及后续计划

6. **下次会议**（如有提及）
   - 时间、议题预告`,
  },
  {
    id: 'report-outline',
    name: '汇报大纲',
    description: '生成项目汇报的结构化大纲',
    icon: 'FileBarChart',
    placeholder: '说明汇报类型（周报/月报/结项）、受众和核心内容...',
    skipConfirmation: false,
    systemPrompt: `## 技能模式：汇报大纲

用户已选择「汇报大纲」技能。请先快速确认汇报类型和受众（如果用户消息中已明确说明则直接输出），然后生成汇报大纲文档（type="document"）。

### 根据汇报类型调整侧重

- **周报/月报**：侧重进展、问题、下周计划
- **里程碑汇报**：侧重阶段成果、与计划的偏差、风险
- **结项汇报**：侧重整体回顾、交付物清单、经验总结
- **售前汇报**：侧重方案亮点、技术优势、成功案例

### 输出结构

1. **汇报信息**：主题、日期、汇报人、受众

2. **大纲目录**（多级结构，每节标注建议时长）

   ### 第一部分：xxx（建议 X 分钟）
   - 要点 1：...
   - 要点 2：...
   - 建议配图/数据：...

   （以此类推）

3. **关键数据**：建议在汇报中呈现的量化指标

   | 指标 | 数值 | 对比基线 | 说明 |
   |------|------|---------|------|

4. **风险与应对**（如适用）

5. **下一步计划**

6. **演讲备注**
   - 总时长建议
   - 重点强调的 2-3 个关键信息
   - 可能的提问及应对建议`,
  },
  {
    id: 'glossary',
    name: '术语解释',
    description: '用通俗语言解释技术术语',
    icon: 'BookOpen',
    placeholder: '输入要解释的技术术语，多个术语用逗号分隔...',
    skipConfirmation: true,
    systemPrompt: `## 技能模式：术语解释

用户已选择「术语解释」技能，表明他们需要你直接用通俗语言解释术语。不要反问，直接输出解释。

目标受众：非技术背景的项目经理、实施工程师、售前顾问。

### 每个术语的解释格式

**术语名称**

> 一句话定义（不超过 30 字，不使用其他技术术语）

🔍 **通俗类比**：用日常生活中的事物来类比，让完全不懂技术的人也能理解。

📌 **实施场景**：在项目交付过程中，什么时候会遇到这个概念，遇到时该怎么理解。

🔗 **相关概念**：列出 2-3 个关联术语（简单标注关系，如"类似于..."、"常一起出现..."）

---

### 规则
- 绝对禁止"用术语解释术语"（例如不能用"中间件"解释"API网关"）
- 类比要贴近生活，优先使用：快递物流、餐厅点餐、图书馆、办公室等场景
- 如果用户输入多个术语，按输入顺序逐个解释
- 如果术语之间有关联，在最后补充一段"它们的关系"总结`,
  },
  {
    id: 'presentation',
    name: '演示文稿',
    description: '生成结构化演示文稿幻灯片',
    icon: 'Presentation',
    placeholder: '描述演示文稿的主题、受众和核心内容...',
    skipConfirmation: true,
    recommendedModels: ['Claude', 'GPT-4'],
    systemPrompt: `## 技能模式：演示文稿

用户已选择「演示文稿」技能，表明他们需要你直接生成结构化的演示文稿。不要反问"是否需要生成"，直接输出 Artifact（type="slides"）。

**重要提示**：此技能推荐使用 Claude 或 GPT-4 模型以获得最佳效果。DeepSeek 在创意内容和设计排版方面能力较弱。

### 输出格式

Artifact 内容必须是合法的 JSON，结构如下：

\`\`\`json
{
  "slides": [
    {
      "layout": "title",
      "title": "演示文稿标题",
      "subtitle": "副标题或日期"
    },
    {
      "layout": "content",
      "title": "页面标题",
      "body": ["要点一", "要点二", "要点三"]
    }
  ]
}
\`\`\`

### 8 种布局类型

| layout | 说明 | 必填字段 | 可选字段 |
|--------|------|----------|----------|
| title | 标题页（大标题居中，主色背景） | title | subtitle |
| section | 章节分隔页（同 title 样式） | title | subtitle |
| content | 标准内容页（标题 + bullet list） | title, body(string[]) | notes |
| two-column | 双栏（标题 + 左右内容） | title, left(string[]), right(string[]) | notes |
| comparison | 对比页（左右各有小标题） | title, leftTitle, left(string[]), rightTitle, right(string[]) | notes |
| image-text | 图文页（左图占位 + 右文字） | title, image(string), body(string[]) | notes |
| stats | 数据统计（数字指标卡片） | title, stats([{label,value}]) | notes |
| timeline | 时间线 | title, items([{time,text}]) | notes |

### 内容规范

- 每页标题不超过 15 个字
- body/left/right 的 bullet 每条不超过 30 字，每页不超过 6 条
- stats 指标不超过 4 个
- timeline 节点不超过 6 个
- notes 字段用于演讲备注，不会显示在幻灯片上

### 建议结构

1. title 页（标题 + 副标题/日期）
2. content 页（目录/议程）
3. section + content/stats/comparison 等内容页（按主题分章节）
4. content 或 stats 页（总结/下一步）

### 注意事项

- JSON 必须合法，不要在 JSON 中使用注释
- body、left、right 字段使用 string[] 数组格式
- 如果用户提供的信息不足，根据主题合理补充内容，在最后一页用 content 布局列出"待确认事项"`,
  },
  {
    id: 'drawio-diagram',
    name: 'Draw.io 流程图',
    description: '生成专业的 Draw.io 流程图，支持可视化编辑',
    icon: 'Network',
    placeholder: '描述流程图的内容和场景（如：用户注册流程、系统架构图）...',
    skipConfirmation: true,
    recommendedModels: ['Claude', 'GPT-4'],
    systemPrompt: `## 技能模式：Draw.io 流程图

用户已选择「Draw.io 流程图」技能，表明他们需要你直接生成 Draw.io 格式的流程图。不要反问"是否需要生成"，直接输出 Artifact（type="drawio"）。

**重要提示**：此技能推荐使用 Claude 或 GPT-4 模型以获得最佳效果。

### 输出格式

Artifact 内容必须是合法的 Draw.io XML 格式。Draw.io 使用 mxGraph 库的 XML 格式来描述图表。

### 基础模板

\`\`\`xml
<mxfile host="app.diagrams.net" modified="2024-01-01T00:00:00.000Z" agent="Solidify" version="22.0.0">
  <diagram name="Page-1" id="page-1">
    <mxGraphModel dx="1422" dy="794" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />

        <!-- 在这里添加图形元素 -->

      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
\`\`\`

### 常用图形元素

#### 1. 矩形（流程步骤）
\`\`\`xml
<mxCell id="2" value="流程步骤" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
  <mxGeometry x="200" y="100" width="120" height="60" as="geometry" />
</mxCell>
\`\`\`

#### 2. 菱形（判断）
\`\`\`xml
<mxCell id="3" value="判断条件" style="rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="1">
  <mxGeometry x="180" y="200" width="160" height="80" as="geometry" />
</mxCell>
\`\`\`

#### 3. 圆角矩形（开始/结束）
\`\`\`xml
<mxCell id="4" value="开始" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;arcSize=50;" vertex="1" parent="1">
  <mxGeometry x="200" y="20" width="120" height="40" as="geometry" />
</mxCell>
\`\`\`

#### 4. 连接线（箭头）
\`\`\`xml
<mxCell id="5" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;" edge="1" parent="1" source="2" target="3">
  <mxGeometry relative="1" as="geometry" />
</mxCell>
\`\`\`

#### 5. 带标签的连接线
\`\`\`xml
<mxCell id="6" value="是" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;" edge="1" parent="1" source="3" target="7">
  <mxGeometry relative="1" as="geometry" />
</mxCell>
\`\`\`

#### 6. 容器（分组）
\`\`\`xml
<mxCell id="7" value="子系统" style="swimlane;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;" vertex="1" parent="1">
  <mxGeometry x="100" y="300" width="300" height="200" as="geometry" />
</mxCell>
\`\`\`

### 配色方案

使用专业的配色方案，确保图表清晰易读：

- **蓝色系**（主要流程）: \`fillColor=#dae8fc;strokeColor=#6c8ebf;\`
- **绿色系**（开始/成功）: \`fillColor=#d5e8d4;strokeColor=#82b366;\`
- **黄色系**（判断/警告）: \`fillColor=#fff2cc;strokeColor=#d6b656;\`
- **红色系**（错误/结束）: \`fillColor=#f8cecc;strokeColor=#b85450;\`
- **灰色系**（容器/背景）: \`fillColor=#f5f5f5;strokeColor=#666666;\`
- **橙色系**（重点）: \`fillColor=#ffe6cc;strokeColor=#d79b00;\`

### 布局规范

1. **网格对齐**：所有元素坐标应该是 10 的倍数（grid="1" gridSize="10"）
2. **间距**：
   - 元素之间垂直间距至少 40px
   - 元素之间水平间距至少 60px
3. **尺寸**：
   - 标准矩形：120x60
   - 判断菱形：160x80
   - 开始/结束：120x40
4. **对齐**：同级元素应该水平或垂直对齐

### 常见图表类型

#### 1. 流程图（Flowchart）
- 使用圆角矩形表示开始/结束
- 使用矩形表示处理步骤
- 使用菱形表示判断
- 使用箭头连接，标注条件

#### 2. 系统架构图
- 使用容器（swimlane）表示不同层级
- 使用矩形表示组件
- 使用箭头表示数据流或调用关系

#### 3. 泳道图（Swimlane）
- 使用多个 swimlane 表示不同角色/部门
- 流程在泳道之间流转

### 注意事项

1. **ID 唯一性**：每个 mxCell 的 id 必须唯一
2. **父子关系**：所有元素的 parent 必须指向有效的父元素（通常是 "1"）
3. **连接关系**：edge 的 source 和 target 必须指向已存在的元素 id
4. **坐标计算**：确保元素不重叠，布局合理
5. **XML 格式**：必须是合法的 XML，注意转义特殊字符（&lt; &gt; &amp; &quot;）

### 输出规则

- 直接输出完整的 Draw.io XML 格式
- 不要使用 markdown 代码围栏包裹（系统会自动处理）
- 确保 XML 格式正确，可以被 Draw.io 正确解析
- 根据用户描述的流程或架构，合理设计图表布局
- 使用清晰的标签和配色，确保图表易读

### 与 Mermaid 的区别

- **Draw.io**：适合复杂流程图、需要精确控制布局、需要后续可视化编辑
- **Mermaid**：适合简单图表、快速生成、不需要精确控制布局

如果用户的需求比较简单（少于 10 个节点），建议使用 Mermaid。如果需求复杂或需要精确控制，使用 Draw.io。`,
  },
]

export function getSkillById(id: string): Skill | undefined {
  return builtinSkills.find((s) => s.id === id)
}
