import { useEffect, useState } from 'react'
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToastStore, type ToastType } from '@/stores/toast-store'

const icons: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
}

const styles: Record<ToastType, string> = {
  success: 'bg-success-light border-success/20 text-success',
  error: 'bg-error-light border-error/20 text-error',
  info: 'bg-accent-light border-accent/20 text-accent',
}

function ToastItem({ id, type, message }: { id: string; type: ToastType; message: string }) {
  const [isVisible, setIsVisible] = useState(false)
  const removeToast = useToastStore((s) => s.removeToast)
  const Icon = icons[type]

  useEffect(() => {
    // 触发进入动画
    requestAnimationFrame(() => setIsVisible(true))
  }, [])

  const handleClose = () => {
    setIsVisible(false)
    setTimeout(() => removeToast(id), 150)
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-4 py-3 rounded-lg border shadow-lg transition-all duration-150",
        styles[type],
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
      )}
    >
      <Icon size={16} strokeWidth={2} className="shrink-0" />
      <p className="text-sm flex-1">{message}</p>
      <button
        onClick={handleClose}
        className="p-0.5 rounded hover:bg-black/5 transition-colors"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 pointer-events-auto">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} {...toast} />
      ))}
    </div>
  )
}
