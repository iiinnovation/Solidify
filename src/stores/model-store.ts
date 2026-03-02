import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ApiFormat = 'openai' | 'anthropic'

export interface ModelProvider {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  modelId: string
  format: ApiFormat
  enabled: boolean
}

// 预设模板：用户可一键添加，只需填 Key
export const providerTemplates: Omit<ModelProvider, 'id' | 'apiKey' | 'enabled'>[] = [
  {
    name: 'DeepSeek Chat',
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    modelId: 'deepseek-chat',
    format: 'openai',
  },
  {
    name: 'DeepSeek Reasoner',
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    modelId: 'deepseek-reasoner',
    format: 'openai',
  },
  {
    name: 'Claude Sonnet',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    modelId: 'claude-sonnet-4-20250514',
    format: 'anthropic',
  },
  {
    name: 'Claude Haiku',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    modelId: 'claude-haiku-4-20250514',
    format: 'anthropic',
  },
  {
    name: 'GPT-4o',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    modelId: 'gpt-4o',
    format: 'openai',
  },
  {
    name: 'GPT-4o Mini',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    modelId: 'gpt-4o-mini',
    format: 'openai',
  },
  {
    name: '自定义 (OpenAI 兼容)',
    apiUrl: '',
    modelId: '',
    format: 'openai',
  },
  {
    name: '自定义 (Anthropic 兼容)',
    apiUrl: '',
    modelId: '',
    format: 'anthropic',
  },
]

function genId() {
  return `provider-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

interface ModelState {
  providers: ModelProvider[]
  activeProviderId: string | null
  addProvider: (provider: Omit<ModelProvider, 'id'>) => string
  updateProvider: (id: string, updates: Partial<Omit<ModelProvider, 'id'>>) => void
  removeProvider: (id: string) => void
  setActiveProvider: (id: string) => void
  getActiveProvider: () => ModelProvider | null
}

export const useModelStore = create<ModelState>()(
  persist(
    (set, get) => ({
      providers: [],
      activeProviderId: null,

      addProvider: (provider) => {
        const id = genId()
        set((state) => ({
          providers: [...state.providers, { ...provider, id }],
          activeProviderId: state.activeProviderId ?? id,
        }))
        return id
      },

      updateProvider: (id, updates) => {
        set((state) => ({
          providers: state.providers.map((p) =>
            p.id === id ? { ...p, ...updates } : p,
          ),
        }))
      },

      removeProvider: (id) => {
        set((state) => {
          const filtered = state.providers.filter((p) => p.id !== id)
          return {
            providers: filtered,
            activeProviderId:
              state.activeProviderId === id
                ? (filtered[0]?.id ?? null)
                : state.activeProviderId,
          }
        })
      },

      setActiveProvider: (id) => set({ activeProviderId: id }),

      getActiveProvider: () => {
        const { providers, activeProviderId } = get()
        return providers.find((p) => p.id === activeProviderId) ?? null
      },
    }),
    {
      name: 'solidify-model-config',
    },
  ),
)
