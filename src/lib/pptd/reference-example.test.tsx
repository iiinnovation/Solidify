import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { parsePptdProject } from './parse'
import { PptdRenderer } from './renderer'
import { validatePptdProject } from './validate'
import { exportPptdAsPptx } from './to-pptx'

const exampleRoot = resolve(process.cwd(), '../Solidify-refs/open-kimi-ppt/example/dji-pocket4')

describe.skipIf(!existsSync(exampleRoot))('open-kimi-ppt reference compatibility', () => {
  it('parses, validates, renders and exports every page in the complete reference deck', async () => {
    const manifest = readFileSync(resolve(exampleRoot, 'dji-pocket4.pptd'), 'utf8')
    const metadata = parseYaml(manifest) as { pages: string[] }
    const pages = Object.fromEntries(metadata.pages.map((pagePath) => [pagePath, readFileSync(resolve(exampleRoot, pagePath), 'utf8')]))
    const media = Object.fromEntries(readdirSync(resolve(exampleRoot, 'media')).map((file) => [`media/${file}`, new Uint8Array(readFileSync(resolve(exampleRoot, 'media', file)))]))
    const project = parsePptdProject({ manifest, pages, media })
    expect(project.pages).toHaveLength(18)
    expect(validatePptdProject(project).errors).toEqual([])
    for (const pageIndex of project.pages.keys()) {
      const view = render(<PptdRenderer project={project} pageIndex={pageIndex} />)
      expect(view.container.querySelector(`[data-pptd-page="${pageIndex}"]`)).toBeTruthy()
      view.unmount()
    }
    const exported = await exportPptdAsPptx(project)
    expect(exported.blob.size).toBeGreaterThan(100_000)
    if (process.env.M5_EXPORT_REFERENCE === 'true') writeFileSync('/private/tmp/solidify-m5-reference.pptx', new Uint8Array(await exported.blob.arrayBuffer()))
  })
})
