import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth-store'
import { supabaseConfigured } from '@/lib/supabase'
import { Loader2 } from 'lucide-react'

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { initialized, loading, user } = useAuthStore()

  // Supabase 未配置 → 开发模式，不拦截
  if (!supabaseConfigured) {
    return <>{children}</>
  }

  // 等待 auth 初始化
  if (!initialized || loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-base">
        <Loader2 size={24} className="animate-spin text-text-tertiary" />
      </div>
    )
  }

  // 未登录 → 跳转登录页
  if (!user) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}
