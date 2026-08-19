import { useState, useCallback, useMemo } from 'react'
import { type Skill } from '@/lib/skills'
import { useSkillStore } from '@/stores/skill-store'
import { composerDraftKey, useUIStore } from '@/stores/ui-store'
import { useSkillRegistry } from './use-skill-registry'
import { isEnabled } from '@/lib/harness/flags'

export function useSkillPalette(conversationId?: string) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const draftKey = composerDraftKey(conversationId)
  const activeSkill = useUIStore((s) => s.composerDrafts[draftKey]?.skill ?? null)
  const setComposerDraft = useUIStore((s) => s.setComposerDraft)
  const setActiveSkill = useCallback((skill: Skill | null) => {
    setComposerDraft(conversationId, { skill })
  }, [conversationId, setComposerDraft])

  const getAllSkills = useSkillStore((s) => s.getAllSkills)
  const registryState = useSkillRegistry()
  const directorySkills = useMemo(() => registryState.skills.map((skill) => ({
        id: skill.name,
        name: skill.displayName ?? skill.name,
        description: skill.description,
        icon: skill.icon ?? 'Sparkles',
        placeholder: skill.placeholder ?? '',
        skipConfirmation: skill.skipConfirmation ?? true,
        systemPrompt: '',
        recommendedModels: skill.recommendedModels,
      })), [registryState.skills])
  const allSkills = isEnabled('skillV2') ? directorySkills : getAllSkills()

  const filteredSkills = useMemo(() => {
    if (!query) return allSkills
    const q = query.toLowerCase()
    return allSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
    )
  }, [query, allSkills])

  // Detect `/` trigger in input and extract query text
  const handleInputChange = useCallback(
    (value: string, cursorPos: number) => {
      // Find the last `/` before cursor that is at start or after whitespace
      const textBeforeCursor = value.slice(0, cursorPos)
      const slashMatch = textBeforeCursor.match(/(^|\s)\/([\S]*)$/)

      if (slashMatch) {
        const q = slashMatch[2] // chars after `/`
        setQuery(q)
        setSelectedIndex(0)
        setIsOpen(true)
      } else {
        if (isOpen) {
          setIsOpen(false)
          setQuery('')
        }
      }
    },
    [isOpen]
  )

  const selectSkill = useCallback(
    (skill: Skill, currentInput: string, cursorPos: number): string => {
      setActiveSkill(skill)
      setIsOpen(false)
      setQuery('')
      setSelectedIndex(0)

      // Strip the `/query` part from input
      const textBeforeCursor = currentInput.slice(0, cursorPos)
      const textAfterCursor = currentInput.slice(cursorPos)
      const cleaned = textBeforeCursor.replace(/(^|\s)\/[\S]*$/, '$1')
      return (cleaned + textAfterCursor).trim()
    },
    [setActiveSkill]
  )

  const clearSkill = useCallback(() => {
    setActiveSkill(null)
  }, [setActiveSkill])

  const closePalette = useCallback(() => {
    setIsOpen(false)
    setQuery('')
    setSelectedIndex(0)
  }, [])

  // Returns true if the event was handled (caller should preventDefault)
  const handleKeyDown = useCallback(
    (
      e: React.KeyboardEvent,
      currentInput: string,
      cursorPos: number
    ): { handled: boolean; newInput?: string } => {
      if (!isOpen) return { handled: false }

      if (e.key === 'ArrowDown') {
        setSelectedIndex((prev) =>
          prev < filteredSkills.length - 1 ? prev + 1 : 0
        )
        return { handled: true }
      }

      if (e.key === 'ArrowUp') {
        setSelectedIndex((prev) =>
          prev > 0 ? prev - 1 : filteredSkills.length - 1
        )
        return { handled: true }
      }

      if (e.key === 'Enter') {
        if (filteredSkills.length > 0) {
          const skill = filteredSkills[selectedIndex]
          const newInput = selectSkill(skill, currentInput, cursorPos)
          return { handled: true, newInput }
        }
        return { handled: true }
      }

      if (e.key === 'Escape') {
        closePalette()
        return { handled: true }
      }

      return { handled: false }
    },
    [isOpen, filteredSkills, selectedIndex, selectSkill, closePalette]
  )

  return {
    isOpen,
    query,
    selectedIndex,
    activeSkill,
    registry: registryState.registry,
    registryLoading: registryState.loading,
    registryErrors: registryState.errors,
    filteredSkills,
    handleInputChange,
    selectSkill,
    clearSkill,
    closePalette,
    handleKeyDown,
  }
}
