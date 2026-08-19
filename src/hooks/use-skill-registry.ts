import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isEnabled } from '@/lib/harness/flags'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { ensureUserSkillsRoot, SkillLoader } from '@/lib/skills/loader'
import { SkillRegistry } from '@/lib/skills/registry'
import { clearChatSkillRuntimeCache } from '@/lib/engine/chat-context'
import type { SkillLoadError, SkillLoadResult, SkillMetadata } from '@/lib/skills/types'
import { getDisabledSkillNames } from '@/lib/skills/settings'

export interface SkillRegistryState {
  registry: SkillRegistry | null
  skills: SkillMetadata[]
  allSkills: SkillMetadata[]
  errors: SkillLoadError[]
  loading: boolean
  refresh: () => Promise<void>
}

/** React bridge for the filesystem-backed registry and its watcher. */
export function useSkillRegistry(): SkillRegistryState {
  const enabled = isEnabled('skillV2')
  const workspaceRoot = useWorkspaceStore((state) => state.workspaceRoot)
  const [registry, setRegistry] = useState<SkillRegistry | null>(null)
  const [skills, setSkills] = useState<SkillMetadata[]>([])
  const [allSkills, setAllSkills] = useState<SkillMetadata[]>([])
  const [errors, setErrors] = useState<SkillLoadError[]>([])
  const [loading, setLoading] = useState(enabled)
  const appliedRef = useRef<string | null>(null)

  /**
   * The user Skill root is polled, so most reloads return byte-identical
   * metadata. Publishing fresh array identities anyway re-rendered every
   * consumer — the chat panel included — on each poll.
   */
  const apply = useCallback((result: SkillLoadResult) => {
    const metadata = result.skills.map((skill) => skill.metadata)
    const disabled = getDisabledSkillNames()
    const signature = JSON.stringify([metadata, result.errors, [...disabled].sort()])
    if (signature === appliedRef.current) return
    appliedRef.current = signature
    clearChatSkillRuntimeCache()
    setAllSkills(metadata)
    setSkills(metadata.filter((skill) => !disabled.has(skill.name)))
    setErrors(result.errors)
  }, [])

  const key = useMemo(() => `${enabled}:${workspaceRoot ?? ''}`, [enabled, workspaceRoot])

  useEffect(() => {
    if (!enabled) {
      return
    }

    let cancelled = false
    let current: SkillRegistry | null = null
    let stopWatching: (() => void) | null = null
    void (async () => {
      const loader = new SkillLoader({ workspaceRoot, userSkillsRoot: await ensureUserSkillsRoot() })
      const created = new SkillRegistry(loader)
      current = created
      const unsubscribe = created.subscribe((result) => {
        if (cancelled) return
        apply(result)
      })
      const result = await created.reload()
      if (cancelled) {
        unsubscribe()
        return
      }
      setRegistry(created)
      apply(result)
      setLoading(false)
      stopWatching = await created.startWatching()
      if (cancelled) stopWatching()
    })().catch((error) => {
      if (!cancelled) {
        setErrors([{ path: 'skills', message: error instanceof Error ? error.message : String(error) }])
        setLoading(false)
      }
    })

    return () => {
      cancelled = true
      stopWatching?.()
      void current?.stopWatching()
    }
  }, [key, enabled, workspaceRoot, apply])

  const refresh = async () => {
    if (!registry) return
    apply(await registry.reload())
  }

  return enabled
    ? { registry, skills, allSkills, errors, loading, refresh }
    : { registry: null, skills: [], allSkills: [], errors: [], loading: false, refresh: async () => undefined }
}
