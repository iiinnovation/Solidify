const mediaDataCache = new WeakMap<Uint8Array, string>()

export function pptdMediaDataUrl(value: string | Uint8Array | undefined, path = ''): string | undefined {
  if (typeof value === 'string') return value
  if (!(value instanceof Uint8Array)) return undefined
  const cached = mediaDataCache.get(value)
  if (cached) return cached
  if (typeof btoa === 'undefined') return undefined
  let binary = ''
  for (let offset = 0; offset < value.length; offset += 0x8000) binary += String.fromCharCode(...value.subarray(offset, Math.min(value.length, offset + 0x8000)))
  const extension = path.split('.').pop()?.toLowerCase()
  const mime = extension === 'png' ? 'image/png' : extension === 'svg' ? 'image/svg+xml' : extension === 'webp' ? 'image/webp' : extension === 'gif' ? 'image/gif' : 'image/jpeg'
  const result = `data:${mime};base64,${btoa(binary)}`
  mediaDataCache.set(value, result)
  return result
}
