/** Local input replay only: no provider calls and no source contents in reports. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { expect, it } from 'vitest'
import { compileContext } from '../context-compiler'
import { createAttachmentResourceId, formatInlineAttachments } from '../../attachments/types'
import { compiledBuiltinSkills } from '../../skills/generated/manifest'
import type { QueryContext } from '../types'

it.runIf(Boolean(process.env.SOLIDIFY_DRAWIO_RECOVERY_FIXTURE))('replays a local large attachment through standard and recovery compilation', async () => {
  const path = process.env.SOLIDIFY_DRAWIO_RECOVERY_FIXTURE!
  expect(isAbsolute(path)).toBe(true)
  const bytes = readFileSync(path)
  const source = { name: basename(path), size: bytes.length, mimeType: 'text/markdown', text: bytes.toString('utf8') }
  const attachment = { ...source, id: createAttachmentResourceId(source) }
  const skill = compiledBuiltinSkills.find(skill => skill.metadata.name === 'drawio-diagram')!
  const context: QueryContext = {
    runId: 'local-inline-replay', conversationId: 'local-inline-replay', cwd: '/workspace',
    messages: [{ role: 'user', content: `根据附件绘制流程图。${formatInlineAttachments([attachment])}` }],
    tools: [], attachments: [attachment], attachmentMode: 'inline',
    skill: { metadata: skill.metadata, content: skill.coreInstructions, path: skill.path },
    memory: { store: async () => 'unused', retrieve: async () => null, search: async () => [], clear: async () => undefined },
    model: { provider: 'replay-only', model: 'deepseek-flash', contextWindow: 128_000 },
    limits: { maxTurns: 5, maxTokens: 100_000, maxOutputTokens: 8192, maxToolCalls: 10, toolTimeoutMs: 1000 },
    providerRegistry: { get: () => { throw new Error('Input replay must never call a provider') } } as never,
    signal: new AbortController().signal,
  }
  const standard = await compileContext(context)
  const recovery = await compileContext({ ...context, inputMode: 'compact_recovery' })
  expect(standard.stats.slots.attachmentTokens).toBeGreaterThan(6000)
  expect(recovery.stats.inlineRecovery!.resultTokens).toBeLessThanOrEqual(6000)
  expect(recovery.stats.finalHistoryTokens).toBeLessThan(standard.stats.finalHistoryTokens * 0.5)
  const recoveredText = recovery.messages.map(message => typeof message.content === 'string'
    ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')).join('\n')
  const headings = source.text.split(/\r?\n/).filter(line => /^(?:#{1,6}\s+|[一二三四五六七八九十百]+、|\d+(?:\.\d+){1,4}\s+)[^\n]{1,120}$/.test(line))
  const report = {
    scope: 'local-context-compilation-only; no model or diagram-quality validation',
    sourceSha256: createHash('sha256').update(bytes).digest('hex'), sourceBytes: bytes.length,
    model: context.model.model, maxOutputTokens: context.limits.maxOutputTokens,
    toolCount: 0, providerCalls: 0, standard: standard.stats, recovery: recovery.stats,
    numberedOrMarkdownHeadings: headings.length,
    retainedHeadingCount: headings.filter(heading => recoveredText.includes(heading)).length,
  }
  if (process.env.SOLIDIFY_DRAWIO_RECOVERY_REPORT) {
    const output = process.env.SOLIDIFY_DRAWIO_RECOVERY_REPORT
    expect(isAbsolute(output)).toBe(true)
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  }
  console.log(JSON.stringify(report))
})
