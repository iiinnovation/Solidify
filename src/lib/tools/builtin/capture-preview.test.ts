import { describe, expect, it, beforeEach } from 'vitest'
import { capturePreviewTool, diagnosePreviewTarget, selectPreviewElement } from './capture-preview'
import type { ToolUseContext } from '../types'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('selectPreviewElement', () => {
  it('selects a PPTD page whether the root is the page or a project wrapper', () => {
    document.body.innerHTML = '<div id="root"><div data-pptd-page="0"></div><div data-pptd-page="1"></div></div>'
    const root = document.querySelector('#root') as HTMLElement
    expect(selectPreviewElement(root, 1)?.getAttribute('data-pptd-page')).toBe('1')
    expect(selectPreviewElement(root, 2)).toBeNull()
    expect(selectPreviewElement(root.querySelector('[data-pptd-page="1"]') as HTMLElement, 1)?.getAttribute('data-pptd-page')).toBe('1')
  })
})

describe('diagnosePreviewTarget', () => {
  it('resolves the only rendered artifact when no id is given', () => {
    document.body.innerHTML = '<div data-artifact-content data-artifact-id="a1"></div>'

    const target = diagnosePreviewTarget(document, {})

    expect(target.kind).toBe('element')
  })

  it('reports an unrenderable panel as not correctable', () => {
    // The artifact panel is unmounted in workbench mode, and renders an empty
    // state before the run produces anything. Neither is fixable by retrying.
    const target = diagnosePreviewTarget(document, {})

    expect(target).toMatchObject({ kind: 'miss', correctable: false })
    expect(target.kind === 'miss' && target.message).toContain('预览面板未打开')
    expect(target.kind === 'miss' && target.message).toContain('不要再调用 capture_preview')
  })

  it('names the artifacts that are actually rendered when the id does not match', () => {
    document.body.innerHTML = '<div data-artifact-content data-artifact-id="shown"></div>'

    const target = diagnosePreviewTarget(document, { artifact_id: 'missing' })

    expect(target).toMatchObject({ kind: 'miss', correctable: true })
    expect(target.kind === 'miss' && target.message).toContain('shown')
  })

  it('tolerates an id containing CSS selector metacharacters', () => {
    document.body.innerHTML = '<div data-artifact-content data-artifact-id="a.b#c"></div>'

    expect(diagnosePreviewTarget(document, { artifact_id: 'a.b#c' }).kind).toBe('element')
  })

  it('reports an out-of-range page as correctable and states the page count', () => {
    document.body.innerHTML = '<div data-artifact-content><div data-pptd-page="0"></div><div data-pptd-page="1"></div></div>'

    const target = diagnosePreviewTarget(document, { page_index: 7 })

    expect(target).toMatchObject({ kind: 'miss', correctable: true })
    expect(target.kind === 'miss' && target.message).toContain('共 2 页')
  })

  it('reports page_index on a non-paginated artifact as not correctable', () => {
    document.body.innerHTML = '<div data-artifact-content><p>plain</p></div>'

    const target = diagnosePreviewTarget(document, { page_index: 0 })

    expect(target).toMatchObject({ kind: 'miss', correctable: false })
    expect(target.kind === 'miss' && target.message).toContain('不是分页内容')
  })

  it('selects the requested page inside the matching artifact', () => {
    document.body.innerHTML = [
      '<div data-artifact-content data-artifact-id="deck">',
      '<div data-pptd-page="0"></div><div data-pptd-page="1"></div>',
      '</div>',
    ].join('')

    const target = diagnosePreviewTarget(document, { artifact_id: 'deck', page_index: 1 })

    expect(target.kind === 'element' && target.element.getAttribute('data-pptd-page')).toBe('1')
  })
})

describe('capture_preview failure contract', () => {
  const ctx = {} as ToolUseContext

  it('marks an unrenderable panel as unrecoverable so the model stops retrying', async () => {
    const result = await capturePreviewTool.execute({}, ctx, new AbortController().signal)

    expect(result.success).toBe(false)
    expect(result.error).toMatchObject({ kind: 'not_found', recoverable: false })
  })

  it('keeps a bad page index recoverable so the model can correct its argument', async () => {
    document.body.innerHTML = '<div data-artifact-content><div data-pptd-page="0"></div></div>'

    const result = await capturePreviewTool.execute({ page_index: 4 }, ctx, new AbortController().signal)

    expect(result.error).toMatchObject({ kind: 'not_found', recoverable: true })
  })

  it('opts into the shared loop guard rather than the generic failure breaker', () => {
    expect(capturePreviewTool.loopGroup).toBe('artifact-capture')
  })
})
