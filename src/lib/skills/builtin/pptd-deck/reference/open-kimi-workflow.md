> Solidify adaptation note: this file keeps the upstream design and QA
> principles that remain valid inside the app. External commands, network
> services, filesystem paths and dual-delivery promises are intentionally
> removed. The parent `SKILL.md` and the local `generate_pptd` tool own
> execution, validation, preview and artifact delivery.

# PPTD production workflow

The design references cover creating, editing, replicating and reviewing
presentations. Solidify runs the supported subset in the local PPTD engine;
it does not delegate work to an upstream editor or exporter.

## Before generation

1. Determine purpose, audience, input type, page count and design direction.
2. Use the user material as the source of truth; do not expand with external search.
3. For a new deck, select one scenario reference and one compatible design system.
4. For an edit or replication, preserve the requested structure and change only the
   requested scope. Ask only questions that materially change the result.

## Generation and review

1. Let `generate_pptd` build the outline, pages, source index and artifact in one
   bounded pipeline call. Do not handwrite page YAML or wrap the returned artifact.
2. Respect `reference/pptd.md` and `reference/solidify-pptd-support.md`; fields
   outside the local support matrix must not be emitted.
3. Review structure, bounds, text overflow, contrast, hierarchy and source coverage.
   Use visual preview only when the app exposes it; otherwise perform the local
   structural checks and report that visual review was unavailable.
4. Prefer a finite repair pass with concrete validation errors over full regeneration.

## Delivery boundaries

- The chat delivers the single `type="slides"` artifact produced by Solidify.
- Do not claim unsupported PPTX features such as animations, embedded fonts or
  external editor compatibility. Use the local support reference as the boundary.
- Keep user media and source IDs self-contained in the artifact; never expose
  private attachment text in diagnostics or instructions.