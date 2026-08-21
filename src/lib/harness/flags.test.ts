import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  getFlags,
  isEnabled,
  setFlagOverride,
  clearFlagOverrides,
  resetFlagCache,
  getDefaultFlags,
  FEATURE_FLAG_KEYS,
} from './flags'

describe('feature flags', () => {
  beforeEach(() => {
    localStorage.clear()
    resetFlagCache()
  })

  afterEach(() => {
    localStorage.clear()
    resetFlagCache()
  })

  it('默认使用目录式 Skill 及其 Agent 依赖', () => {
    expect(getFlags()).toEqual({
      agentLoop: true,
      toolCalling: true,
      harness: true,
      localWorkspace: false,
      workbenchV2: false,
      skillV2: true,
      pptdEngine: false,
      subAgents: false,
    })
  })

  it('覆盖了全部里程碑的开关', () => {
    expect(FEATURE_FLAG_KEYS).toEqual([
      'agentLoop',
      'toolCalling',
      'harness',
      'localWorkspace',
      'workbenchV2',
      'skillV2',
      'pptdEngine',
      'subAgents',
    ])
  })

  it('本地覆盖可以打开单个开关', () => {
    setFlagOverride('skillV2', false)
    setFlagOverride('agentLoop', true)

    expect(isEnabled('agentLoop')).toBe(true)
    expect(isEnabled('toolCalling')).toBe(false)
  })

  it('目录式 Skill 始终带上 Agent、工具调用和安全控制平面', () => {
    setFlagOverride('agentLoop', false)
    setFlagOverride('toolCalling', false)
    setFlagOverride('harness', false)
    setFlagOverride('skillV2', true)

    expect(getFlags()).toMatchObject({
      skillV2: true,
      agentLoop: true,
      toolCalling: true,
      harness: true,
    })
  })

  it('多 Agent 始终带上 Agent、工具调用和安全控制平面', () => {
    setFlagOverride('agentLoop', false)
    setFlagOverride('toolCalling', false)
    setFlagOverride('harness', false)
    setFlagOverride('subAgents', true)

    expect(getFlags()).toMatchObject({
      subAgents: true,
      agentLoop: true,
      toolCalling: true,
      harness: true,
    })
  })

  it('传 null 清除覆盖，回落到默认值', () => {
    setFlagOverride('skillV2', false)
    setFlagOverride('agentLoop', true)
    expect(isEnabled('agentLoop')).toBe(true)

    setFlagOverride('agentLoop', null)
    expect(isEnabled('agentLoop')).toBe(false)
  })

  it('清空全部覆盖后回到默认值', () => {
    setFlagOverride('agentLoop', true)
    setFlagOverride('pptdEngine', true)

    clearFlagOverrides()

    expect(getFlags()).toEqual(getDefaultFlags())
  })

  it('覆盖全部清除后不留残余存储', () => {
    setFlagOverride('harness', true)
    setFlagOverride('harness', null)

    expect(localStorage.getItem('solidify-feature-flags')).toBeNull()
  })

  it('存储内容损坏时回落到默认值，不抛异常', () => {
    localStorage.setItem('solidify-feature-flags', '{ 这不是 JSON')
    resetFlagCache()

    expect(() => getFlags()).not.toThrow()
    expect(getFlags()).toEqual(getDefaultFlags())
  })

  it('忽略存储中的未知键和非布尔值', () => {
    localStorage.setItem(
      'solidify-feature-flags',
      JSON.stringify({ agentLoop: 'yes', 未知开关: true, harness: true }),
    )
    resetFlagCache()

    const flags = getFlags()
    expect(flags.agentLoop).toBe(true) // 非布尔值被忽略，但默认 Skill V2 需要 Agent
    expect(flags.harness).toBe(true)
    expect('未知开关' in flags).toBe(false)
  })

  it('返回的对象不包含默认值以外的键', () => {
    expect(Object.keys(getFlags()).sort()).toEqual([...FEATURE_FLAG_KEYS].sort())
  })
})
