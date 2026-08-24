# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- No unreleased changes yet.

## [2.0.0-beta.1] - 2026-08-24

### Added
- Local-first workspaces with file indexing, workspace-owned conversations, deliverables, and version history.
- Multi-turn Agent runtime with native tool calling, loop guards, approvals, run ledgers, and snapshots.
- Context compiler with explicit token budgets, tool-result deduplication, large-result handles, and tool-pair-safe trimming.
- Directory-based Skill runtime with automatic routing, progressive disclosure, bundled references, and tool allowlists.
- Ten built-in delivery Skills, including Draw.io diagrams and the PPTD presentation pipeline.
- Attachment resources for PDF, DOCX, Markdown, text, CSV, and image inputs.
- Background chat runs that continue when users navigate to or create another conversation.
- Optional restricted sub-Agent execution with shared cancellation and token budgets.
- Workspace inspector, on-demand Artifact preview, and PPTD-to-PPTX export.

### Changed
- Repositioned Solidify from a chat-and-Artifact tool into a local-first AI delivery workbench.
- Replaced legacy inline Skill prompts with compiled Skill resources.
- Rebuilt model transport around Provider-native OpenAI and Anthropic payloads.
- Moved workspace retrieval into untrusted user-role context instead of the system prompt.
- Compacted model request and response bodies out of persisted run ledgers.

### Deprecated
- Legacy stored `skillSystemPrompt` values remain readable for migration but are ignored by new runs.

### Removed
- Legacy inline presentation Skill execution path.

### Fixed
- Streaming recovery, attachment persistence, model relay validation, PPTD generation resilience, and cross-conversation run isolation.

### Security
- Added workspace boundary guards, monotonic approval policy, authenticated model relay checks, and provider host allowlisting.

## [0.1.0] - 2025-02-19

### Added
- Initial project setup
- Basic chat interface with AI streaming
- Artifact panel with multiple renderers
- Project and conversation management
- Supabase backend integration
- Authentication system
- Usage tracking
- Search functionality
- Hotkey system
- Theme toggle
