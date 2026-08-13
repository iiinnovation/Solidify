# Core Technology Extraction from Restored Project

## Overview
The restored_project directory contains a large TypeScript codebase implementing a production-grade AI Agent runtime framework. It is designed as a secure, pluggable runtime environment for LLM-based agents, with strong emphasis on safety, extensibility, and control plane engineering.

The project supports both CLI and GUI modes (using React + Ink for terminal UI), and includes components for query processing, tool execution, memory management, plugins, and remote sessions.

**Key Goal of Extraction**: Extract the core architectural concepts and non-sensitive code patterns while anonymizing any references to specific AI providers (e.g., replace "Claude", "Anthropic", "claudeAi" with placeholders like `[[AI_PROVIDER]]` to facilitate integration into your own client.

## Core Architecture Layers

### 1. AI Interaction Engine (The "Brain")
- **Files**: `src/QueryEngine.ts`, `src/query.ts`, `src/main.tsx`
- **Purpose**: Core loop that manages user queries, AI model interactions, tool calls, and response generation.
- **Key Techniques**:
  - Async generator pipeline for streaming responses and backpressure control (prevents memory issues during fast model output).
  - Tombstoning mechanism for orphaned messages to handle errors gracefully without crashing the session.
  - `using` keyword for automatic resource cleanup to prevent memory leaks during long-running loops (e.g., Ctrl+C interruptions).
  - Session state management with immutable contexts for tools and permissions.
- **Anonymized Core Flow** (from query.ts and QueryEngine.ts):
  ```
  // High-level flow (pseudocode based on extraction):
  while (true) {
    // Process user input
    const context = buildToolUseContext(state);
    // Call AI model with system prompt + user message
    const response = await callModel({
      messages: [...systemInitMessages, ...userMessages],
      tools: toolsList,
      tool_choice: "auto",
    });
    // Extract tool calls if present
    if (hasToolCalls(response)) {
      const toolResults = await executeTools(toolCalls, context);
      // Yield tool results back to model
      yield { type: 'tool_result', results: toolResults };
    } else {
      // Yield final response
      yield { type: 'message', content: response.content };
    }
    // Handle interruptions, fallbacks, etc.
  }
  ```
- **Memory Management**: Prefetching relevant memory, long-term memory via memdir, remote session support.

### 2. Tool & MCP System (The "Limbs")
- **Files**: `src/Tool.ts`, `src/tools.ts`, `src/services/mcp/*`
- **Purpose**: Standardized interface for tools that agents can use. Supports structured input/output schemas, permissions, and MCP (Model Context Protocol?) for secure tool invocation.
- **Key Concepts**:
  - Tool definitions with names, descriptions, input schemas.
  - Synthetic output tools for non-interactive actions.
  - Permission checks before execution.
  - MCP for standardized agent-tool communication.
- **Anonymized Example** (from Tool.ts):
  ```typescript
  // Interface definition (anonymized)
  export interface Tool {
    name: string;
    description: string;
    inputSchema: JSONSchema;
    execute: (input: ToolInput, context: ToolUseContext) => Promise<ToolResult>;
    // Additional metadata for permissions, visibility, etc.
  }
  ```

### 3. Harness Engineering (The "Armor" - Safety & Control Plane)
- **Files**: `src/entrypoints/`, `src/utils/*`, `src/hooks/`, `src/services/policyLimits/`, `src/settings/`
- **Purpose**: The most complex part - provides safety rails, configuration, observability, and control for the runtime. Ensures the agent doesn't perform dangerous actions.
- **Key Components**:
  - Hooks system for lifecycle interception (AOP-style).
  - Permissions and classifiers for human-AI interaction safety.
  - Feature gates and environment-based configuration.
  - Runtime control plane for initialization, updates, remote management.
  - Error handling, telemetry, and fallback strategies.
- **Engineering Practices**:
  - Dead code elimination via feature flags.
  - Lazy loading to avoid circular dependencies.
  - Structured logging and usage tracking.

### 4. Extensibility & Ecosystem
- **Files**: `src/plugins/`, `src/hooks/`, `src/skills/`, `src/components/`
- **Purpose**: Plugin and hook system for adding features without modifying core.
- **Key Features**:
  - Dynamic plugin loading.
  - Hook registration for events (e.g., before/after tool calls, settings changes).
  - Bundled skills and custom agent definitions.

### 5. Supporting Systems
- **Memory**: `src/memdir/` for short-term and long-term memory.
- **State**: `src/state/`, `src/bootstrap/`
- **UI/CLI**: `src/ink/`, `src/dialogLaunchers.tsx`, `src/replLauncher.tsx`
- **Other**: Vendor directory for native modules (audio, image processing, URL handling).

## Recommendations for Integration into Your Own Client
1. **Extract the Interaction Engine**: Focus on adapting the async query loop and tombstoning/backpressure techniques to your AI client's query handler. This makes the agent robust to interruptions and unstable model responses.
2. **Tool System**: Implement a similar Tool interface with schema validation and permission checks. Use MCP-like protocol if you need standardized tool communication.
3. **Harness**: Build safety layers using hooks, permissions, and feature flags. This is the most reusable engineering pattern.
4. **Anonymization**: In your version, replace all `claude*`, `anthropic*` references with `[[AI_PROVIDER]]` or similar. Update any hardcoded URLs, API keys placeholders, etc.
5. **Tech Stack**: TypeScript, Bun for bundling (if applicable), React for UI, Ink for CLI. Dependencies include lodash-es, chalk, @commander-js, etc. (check node_modules for full list).

## Next Steps
- Review the learning docs in `/Users/apple/Desktop/claude/Claude_learing/` for deeper details (e.g., 01_ai_interaction_engine.md, 05_harness_architecture.md).
- If you need code from specific files extracted with more details, provide file names or modules.
- I can help create a skeleton structure for your client based on this.

This extraction focuses on reusable patterns while removing sensitive Claude-specific details.
