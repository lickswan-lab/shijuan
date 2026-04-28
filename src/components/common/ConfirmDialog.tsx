// Batch 43 · 替代 window.confirm() 的暖金确认弹窗。
//
// 设计原则：
// - 同步 confirm → 异步 onConfirm/onCancel 回调（受控组件）
// - Esc → onCancel，Enter → onConfirm（聚焦在 confirm 按钮上）
// - danger=true 时 confirm 按钮用 --danger 红色（删除场景）
// - 半透明 backdrop + blur 与 ImportModal (Change #13) 视觉对齐
// - 不使用 portal（Electron 单窗口，z-index 9999 足够）
//
// 用法（取代 if (confirm(msg)) { doSth() }）：
//   const [confirming, setConfirming] = useState<{ msg: string; onYes: () => void } | null>(null)
//   ...
//   <ConfirmDialog
//     open={!!confirming}
//     message={confirming?.msg || ''}
//     danger
//     onConfirm={() => { confirming?.onYes(); setConfirming(null) }}
//     onCancel={() => setConfirming(null)}
//   />

import { useCallback, useEffect, useRef, useState } from 'react'

export interface ConfirmDialogProps {
  open: boolean
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  // 自动聚焦 confirm 按钮 + Esc/Enter 键盘支持
  useEffect(() => {
    if (!open) return
    // 等渲染后再聚焦
    const t = setTimeout(() => confirmBtnRef.current?.focus(), 30)
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter') {
        // Enter 仅在按钮聚焦时触发；如果用户在某个 textarea / input 里
        // （这种 confirm 场景不该发生但作为防御）也吞掉避免误确认
        const ae = document.activeElement as HTMLElement | null
        const tag = ae?.tagName.toLowerCase()
        if (tag === 'textarea' || tag === 'input') return
        e.preventDefault()
        onConfirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onConfirm, onCancel])

  if (!open) return null

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9998,
        background: 'rgba(61, 53, 41, 0.52)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'sj-anno-toast-in 0.18s cubic-bezier(.2,.9,.3,1.2)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg)',
          borderRadius: 14,
          boxShadow: '0 20px 48px rgba(60, 45, 25, 0.18)',
          padding: 30,
          minWidth: 360,
          maxWidth: 480,
          border: '1px solid var(--border-light)',
        }}
      >
        {title && (
          <div
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 17,
              fontWeight: 500,
              letterSpacing: '1.2px',
              color: 'var(--text)',
              marginBottom: 14,
            }}
          >
            {title}
          </div>
        )}
        <div
          style={{
            fontSize: 13.5,
            lineHeight: 1.7,
            color: 'var(--text)',
            marginBottom: 24,
            whiteSpace: 'pre-wrap',
            letterSpacing: '0.2px',
          }}
        >
          {message}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '8px 18px',
              fontSize: 13,
              borderRadius: 5,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              letterSpacing: '0.5px',
              transition: 'background 200ms cubic-bezier(0.4, 0, 0.2, 1), color 200ms cubic-bezier(0.4, 0, 0.2, 1), border-color 200ms cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-muted)'
              e.currentTarget.style.color = 'var(--text)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = 'var(--text-muted)'
            }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={onConfirm}
            style={{
              padding: '8px 22px',
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: '0.8px',
              borderRadius: 5,
              border: danger ? '1px solid var(--danger, #C97070)' : '1px solid var(--accent)',
              background: danger ? 'var(--danger, #C97070)' : 'var(--accent)',
              color: '#fff',
              cursor: 'pointer',
              transition: 'background 200ms cubic-bezier(0.4, 0, 0.2, 1), border-color 200ms cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            onMouseEnter={(e) => {
              if (danger) {
                e.currentTarget.style.background = '#b35e5e'
                e.currentTarget.style.borderColor = '#b35e5e'
              } else {
                e.currentTarget.style.background = 'var(--accent-hover)'
                e.currentTarget.style.borderColor = 'var(--accent-hover)'
              }
            }}
            onMouseLeave={(e) => {
              if (danger) {
                e.currentTarget.style.background = 'var(--danger, #C97070)'
                e.currentTarget.style.borderColor = 'var(--danger, #C97070)'
              } else {
                e.currentTarget.style.background = 'var(--accent)'
                e.currentTarget.style.borderColor = 'var(--accent)'
              }
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// useConfirmDialog · 把命令式 window.confirm() 包成异步 + 受控 dialog 的 helper
//
// 用法：
//   const { ask, dialog } = useConfirmDialog()
//   const handleDelete = async () => {
//     ask({
//       message: '删除这条笔记？此操作不可撤销。',
//       danger: true,
//       onConfirm: async () => { await doDelete() }
//     })
//   }
//   return <>...{dialog}</>
// ============================================================================

export interface AskOptions {
  message: string
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
}

export function useConfirmDialog() {
  const [pending, setPending] = useState<AskOptions | null>(null)

  const ask = useCallback((opts: AskOptions) => {
    setPending(opts)
  }, [])

  const dialog = (
    <ConfirmDialog
      open={!!pending}
      title={pending?.title}
      message={pending?.message || ''}
      confirmLabel={pending?.confirmLabel}
      cancelLabel={pending?.cancelLabel}
      danger={pending?.danger}
      onConfirm={() => {
        const fn = pending?.onConfirm
        setPending(null)
        if (fn) {
          // 允许 onConfirm 是 async；不 await 让对话框立即关闭
          void Promise.resolve().then(fn)
        }
      }}
      onCancel={() => setPending(null)}
    />
  )

  return { ask, dialog }
}
