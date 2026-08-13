# Implementation Recommendations (De-Sensitized)

## How to Adopt These Patterns
1. **Start Simple**: Implement the AI Interaction Engine first (use the pseudocode as a template).
2. **Build Tool Interface**: Create the Tool and ToolUseContext types.
3. **Add Harness**: Implement hooks and permissions layer early for safety.
4. **Memory**: Add basic in-memory storage tied to the query loop.
5. **Extensibility**: Add plugin/hook registration system.

## Tech Choices
- Use TypeScript for type safety.
- Async generators for streaming.
- Feature flags for conditional features.
- Immutable data structures where possible.

## De-Sensitization Checklist
- Replace all AI provider names with `[[AI_PROVIDER]]`.
- Remove any paths, URLs, or specific implementations.
- Keep pseudocode and interfaces generic.
- Add your own logging, UI, and error handling.

## Next Steps
- Copy the MD files into your client project.
- Implement the pseudocode in your preferred language/framework.
- Test the interaction loop with your own model calls.

All files are now available in `/Users/apple/Desktop/AGNET客户端/` for your use. You can reference them directly when building your client.

*Total core points extracted and de-sensitized.*
