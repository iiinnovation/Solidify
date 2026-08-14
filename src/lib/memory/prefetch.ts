import type { Message } from '@/lib/engine/types'
import type { MemoryState } from './types'

/**
 * Per-fragment character cap. Handles exist because a tool result exceeded 8KB;
 * returning a whole stored body here would re-inject the exact payload the
 * handle mechanism just truncated.
 */
const FRAGMENT_LIMIT = 800

export async function prefetchMemory(messages: readonly Message[], memory: MemoryState): Promise<string | null> {
  const query = [...messages].reverse().find((message) => message.role === 'user')
  if (!query) return null
  const text = typeof query.content === 'string'
    ? query.content
    : query.content.filter((part) => part.type === 'text').map((part) => part.type === 'text' ? part.text : '').join('\n')
  if (!text.trim()) return null
  const fragments = await memory.search(text.trim(), 5)
  if (fragments.length === 0) return null
  return fragments.map((fragment) => `- [${fragment.source}] ${clip(fragment.content)}`).join('\n')
}

function clip(content: string): string {
  const chars = [...content]
  return chars.length > FRAGMENT_LIMIT ? `${chars.slice(0, FRAGMENT_LIMIT).join('')}…` : content
}
