import { describe, expect, it } from 'vitest'
import { pptdMediaDataUrl } from './media'

describe('PPTD media', () => {
  it('converts local byte resources to browser-safe data URLs', () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
    expect(pptdMediaDataUrl(bytes, 'media/pixel.png')).toMatch(/^data:image\/png;base64,/)
  })
})
