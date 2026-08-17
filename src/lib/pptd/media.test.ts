import { describe, expect, it } from 'vitest'
import { pptdMediaDataUrl } from './media'

describe('PPTD media', () => {
  it('converts local byte resources to browser-safe data URLs', () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
    expect(pptdMediaDataUrl(bytes, 'media/pixel.png')).toMatch(/^data:image\/png;base64,/)
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
    expect(pptdMediaDataUrl(dataUrl, 'media/pixel.png')).toBe(dataUrl)
  })

  it('rejects unsupported image formats before pptxgenjs can inspect them', () => {
    const icns = Uint8Array.from([0x69, 0x63, 0x6e, 0x73, 0, 0, 0, 0])
    expect(pptdMediaDataUrl(icns, 'media/hostile.icns')).toBeUndefined()
    expect(pptdMediaDataUrl('data:application/octet-stream;base64,AA==', 'media/blob')).toBeUndefined()
    expect(pptdMediaDataUrl('data:image/png;base64,aWNucwAAAAA=', 'media/fake.png')).toBeUndefined()
  })
})
