# Stream Parser

SSE (Server-Sent Events) stream parser for AI provider responses, supporting both text deltas and tool call increments.

## Features

- **Dual Provider Support**: OpenAI and Anthropic streaming formats
- **Text Streaming**: Incremental text content parsing
- **Tool Call Streaming**: Real-time tool use parsing with argument accumulation
- **Robust Buffer Management**: Handles incomplete chunks and line boundaries
- **Type-Safe Events**: Strongly typed event stream

## Usage

### Basic Text Streaming

```typescript
import { createStreamParser } from './stream-parser'

const parser = createStreamParser('openai')

// Parse SSE chunks as they arrive
const events = parser.parse(chunk)

for (const event of events) {
  if (event.type === 'text_delta') {
    console.log(event.text)
  }
}
```

### Tool Call Streaming

```typescript
const parser = createStreamParser('anthropic')

for await (const chunk of stream) {
  const events = parser.parse(chunk)
  
  for (const event of events) {
    switch (event.type) {
      case 'tool_call_start':
        console.log(`Starting tool: ${event.toolName}`)
        break
        
      case 'tool_call_delta':
        console.log(`Arguments chunk: ${event.argumentsDelta}`)
        break
        
      case 'tool_call_end':
        console.log(`Tool ${event.toolName} complete`)
        break
    }
  }
}

// Get completed tool calls
const toolCalls = getCompletedToolCalls(parser)
for (const call of toolCalls) {
  const args = parseToolArguments(call.arguments)
  console.log(`${call.name}(${JSON.stringify(args)})`)
}
```

## Event Types

### `text_delta`
Incremental text content from the AI response.

```typescript
{
  type: 'text_delta',
  text: string
}
```

### `tool_call_start`
A new tool call has started.

```typescript
{
  type: 'tool_call_start',
  toolCallId: string,
  toolName: string,
  toolIndex: number
}
```

### `tool_call_delta`
Incremental arguments for an ongoing tool call.

```typescript
{
  type: 'tool_call_delta',
  toolCallId: string,
  toolName: string,
  toolIndex: number,
  argumentsDelta: string
}
```

### `tool_call_end`
A tool call has finished streaming.

```typescript
{
  type: 'tool_call_end',
  toolCallId: string,
  toolName: string,
  toolIndex: number
}
```

### `message_done`
The entire message streaming is complete.

```typescript
{
  type: 'message_done'
}
```

### `error`
An error occurred during streaming.

```typescript
{
  type: 'error',
  error: {
    type: string,
    message: string
  }
}
```

## Provider Format Differences

### OpenAI
- Text: `choices[0].delta.content`
- Tool calls: `choices[0].delta.tool_calls[]` with incremental `function.arguments`
- Arguments arrive in chunks and must be accumulated by `index`
- Finish reason: `tool_calls` indicates tool invocation

### Anthropic
- Text: `content_block_delta` with `delta.type='text_delta'`
- Tool calls: Three-phase event stream:
  1. `content_block_start` with `type='tool_use'`
  2. `content_block_delta` with `delta.type='input_json_delta'`
  3. `content_block_stop`
- Arguments arrive as `partial_json` chunks
- Stop reason: `message_stop` or `message_delta.stop_reason`

## State Management

The parser maintains internal state for:
- **Buffer**: Incomplete SSE lines across chunks
- **Tool Calls**: Accumulated arguments for each tool call by index
- **Current Block**: Active content block tracking (Anthropic)

Reset state between messages:

```typescript
parser.reset()
```

## Implementation Notes

### Buffer Handling
The parser handles SSE line boundaries correctly:
- Accumulates incomplete lines in buffer
- Splits on `\n` and processes complete lines
- Retains last incomplete fragment for next chunk

### Tool Call Accumulation
- **OpenAI**: Uses `index` field to track multiple parallel tool calls
- **Anthropic**: Uses `index` from event and tracks current block context
- Arguments concatenated as strings, parsed after completion

### Error Resilience
- Invalid JSON in SSE data is logged and skipped
- Malformed tool call events won't crash the parser
- Error events are surfaced as typed events

## Testing

Run the comprehensive test suite:

```bash
npm test -- src/lib/engine/__tests__/stream-parser.test.ts
```

Tests cover:
- ✅ OpenAI text and tool streaming
- ✅ Anthropic text and tool streaming
- ✅ Multiple parallel tool calls
- ✅ Argument accumulation across chunks
- ✅ Buffer management for incomplete lines
- ✅ State reset
- ✅ Error handling

## See Also

- [M1-06 Task Spec](../../docs/phases/M1-agent-runtime.md#b-model-gateway-4-pd)
- [Agent Loop Spec](../../docs/specs/agent-loop.md)
- [Tool Interface Spec](../../docs/specs/tool-interface.md)
