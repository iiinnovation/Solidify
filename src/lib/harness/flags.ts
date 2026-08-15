/**
 * 特性开关
 *
 * 改造周期长达数月，主干必须始终可发布。所有在建能力挂在开关后面，
 * 开关关闭时走原有代码路径，行为与改造前完全一致。
 *
 * 约定（见 docs/specs/harness.md §3）：
 * - 新增能力默认 false，直到对应里程碑验收通过
 * - 业务代码一律通过本模块读取，不直接读 env 或 localStorage
 * - 一个开关在正式发布两个版本后应当移除，不要积累永久开关
 */

/** 各里程碑引入的能力开关 */
export interface FeatureFlags {
  /** M1 · 多轮 Agent 查询循环 */
  agentLoop: boolean
  /** M1 · 模型工具调用 */
  toolCalling: boolean
  /** M2 · Hook / 权限 / 账本 */
  harness: boolean
  /** M3 · 本地工作区与文件索引 */
  localWorkspace: boolean
  /** M3.5 · 统一三栏工作台与文件交付物 */
  workbenchV2: boolean
  /** M4 · 目录式 Skill 与渐进式披露 */
  skillV2: boolean
  /** M5 · PPTD 演示文稿引擎 */
  pptdEngine: boolean
  /** M6 · 子 Agent 并行协作 */
  subAgents: boolean
}

export type FeatureFlag = keyof FeatureFlags

const DEFAULT_FLAGS: Readonly<FeatureFlags> = Object.freeze({
  agentLoop: false,
  toolCalling: false,
  harness: false,
  localWorkspace: false,
  workbenchV2: false,
  skillV2: false,
  pptdEngine: false,
  subAgents: false,
})

export const FEATURE_FLAG_KEYS = Object.keys(DEFAULT_FLAGS) as FeatureFlag[]

/** 开发者本地覆盖的存储键 */
const STORAGE_KEY = 'solidify-feature-flags'

/** 构建期覆盖：VITE_FLAG_AGENT_LOOP=true */
function envKey(flag: FeatureFlag): string {
  return `VITE_FLAG_${flag.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`
}

function readEnvOverrides(): Partial<FeatureFlags> {
  const env = (import.meta as { env?: Record<string, unknown> }).env
  if (!env) return {}

  const overrides: Partial<FeatureFlags> = {}
  for (const flag of FEATURE_FLAG_KEYS) {
    const raw = env[envKey(flag)]
    if (raw === 'true' || raw === true) overrides[flag] = true
    else if (raw === 'false' || raw === false) overrides[flag] = false
  }
  return overrides
}

function readStorageOverrides(): Partial<FeatureFlags> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}

    const overrides: Partial<FeatureFlags> = {}
    for (const flag of FEATURE_FLAG_KEYS) {
      const value = (parsed as Record<string, unknown>)[flag]
      if (typeof value === 'boolean') overrides[flag] = value
    }
    return overrides
  } catch {
    // 存储损坏时按默认值运行，不影响启动
    return {}
  }
}

let cache: FeatureFlags | null = null

/**
 * 读取当前生效的全部开关
 *
 * 优先级：本地覆盖 > 构建期环境变量 > 默认值
 */
export function getFlags(): FeatureFlags {
  if (!cache) {
    cache = { ...DEFAULT_FLAGS, ...readEnvOverrides(), ...readStorageOverrides() }
    if (cache.skillV2) {
      cache.agentLoop = true
      cache.toolCalling = true
      cache.harness = true
    }
  }
  return cache
}

/** 某个能力是否启用 */
export function isEnabled(flag: FeatureFlag): boolean {
  return getFlags()[flag]
}

/**
 * 本地覆盖某个开关（供设置页的开发者选项使用）
 *
 * 传 null 表示清除覆盖，回落到环境变量/默认值。
 */
export function setFlagOverride(flag: FeatureFlag, value: boolean | null): void {
  if (typeof localStorage === 'undefined') return

  const current = readStorageOverrides()
  if (value === null) delete current[flag]
  else current[flag] = value

  if (Object.keys(current).length === 0) localStorage.removeItem(STORAGE_KEY)
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(current))

  resetFlagCache()
}

/** 清除全部本地覆盖 */
export function clearFlagOverrides(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(STORAGE_KEY)
  resetFlagCache()
}

/** 使缓存失效，下次读取重新计算（测试与覆盖变更后调用） */
export function resetFlagCache(): void {
  cache = null
}

/** 默认值快照，仅供测试与设置页展示用 */
export function getDefaultFlags(): FeatureFlags {
  return { ...DEFAULT_FLAGS }
}
