# PPTD reference index

These files are vendored from `Solidify-refs/open-kimi-ppt` and are the
authoritative knowledge base for presentation structure, styling and PPTD
semantics. Solidify's in-app tools own execution; upstream shell commands and
delivery paths are reference behavior, not commands to run inside a normal
`generate_pptd` turn.

## Read by task

- New presentation: use `slide-categories.md`, then exactly one matching file
  under `slide-categories/`, then one selected `design-system/*/design.md`.
- PPTD format, editing or compatibility: use the complete `pptd.md` together
  with `solidify-pptd-support.md`; never assume the full upstream surface is
  already implemented by the local parser/exporter.
- Fonts and multilingual typography: use `fonts.md`.
- Shapes, arrows and diagram vocabulary: use `shapes.md`.
- Poster, infographic or single-page visual: use `general-poster.md`.
- Full upstream capability and QA workflow: use `open-kimi-workflow.md`, while
  following the Solidify execution adapter in `SKILL.md` for available tools.

Use only the concrete paths listed above; do not invent resource paths. The
canonical bundled design-system path in Solidify is
`reference/design-system/<family>/<name>/design.md`.
