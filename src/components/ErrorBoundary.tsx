import { Component, ErrorInfo, ReactNode } from 'react'

interface Props { children: ReactNode; fallbackLabel?: string }
interface State { hasError: boolean; error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.fallbackLabel ? ` ${this.props.fallbackLabel}` : ''}]`, error, info.componentStack)
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
