import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkdownRenderer } from './markdown-renderer'

describe('MarkdownRenderer code blocks', () => {
  it('renders untyped business examples with the light surface', () => {
    const { container } = render(<MarkdownRenderer content={'## 输出\n\n```\n【AI检查结果】\n✅ 已收集\n```'} />)

    const example = container.querySelector('[data-code-kind="example"]')
    const code = example?.querySelector('code')
    expect(example).not.toBeNull()
    expect(container.querySelector('[data-code-kind="technical"]')).toBeNull()
    expect(code?.classList.contains('font-sans')).toBe(true)
    expect(code?.classList.contains('text-inherit')).toBe(true)
  })

  it('keeps explicitly typed source code in the technical code surface', () => {
    const { container } = render(<MarkdownRenderer content={'```ts\nconst ready = true\n```'} />)

    expect(container.querySelector('[data-code-kind="technical"]')).not.toBeNull()
  })
})
