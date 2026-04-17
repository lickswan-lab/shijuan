import { Component, ErrorInfo, ReactNode } from 'react'

interface Props { children: ReactNode; fallbackLabel?: string }
interface State { hasError: boolean; error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const label = this.props.fallbackLabel
    console.error(`[ErrorBoundary${label ? ` ${label}` : ''}]`, error, info.componentStack)
    // Persist to crash.log so the diagnostic panel can surface it
    try {
      window.electronAPI?.logRendererCrash?.({
        label,
        message: error.message,
        stack: error.stack || '',
        componentStack: info.componentStack || '',
      })
    } catch { /* best-effort */ }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: 12, padding: 24, color: 'var(--text-muted)',
        }}>
          <div style={{ fontSize: 13 }}>
            {this.props.fallbackLabel || '组件'}加载出错
          </div>
          <div style={{ fontSize: 11, color: 'var(--danger)', maxWidth: 300, textAlign: 'center', wordBreak: 'break-all' }}>
            {this.state.error?.message}
          </div>
          <button
            className="btn btn-sm"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
