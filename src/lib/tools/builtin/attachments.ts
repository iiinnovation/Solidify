import { attachmentSections, readAttachmentRange, searchAttachmentResources, type AttachmentResource } from '../../attachments/types'
import { failure, success } from './helpers'
import type { Tool } from '../types'

interface SearchAttachmentsInput { query: string; attachmentIds?: string[]; limit?: number }
interface ReadAttachmentInput { attachmentId: string; sectionId?: string; offset?: number; limit?: number }

function selected(resources: readonly AttachmentResource[] | undefined, ids?: readonly string[]): AttachmentResource[] {
  if (!resources) return []
  if (!ids || ids.length === 0) return [...resources]
  const allowed = new Set(ids)
  return resources.filter((resource) => allowed.has(resource.id))
}

function selectWithValidation(resources: readonly AttachmentResource[] | undefined, ids?: readonly string[]): { resources: AttachmentResource[]; missing: string[] } {
  if (!resources) return { resources: [], missing: [...(ids ?? [])] }
  if (!ids || ids.length === 0) return { resources: [...resources], missing: [] }
  const available = new Set(resources.map((resource) => resource.id))
  return {
    resources: selected(resources, ids),
    missing: ids.filter((id) => !available.has(id)),
  }
}

export const searchAttachmentsTool: Tool<SearchAttachmentsInput> = {
  name: 'search_attachments',
  description: 'Search user-uploaded attachments for relevant sections without loading whole files. Use before reading large documents.',
  loopGroup: 'attachment-retrieval',
  loopKey: 'search',
  replaySafe: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 500 },
      attachmentIds: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  readOnly: true,
  concurrencySafe: true,
  destructive: false,
  requiresConfirmation: false,
  availability: 'always',
  permissions: [],
  async execute(input, ctx) {
    const selection = selectWithValidation(ctx.attachments, input.attachmentIds)
    if (selection.missing.length > 0) return failure('not_found', `附件不存在或不属于当前运行：${selection.missing.join(', ')}`, true)
    const resources = selection.resources
    if (resources.length === 0) return failure('not_found', '当前运行没有可搜索的附件。', true)
    const hits = searchAttachmentResources(resources, input.query, input.limit)
    return success(
      hits.length > 0
        ? hits.map((hit) => `[${hit.name}${hit.sectionId ? `#${hit.sectionId}` : ''} ${hit.start}-${hit.end}]\n${hit.excerpt}`).join('\n\n')
        : '没有找到与查询匹配的附件内容。',
      { hits },
    )
  },
  renderCall: (input) => `搜索附件：${input.query}`,
}

export const readAttachmentTool: Tool<ReadAttachmentInput> = {
  name: 'read_attachment',
  description: 'Read a bounded section or range from a user-uploaded attachment. Use the attachment ID from the attachment manifest; do not use filesystem paths or result handles.',
  loopGroup: 'attachment-retrieval',
  loopKey: 'read',
  replaySafe: true,
  inputSchema: {
    type: 'object',
    properties: {
      attachmentId: { type: 'string', minLength: 1 },
      sectionId: { type: 'string', minLength: 1 },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 8000 },
    },
    required: ['attachmentId'],
    additionalProperties: false,
  },
  readOnly: true,
  concurrencySafe: true,
  destructive: false,
  requiresConfirmation: false,
  availability: 'always',
  permissions: [],
  async execute(input, ctx) {
    const resource = ctx.attachments?.find((candidate) => candidate.id === input.attachmentId)
    if (!resource) return failure('not_found', `附件不存在或不属于当前运行：${input.attachmentId}`, true)
    if (resource.text === undefined) return failure('runtime', `附件 ${resource.name} 没有可读取的文本内容。`, true)
    let offset = input.offset ?? 0
    let sectionEnd: number | undefined
    if (input.sectionId) {
      const section = attachmentSections(resource.text).find((candidate) => candidate.id === input.sectionId)
      if (!section) return failure('not_found', `附件 ${resource.name} 不存在章节 ${input.sectionId}。`, true)
      offset = Math.max(section.start, Math.min(input.offset ?? section.start, section.end))
      sectionEnd = section.end
    }
    const boundedLimit = sectionEnd === undefined
      ? input.limit
      : Math.min(input.limit ?? 8_000, Math.max(1, sectionEnd - offset))
    const chunk = readAttachmentRange(resource, offset, boundedLimit)
    if (sectionEnd !== undefined && chunk.nextOffset !== undefined && chunk.nextOffset >= sectionEnd) {
      chunk.nextOffset = undefined
    }
    return success(
      `[attachment:${resource.id}${input.sectionId ? `#${input.sectionId}` : ''} offset:${chunk.offset}]\n${chunk.text}`,
      { attachmentId: resource.id, sectionId: input.sectionId, offset: chunk.offset, nextOffset: chunk.nextOffset, total: chunk.total },
    )
  },
  renderCall: (input) => `读取附件 ${input.attachmentId}${input.sectionId ? `/${input.sectionId}` : ''}`,
}
