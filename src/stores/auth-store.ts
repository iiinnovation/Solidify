import { create } from 'zustand'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import type { User, Session } from '@supabase/supabase-js'

interface AuthState {
  user: User | null
  session: Session | null
  loading: boolean
  initialized: boolean
  signIn: (email: string, password: string) => Promise<{ error?: string }>
  signUp: (email: string, password: string) => Promise<{ error?: string }>
  signOut: () => Promise<void>
  initialize: () => () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  session: null,
  loading: supabaseConfigured,
  initialized: !supabaseConfigured,

  signIn: async (email, password) => {
    if (!supabase) return { error: 'Supabase 未配置' }
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return { error: error.message }
    return {}
  },

  signUp: async (email, password) => {
    if (!supabase) return { error: 'Supabase 未配置' }
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          display_name: email.split('@')[0],
        },
      },
    })
    if (error) return { error: error.message }
    // 检查是否需要邮箱验证
    if (data.user && !data.session) {
      return { error: '注册成功！请检查邮箱并点击验证链接后登录。' }
    }
    return {}
  },

  signOut: async () => {
    if (!supabase) return
    await supabase.auth.signOut()
  },

  initialize: () => {
    if (!supabase) {
      set({ initialized: true, loading: false, user: null, session: null })
      return () => {}
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      set({
        session,
        user: session?.user ?? null,
        initialized: true,
        loading: false,
      })
    })

    return () => subscription.unsubscribe()
  },
}))
