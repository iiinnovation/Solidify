import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface Props {
  children: ReactNode
  /** 崩溃时显示的回退 UI；未提供则使用默认 */
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div className="h-full flex items-center justify-center p-6">
          <div className="text-center space-y-3 max-w-xs">
            <div className="w-10 h-10 rounded-xl bg-error-light flex items-center justify-center mx-auto">
              <AlertTriangle size={20} strokeWidth={1.75} className="text-error" />
            </div>
            <p className="text-sm font-medium text-text-primary">渲染出错了</p>
            <p className="text-xs text-text-tertiary leading-relaxed">
              {this.state.error?.message || '组件渲染时发生了未知错误'}
            </p>
            <button
              onClick={this.handleReset}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-accent bg-accent-light hover:bg-accent/10 rounded-md transition-colors"
            >
              <RefreshCw size={12} strokeWidth={2} />
              重试
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
