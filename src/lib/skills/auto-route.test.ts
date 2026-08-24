import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { routeSkillLocally, toRouteCandidates } from './auto-route'
import type { SkillMetadata } from './types'

const PPTD: SkillMetadata = {
  name: 'pptd-deck',
  version: '2.0.0',
  displayName: 'PPTD 演示文稿',
  description: '生成演示文稿；适用于 PPT、slide deck、汇报、课件、答辩任务',
}

const DRAWIO: SkillMetadata = {
  name: 'drawio-diagram',
  version: '1.0.0',
  description: '生成 Draw.io 流程图与架构图',
}

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('toRouteCandidates', () => {
  it('excludes skills the user disabled in settings', () => {
    localStorage.setItem('solidify-disabled-skills', JSON.stringify(['pptd-deck']))
    expect(toRouteCandidates([PPTD, DRAWIO]).map((candidate) => candidate.name)).toEqual(['drawio-diagram'])
  })

  it('keeps enabled metadata and bounds descriptions', () => {
    expect(toRouteCandidates([PPTD, DRAWIO])).toEqual([
      { name: 'pptd-deck', displayName: 'PPTD 演示文稿', description: PPTD.description },
      { name: 'drawio-diagram', description: DRAWIO.description },
    ])
    expect(toRouteCandidates([{ ...PPTD, description: 'x'.repeat(5_000) }])[0].description).toHaveLength(300)
  })
})

describe('routeSkillLocally', () => {
  it('routes unmistakable deliverable requests without a provider call', () => {
    expect(routeSkillLocally('请制作一份 6 页产品汇报 PPT', [PPTD, DRAWIO])).toBe('pptd-deck')
    expect(routeSkillLocally('请生成系统架构图', [PPTD, DRAWIO])).toBe('drawio-diagram')
    expect(routeSkillLocally('根据附件画一个架构图', [PPTD, DRAWIO])).toBe('drawio-diagram')
  })

  it('keeps ambiguous, discussion, negative, and disabled cases as ordinary chat', () => {
    expect(routeSkillLocally('你好', [PPTD, DRAWIO])).toBeUndefined()
    expect(routeSkillLocally('解释 PPT 设计中如何安排叙事节奏', [PPTD])).toBeUndefined()
    expect(routeSkillLocally('不要制作 PPT，只讨论叙事方法', [PPTD])).toBeUndefined()
    localStorage.setItem('solidify-disabled-skills', JSON.stringify(['pptd-deck']))
    expect(routeSkillLocally('请制作一份季度汇报 PPT', [PPTD])).toBeUndefined()
  })
})
