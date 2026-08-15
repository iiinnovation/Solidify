import { describe, expect, it } from 'vitest'
import { parsePptdProject, PptdParseError } from './parse'
import { validatePptdProject } from './validate'

const manifest = `version: v2\ntitle: Demo\nsize: [960, 540]\ntheme:\n  colors:\n    bg: "#000000"\n    text: "#ffffff"\n    accent: "#ffcc00"\n  textStyles:\n    title: {fontSize: 36, color: "$text"}\npages:\n  - pages/01.page\n`
const page = `pageType: cover\nbackground: {type: solid, color: "$bg"}\nelements:\n  - elementId: title\n    elementType: text\n    bounds: [48, 40, 800, 100]\n    content:\n      fontSize: 36\n      color: "$accent"\n      text: "Hello"\n`

describe('PPTD parser and validator', () => {
  it('parses a multi-file project and expands theme tokens', () => {
    const project = parsePptdProject({ manifest, pages: { 'pages/01.page': page } })
    expect(project.pages[0].background?.color).toBe('#000000')
    expect(project.pages[0].elements[0].content?.color).toBe('#ffcc00')
    expect(project.theme.textStyles.title.color).toBe('#ffffff')
    expect(validatePptdProject(project).valid).toBe(true)
  })

  it('rejects unsafe page references and missing files', () => {
    expect(() => parsePptdProject({ manifest: manifest.replace('pages/01.page', '../secret.page'), pages: {} })).toThrow(PptdParseError)
    expect(() => parsePptdProject({ manifest, pages: {} })).toThrow(/缺少页面文件/)
  })

  it('reports bounds, missing media and duplicate ids', () => {
    const project = parsePptdProject({
      manifest,
      pages: { 'pages/01.page': `${page.replace('bounds: [48, 40, 800, 100]', 'bounds: [900, 500, 100, 100]')}\n  - elementId: title\n    elementType: image\n    bounds: [1, 1, 20, 20]\n    src: media/missing.png\n` },
    })
    const result = validatePptdProject(project)
    expect(result.errors.map((item) => item.code)).toEqual(expect.arrayContaining(['out-of-bounds', 'duplicate-element-id', 'missing-media']))
  })

  it('treats unresolved variables and text overlap as blocking errors', () => {
    const project = parsePptdProject({
      manifest,
      pages: { 'pages/01.page': `${page.replace('color: "$accent"', 'color: "$missing"').replace('bounds: [48, 40, 800, 100]', 'bounds: [48, 40, 800, 100]')}
  - elementId: subtitle
    elementType: text
    bounds: [100, 60, 200, 40]
    content: {text: Overlap}
` },
    })
    const result = validatePptdProject(project)
    expect(result.errors.map((item) => item.code)).toEqual(expect.arrayContaining(['undefined-token', 'text-overlap']))
  })
})
