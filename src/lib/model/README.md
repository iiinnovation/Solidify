# Model Provider Architecture

轻量级多模型提供商架构，支持 Anthropic、OpenAI、Gemini 等主流 LLM。

## 设计理念

**轻量、统一、可扩展** - 不依赖 LangChain 等重型框架，自己实现协议适配层。

### 为什么不用 LangChain？

- **过度抽象**：LangChain 提供了 Chain/Memory/Retriever 等大量概念，但我们只需要模型调用
- **强制数据结构**：必须使用它的 BaseMessage、Document 等类型
- **运行时开销**：插件化架构带来额外性能损耗
- **学习成本**：需要理解它的整套概念体系

### 我们的方案

**3 层架构**：
```
统一接口层 (types.ts)
    ↓
Provider 实现层 (anthropic.ts, openai.ts, gemini.ts)
    ↓
官方 SDK (@anthropic-ai/sdk, openai, @google/generative-ai)
```

**代码量**：~700 行（vs LangChain 数万行）

## 核心类型

### UnifiedMessage
统一的消息格式（内部标准），各 Provider 负责转换到各家 API 格式：

```typescript
interface UnifiedMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | UnifiedContent[]
}

type UnifiedContent = 
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
```

### CompletionRequest
统一的请求参数：

```typescript
interface CompletionRequest {
  model: string
  system: string
  messages: UnifiedMessage[]
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
  stream: true  // 我们只支持流式
}
```

### CompletionChunk
统一的流式响应块：

```typescript
type CompletionChunk =
  | { type: 'content_start' }
  | { type: 'content_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; delta: string }
  | { type: 'tool_call_end'; id: string; input: unknown }
  | { type: 'message_end'; usage?: TokenUsage }
  | { type: 'error'; error: ModelError }
```

`reasoning_delta` 只用于引擎识别模型活动和输出预算消耗。原始推理文本不得进入用户答案、UI 事件或持久化账本。

## Provider 接口

```typescript
interface ModelProvider {
  readonly name: string
  stream(request: CompletionRequest): AsyncGenerator<CompletionChunk>
  listModels?(): Promise<string[]>
}
```

每个 Provider 只需实现一个核心方法：`stream()`

## 使用示例

### 创建 Provider

```typescript
import { ProviderRegistry } from '@/lib/model'

const registry = new ProviderRegistry()

// 注册 Anthropic
const anthropicProvider = ProviderRegistry.createProvider('anthropic', {
  apiKey: process.env.ANTHROPIC_API_KEY!,
  timeout: 60000,
  maxRetries: 3,
})
registry.register('anthropic', anthropicProvider)

// 注册 OpenAI
const openaiProvider = ProviderRegistry.createProvider('openai', {
  apiKey: process.env.OPENAI_API_KEY!,
  timeout: 60000,
  maxRetries: 3,
})
registry.register('openai', openaiProvider)

// 支持自定义端点（中转服务）
const customProvider = ProviderRegistry.createProvider('anthropic', {
  apiKey: 'pk-xxx',
  baseURL: 'https://api.packycode.com/v1',  // 中转
})
```

### 调用模型

```typescript
import { streamModel } from '@/lib/engine'

// 在 Engine 中使用
for await (const chunk of streamModel(ctx)) {
  switch (chunk.type) {
    case 'content_delta':
      console.log(chunk.delta)
      break
    case 'tool_call_start':
      console.log(`Tool: ${chunk.name}`)
      break
    case 'message_end':
      console.log(`Tokens: ${chunk.usage?.totalTokens}`)
      break
  }
}
```

## 扩展新 Provider

添加新的模型提供商只需 3 步：

### 1. 安装 SDK
```bash
npm install new-provider-sdk
```

### 2. 实现 Provider
```typescript
// src/lib/model/newprovider.ts
import type { ModelProvider, CompletionRequest, CompletionChunk } from './types'

export class NewProvider implements ModelProvider {
  readonly name = 'newprovider'
  
  async *stream(request: CompletionRequest): AsyncGenerator<CompletionChunk> {
    // 1. 转换请求格式
    // 2. 调用 SDK
    // 3. 转换响应格式
  }
}
```

### 3. 注册到 Registry
```typescript
// src/lib/model/registry.ts
case 'newprovider':
  return new NewProvider(config)
```

## 优势总结

### 1. 轻量（最重要）
- 只依赖 3 个官方 SDK
- 总代码量 ~700 行
- 无中间层框架开销

### 2. 透明可控
- 每个字段转换逻辑清晰可见
- 调试时可以直接看实现
- 不会遇到"框架的坑"

### 3. Agent 场景优化
```typescript
// 可以添加 Agent 特有功能
type CompletionChunk = 
  | StandardChunk
  | { type: 'reasoning_delta'; delta: string }  // 仅供引擎聚合计量，不直接对用户展示
  | { type: 'tool_call_delta'; id: string; delta: string }  // 工具参数增量
```

### 4. 灵活的错误处理
```typescript
// 针对 Agent 场景定制重试策略
async *stream(request: CompletionRequest) {
  let retries = 0
  while (retries < this.maxRetries) {
    try {
      yield* this.streamInternal(request)
      break
    } catch (error) {
      if (this.shouldRetry(error)) {
        yield { type: 'system_message', message: 'Retrying...' }
        await this.exponentialBackoff(retries++)
      }
    }
  }
}
```

### 5. 支持自定义端点
```typescript
// 中转服务 / OpenAI 兼容端点
{
  provider: 'anthropic',
  baseURL: 'https://api.custom.com/v1',
  apiKey: 'custom-key'
}
```

### 6. 性能可控
```typescript
// 可以针对 Agent 多轮对话优化
class Provider {
  private messageCache = new LRUCache<string, Message>(100)
  // 缓存消息转换结果
}
```

## 未来扩展

- [x] OpenAI Provider 实现
- [ ] Gemini Provider 实现
- [ ] OpenAI-compatible 通用端点支持（Groq、Together 等）
- [ ] 流式中断/恢复支持
- [ ] 请求/响应缓存
- [ ] Token 计数优化
- [ ] 批量请求支持

## 支持的 Provider

### 1. Anthropic (Claude)

**模型:**
- `claude-opus-4` - 最强能力，复杂任务
- `claude-sonnet-4` - 平衡性能和速度
- `claude-haiku-4` - 快速、轻量级任务

**特性:**
- 原生流式支持
- 工具调用（流式）
- 视觉能力（图片输入）
- 超长上下文（200K tokens）

### 2. OpenAI (GPT)

**模型:**
- `gpt-4-turbo` - 最新 GPT-4 Turbo（支持视觉）
- `gpt-4` - 标准 GPT-4
- `gpt-4-32k` - 扩展上下文
- `gpt-3.5-turbo` - 快速、经济
- `o1-preview` - 推理模型
- `o1-mini` - 轻量级推理

**特性:**
- 原生流式支持
- 函数调用（工具使用）
- 视觉能力（图片输入）
- 超长上下文（128K tokens for turbo）

**Azure OpenAI 支持:**
```typescript
const azureProvider = new OpenAIProvider({
  apiKey: process.env.AZURE_OPENAI_KEY!,
  baseURL: 'https://your-resource.openai.azure.com/openai/deployments/your-deployment',
})
```

### 3. Google Gemini

**状态:** 即将支持

## 参考

- [Anthropic API Docs](https://docs.anthropic.com/en/api)
- [OpenAI API Docs](https://platform.openai.com/docs/api-reference)
- [Google AI SDK](https://ai.google.dev/api)
