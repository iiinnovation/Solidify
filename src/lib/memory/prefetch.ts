import type { Message } from '@/lib/engine/types'
import type { MemoryState } from './types'

export async function prefetchMemory(messages: readonly Message[], memory: MemoryState): Promise<string | null> {
  const query = [...messages].reverse().find((message) => message.role === 'user')
  if (!query) return null
  const text = typeof query.content === 'string'
    ? query.content
    : query.content.filter((part) => part.type === 'text').map((part) => part.type === 'text' ? part.text : '').join('\n')
  if (!text.trim()) return null
  const fragments = await memory.search(text.trim(), 5)
  if (fragments.length === 0) return null
  return `Relevant workspace memory:\n${fragments.map((fragment) => `- [${fragment.source}] ${fragment.content}`).join('\n')}`
}
