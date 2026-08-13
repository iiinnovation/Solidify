# Memory & State Management Design (De-Sensitized)

## Purpose
Manages short-term and long-term context to keep the agent coherent across sessions and interruptions.

## Components
- **Memdir**: In-memory directory for temporary memory (e.g., relevant snippets, logs).
- **State Management**: Immutable snapshots of session state.
- **Remote Support**: Handling for distributed or resumable sessions.
- **Prefetching**: Background loading of relevant memory before queries.

## Key Structures
```typescript
// Anonymized Memory State
interface MemoryState {
  shortTerm: Map<string, string>;  // Key-value snippets
  longTerm: VectorStore | similar; // For retrieval
  prefetchQueue: string[]; // Items to load
}

interface AppState {
  messages: Message[];
  toolUseContext: ToolUseContext;
  settings: Settings;
  // Session metadata
}
```

## Techniques
- Prefetch relevant memory on query start.
- Use immutable state updates to avoid race conditions.
- Support snapshotting for resumption after interruptions.

## Integration Tips
- Implement a simple in-memory memdir for your client.
- Add prefetch logic tied to your query engine.
- Use state snapshots for resume features.

*Useful for maintaining agent memory in your own implementation.*
