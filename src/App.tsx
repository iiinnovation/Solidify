import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { MainLayout } from '@/routes/layout'
import { ChatPage } from '@/routes/chat'
import { SettingsPage } from '@/routes/settings'
import { UsagePage } from '@/routes/usage'
import { TemplatesPage } from '@/routes/templates'
import { KnowledgePage } from '@/routes/knowledge'
import { LoginPage } from '@/routes/login'
import { AuthGuard } from '@/components/shared/auth-guard'
import { ErrorBoundary } from '@/components/shared/error-boundary'
import { ToastContainer } from '@/components/ui/toast'
import { HotkeyHelp, useHotkeyHelp } from '@/components/shared/hotkey-help'
import { SearchModal, useGlobalSearch } from '@/components/shared/search-modal'
import { useAuthStore } from '@/stores/auth-store'
import { queryClient } from '@/lib/query-client'
import { initThemeListener } from '@/lib/theme'

export default function App() {
  const initialize = useAuthStore((s) => s.initialize)
  const { open: helpOpen, closeHelp } = useHotkeyHelp()
  const { open: searchOpen, closeSearch } = useGlobalSearch()

  useEffect(() => {
    const cleanup = initialize()
    return cleanup
  }, [initialize])

  useEffect(() => {
    const cleanup = initThemeListener()
    return cleanup
  }, [])

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ToastContainer />
          <HotkeyHelp open={helpOpen} onClose={closeHelp} />
          <SearchModal open={searchOpen} onClose={closeSearch} />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<AuthGuard><MainLayout /></AuthGuard>}>
              <Route path="/" element={<Navigate to="/chat" replace />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/chat/:conversationId" element={<ChatPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/usage" element={<UsagePage />} />
              <Route path="/templates" element={<TemplatesPage />} />
              <Route path="/knowledge" element={<KnowledgePage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
