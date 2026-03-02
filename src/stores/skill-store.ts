import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { builtinSkills, type Skill } from '@/lib/skills'

export interface CustomSkill extends Skill {
  isCustom: true
}

function genId() {
  // Use crypto.randomUUID() for guaranteed uniqueness
  // Fallback to timestamp + random for older browsers
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `skill-${crypto.randomUUID()}`
  }
  return `skill-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

interface SkillState {
  customSkills: CustomSkill[]
  addSkill: (skill: Omit<CustomSkill, 'id' | 'isCustom'>) => string
  updateSkill: (id: string, updates: Partial<Omit<CustomSkill, 'id' | 'isCustom'>>) => void
  removeSkill: (id: string) => void
  getAllSkills: () => Skill[]
}

export const useSkillStore = create<SkillState>()(
  persist(
    (set, get) => ({
      customSkills: [],

      addSkill: (skill) => {
        const id = genId()
        const newSkill: CustomSkill = { ...skill, id, isCustom: true }
        set((state) => ({
          customSkills: [...state.customSkills, newSkill],
        }))
        return id
      },

      updateSkill: (id, updates) => {
        set((state) => ({
          customSkills: state.customSkills.map((s) =>
            s.id === id ? { ...s, ...updates } : s,
          ),
        }))
      },

      removeSkill: (id) => {
        set((state) => ({
          customSkills: state.customSkills.filter((s) => s.id !== id),
        }))
      },

      getAllSkills: () => {
        const { customSkills } = get()
        return [...builtinSkills, ...customSkills]
      },
    }),
    {
      name: 'solidify-custom-skills',
    },
  ),
)
