const mediaDataCache = new WeakMap<Uint8Array, string>()

export function pptdMediaDataUrl(value: string | Uint8Array | undefined, path = ''): string | undefined {
  if (typeof value === 'string') return isSafeImageDataUrl(value) ? value : undefined
  if (!(value instanceof Uint8Array)) return undefined
  const mime = detectSafeMime(value, path)
  if (!mime) return undefined
  const cached = mediaDataCache.get(value)
  if (cached) return cached
  if (typeof btoa === 'undefined') return undefined
  let binary = ''
  for (let offset = 0; offset < value.length; offset += 0x8000) binary += String.fromCharCode(...value.subarray(offset, Math.min(value.length, offset + 0x8000)))
  const result = `data:${mime};base64,${btoa(binary)}`
  mediaDataCache.set(value, result)
  return result
}

/**
 * pptxgenjs currently brings image-size transitively. Keep unsupported and
 * parser-hostile formats out of the export boundary (ICNS/JXL/HEIF), rather
 * than passing arbitrary model-provided bytes to that dependency.
 */
function detectSafeMime(value: Uint8Array, path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase()
  if (value.length >= 8 && value.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])) return 'image/png'
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return 'image/jpeg'
  if (value.length >= 6) {
    const header = new TextDecoder().decode(value.slice(0, 6))
    if (header === 'GIF89a' || header === 'GIF87a') return 'image/gif'
  }
  if (value.length >= 12 && new TextDecoder().decode(value.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(value.slice(8, 12)) === 'WEBP') return 'image/webp'
  if (extension === 'svg' && new TextDecoder().decode(value.slice(0, 512)).trimStart().startsWith('<')) return 'image/svg+xml'
  return undefined
}

function isSafeImageDataUrl(value: string): boolean {
  const match = value.match(/^data:(image\/(?:png|jpe?g|gif|webp|svg\+xml))((?:;[^,]*)?),(.*)$/is)
  if (!match) return false
  const [, declaredMime, metadata, payload] = match
  try {
    const binary = /;base64/i.test(metadata)
      ? atob(payload)
      : decodeURIComponent(payload)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const extension = declaredMime.toLowerCase().includes('svg') ? 'svg' : ''
    return detectSafeMime(bytes, extension) === normalizeMime(declaredMime)
  } catch {
    return false
  }
}

function normalizeMime(value: string): string {
  return value.toLowerCase().replace('image/jpg', 'image/jpeg')
}
