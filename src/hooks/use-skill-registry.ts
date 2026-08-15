import { useEffect, useMemo, useState } from 'react'
import { isEnabled } from '@/lib/harness/flags'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { ensureUserSkillsRoot, SkillLoader } from '@/lib/skills/loader'
import { SkillRegistry } from '@/lib/skills/registry'
import type { SkillLoadError, SkillMetadata } from '@/lib/skills/types'
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
        const metadata = result.skills.map((skill) => skill.metadata)
        setAllSkills(metadata)
        setSkills(metadata.filter((skill) => !getDisabledSkillNames().has(skill.name)))
        setErrors(result.errors)
      })
      const result = await created.reload()
      if (cancelled) {
        unsubscribe()
        return
      }
      setRegistry(created)
      const metadata = result.skills.map((skill) => skill.metadata)
      setAllSkills(metadata)
      setSkills(metadata.filter((skill) => !getDisabledSkillNames().has(skill.name)))
      setErrors(result.errors)
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
  }, [key, enabled, workspaceRoot])

  const refresh = async () => {
    if (!registry) return
    const result = await registry.reload()
    const metadata = result.skills.map((skill) => skill.metadata)
    setAllSkills(metadata)
    setSkills(metadata.filter((skill) => !getDisabledSkillNames().has(skill.name)))
    setErrors(result.errors)
  }

  return enabled
    ? { registry, skills, allSkills, errors, loading, refresh }
    : { registry: null, skills: [], allSkills: [], errors: [], loading: false, refresh: async () => undefined }
}
