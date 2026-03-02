import { useState, useCallback, useMemo } from 'react'
import { type Skill } from '@/lib/skills'
import { useSkillStore } from '@/stores/skill-store'

export function useSkillPalette() {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [activeSkill, setActiveSkill] = useState<Skill | null>(null)

  const getAllSkills = useSkillStore((s) => s.getAllSkills)
  const allSkills = getAllSkills()

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
    []
  )

  const clearSkill = useCallback(() => {
    setActiveSkill(null)
  }, [])

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
    filteredSkills,
    handleInputChange,
    selectSkill,
    clearSkill,
    closePalette,
    handleKeyDown,
  }
}
