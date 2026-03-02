import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth-store'
import { supabaseConfigured } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export function LoginPage() {
  const navigate = useNavigate()
  const { user, signIn, signUp } = useAuthStore()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // 已登录用户跳转 /chat
  if (supabaseConfigured && user) {
    return <Navigate to="/chat" replace />
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const result = mode === 'login'
      ? await signIn(email, password)
      : await signUp(email, password)

    setLoading(false)

    if (result.error) {
      // 如果是注册成功但需要邮箱验证的提示，显示为成功消息
      if (mode === 'register' && result.error.includes('注册成功')) {
        setError('')
        setMode('login')
        setEmail('')
        setPassword('')
        // 可以在这里显示一个成功提示
        return
      }
      setError(result.error)
      return
    }

    if (mode === 'register') {
      setError('')
      // 注册成功后切换到登录模式
      setMode('login')
      setEmail('')
      setPassword('')
      return
    }

    navigate('/chat', { replace: true })
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-base p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-text-primary">Solidify</h1>
          <p className="mt-1 text-sm text-text-tertiary">AI 交付工作台</p>
        </div>

        {/* Supabase 未配置提示 */}
        {!supabaseConfigured && (
          <div className="rounded-lg border border-border-light bg-surface p-4 text-center text-sm text-text-secondary">
            Supabase 未配置，请在 <code className="rounded bg-surface-hover px-1.5 py-0.5 text-xs">.env</code> 中设置{' '}
            <code className="rounded bg-surface-hover px-1.5 py-0.5 text-xs">VITE_SUPABASE_URL</code> 和{' '}
            <code className="rounded bg-surface-hover px-1.5 py-0.5 text-xs">VITE_SUPABASE_ANON_KEY</code> 后使用登录功能。
          </div>
        )}

        {/* 登录/注册表单 */}
        {supabaseConfigured && (
          <form onSubmit={handleSubmit} className="rounded-lg border border-border-light bg-surface p-6">
            <h2 className="mb-4 text-lg font-semibold text-text-primary">
              {mode === 'login' ? '登录' : '注册'}
            </h2>

            {error && (
              <div className="mb-4 rounded-md bg-error/10 px-3 py-2 text-sm text-error">
                {error}
              </div>
            )}

            <div className="space-y-3">
              <input
                type="email"
                placeholder="邮箱"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
                className={cn(
                  'w-full rounded-xl border border-border bg-surface px-4 py-2.5 text-sm text-text-primary',
                  'placeholder:text-text-quaternary outline-none transition-all',
                  'focus:border-border-focus focus:shadow-[0_0_0_3px_rgba(212,145,94,0.1)]',
                  'disabled:opacity-60'
                )}
              />
              <input
                type="password"
                placeholder="密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
                minLength={6}
                className={cn(
                  'w-full rounded-xl border border-border bg-surface px-4 py-2.5 text-sm text-text-primary',
                  'placeholder:text-text-quaternary outline-none transition-all',
                  'focus:border-border-focus focus:shadow-[0_0_0_3px_rgba(212,145,94,0.1)]',
                  'disabled:opacity-60'
                )}
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-4 w-full"
            >
              {loading && <Loader2 size={16} className="animate-spin" />}
              {mode === 'login' ? '登录' : '注册'}
            </Button>

            <p className="mt-4 text-center text-sm text-text-tertiary">
              {mode === 'login' ? (
                <>
                  还没有账号？{' '}
                  <button
                    type="button"
                    className="text-text-link hover:underline"
                    onClick={() => { setMode('register'); setError('') }}
                  >
                    注册
                  </button>
                </>
              ) : (
                <>
                  已有账号？{' '}
                  <button
                    type="button"
                    className="text-text-link hover:underline"
                    onClick={() => { setMode('login'); setError('') }}
                  >
                    登录
                  </button>
                </>
              )}
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
