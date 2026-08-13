import type { Tool } from '../types'
import { failure, success } from './helpers'

interface ReadHandleInput {
  handle: string
  offset?: number
  limit?: number
}

const DEFAULT_LIMIT = 8000
const MAX_CHUNK_BYTES = 8000

export const readHandleTool: Tool<ReadHandleInput> = {
  name: 'read_handle',
  description: '分块读取先前因内容过大而保存的工具结果。仅在结果中出现 handle 时使用；如仍有内容，使用返回的 nextOffset 继续读取。',
  inputSchema: {
    type: 'object',
    properties: {
      handle: { type: 'string', minLength: 1 },
      offset: { type: 'number', minimum: 0 },
      limit: { type: 'number', minimum: 1, maximum: DEFAULT_LIMIT },
    },
    required: ['handle'],
  },
  readOnly: true,
  concurrencySafe: true,
  destructive: false,
  requiresConfirmation: false,
  availability: 'always',
  permissions: [],
  async execute(input, ctx, signal) {
    if (signal.aborted) return failure('runtime', '句柄读取已中断', true)
    const content = await ctx.memory.retrieve(input.handle)
    if (content === null) {
      return failure('not_found', `句柄不存在或已过期：${input.handle}`, true)
    }

    const offset = input.offset ?? 0
    const limit = input.limit ?? DEFAULT_LIMIT
    const { chunk, count, total } = sliceChunk(content, offset, limit)
    const nextOffset = offset + count < total ? offset + count : undefined

    return success(chunk, {
      handle: input.handle,
      offset,
      nextOffset,
      total,
    })
  },
  renderCall: (input) => `读取句柄 ${input.handle}（从 ${input.offset ?? 0} 开始）`,
}

function sliceChunk(content: string, offset: number, limit: number) {
  const encoder = new TextEncoder()
  const selected: string[] = []
  let total = 0
  let bytes = 0
  let full = false

  for (const character of content) {
    if (!full && total >= offset && selected.length < limit) {
      const characterBytes = encoder.encode(character).byteLength
      if (bytes + characterBytes <= MAX_CHUNK_BYTES) {
        selected.push(character)
        bytes += characterBytes
      } else {
        full = true
      }
    }
    total++
  }

  return { chunk: selected.join(''), count: selected.length, total }
}
