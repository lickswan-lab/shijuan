// Batch 43 · 自定义模型选择器
// 替换原生 <select> + <optgroup>，因为 OS 原生下拉不支持折叠厂商分组。
//
// 行为：
//   - 触发器显示当前选中的 model.name
//   - 点击展开 popover
//   - 每个 provider 是一个可折叠 header（点击展开/收起其下所有 model）
//   - 默认全部折叠，但当前选中 model 所在的 provider 默认展开（让用户一眼看到自己刚选的）
//   - 点击 model 选项 → onChange + 自动关闭 popover
//   - 点击外部 / Esc 关闭

import { useEffect, useMemo, useRef, useState } from 'react'

export interface ModelOption {
  id: string
  name: string
}

export interface ModelGroup {
  id: string
  name: string
  models: ModelOption[]
}

export interface ModelSelectorProps {
  /** 'providerId:modelId' 格式 */
  value: string
  onChange: (next: string) => void
  groups: ModelGroup[]
  /** 容器样式覆盖（trigger 按钮的样式） */
  style?: React.CSSProperties
  /** 触发器按钮 size hint（sm 用于学徒面板，md 用于注释面板等） */
  size?: 'sm' | 'md'
  /** 占位文案（无 value 时） */
  placeholder?: string
}

export default function ModelSelector({
  value, onChange, groups, style, size = 'sm', placeholder = '选择模型',
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // 默认展开规则：当前 value 所在的 provider 展开，其他全部折叠
  const initiallyExpanded = useMemo(() => {
    const [pid] = value.includes(':') ? value.split(':', 2) : ['', '']
    return new Set<string>(pid ? [pid] : [])
  }, [value])
  const [expanded, setExpanded] = useState<Set<string>>(initiallyExpanded)

  // 每次 popover 重新打开都重置成"当前 provider 展开 / 其他全收"。
  // （用户上次手动展开的状态不持久——避免下次打开时一堆都开着失去折叠意义）
  useEffect(() => {
    if (open) setExpanded(new Set(initiallyExpanded))
  }, [open, initiallyExpanded])

  // 当前选中 model 名
  const currentLabel = useMemo(() => {
    const [pid, mid] = value.includes(':') ? value.split(':', 2) : ['', '']
    const g = groups.find(g => g.id === pid)
    const m = g?.models.find(m => m.id === mid)
    return m?.name || placeholder
  }, [value, groups, placeholder])

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function toggleProvider(pid: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(pid)) next.delete(pid)
      else next.add(pid)
      return next
    })
  }

  function pick(pid: string, mid: string) {
    onChange(`${pid}:${mid}`)
    setOpen(false)
  }

  const triggerPadding = size === 'sm' ? '3px 8px' : '5px 10px'
  const triggerFont = size === 'sm' ? 10 : 12

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1, minWidth: 0, ...style }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
        onMouseEnter={e => { if (document.activeElement !== e.currentTarget) e.currentTarget.style.borderColor = 'var(--accent-soft, rgba(200,149,108,0.35))' }}
        onMouseLeave={e => { if (document.activeElement !== e.currentTarget) e.currentTarget.style.borderColor = 'var(--border)' }}
        style={{
          width: '100%',
          padding: triggerPadding,
          fontSize: triggerFont,
          border: '1px solid var(--border)',
          borderRadius: 5,
          outline: 'none',
          background: 'var(--bg)',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          transition: 'border-color 180ms cubic-bezier(0.4, 0, 0.2, 1)',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentLabel}</span>
        <span style={{ fontSize: 9, opacity: 0.6, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms' }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 1000,
            minWidth: 220,
            maxWidth: 320,
            maxHeight: 360,
            overflowY: 'auto',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 10px 28px rgba(58,47,31,0.14), 0 2px 6px rgba(58,47,31,0.06)',
            padding: '6px 0',
            animation: 'sj-pop-in 0.18s cubic-bezier(.2,.9,.3,1.2)',
          }}
        >
          {groups.length === 0 && (
            <div style={{ padding: '10px 14px', fontSize: 11, color: 'var(--text-muted)' }}>
              暂未配置任何 AI provider，请先到设置 → AI Provider 添加 API Key
            </div>
          )}
          {groups.map(g => {
            const isExp = expanded.has(g.id)
            return (
              <div key={g.id}>
                <button
                  type="button"
                  onClick={() => toggleProvider(g.id)}
                  style={{
                    width: '100%',
                    padding: '7px 12px',
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.4px',
                    border: 'none',
                    background: isExp ? 'var(--accent-soft, rgba(200,149,108,0.10))' : 'transparent',
                    color: 'var(--text)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    transition: 'background 180ms cubic-bezier(0.4, 0, 0.2, 1)',
                  }}
                  onMouseEnter={e => { if (!isExp) e.currentTarget.style.background = 'var(--bg-muted, rgba(0,0,0,0.03))' }}
                  onMouseLeave={e => { if (!isExp) e.currentTarget.style.background = 'transparent' }}
                >
                  <span style={{ fontSize: 9, opacity: 0.6, width: 8, transform: isExp ? 'rotate(90deg)' : 'none', transition: 'transform 180ms' }}>▸</span>
                  <span style={{ flex: 1 }}>{g.name}</span>
                  <span style={{ fontSize: 9.5, opacity: 0.55, fontWeight: 400 }}>{g.models.length}</span>
                </button>
                {isExp && (
                  <div style={{ paddingBottom: 4 }}>
                    {g.models.map(m => {
                      const isSel = value === `${g.id}:${m.id}`
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => pick(g.id, m.id)}
                          style={{
                            width: '94%',
                            margin: '0 auto',
                            display: 'block',
                            padding: '7px 12px',
                            paddingLeft: 28,
                            fontSize: 11.5,
                            border: 'none',
                            borderRadius: 5,
                            background: isSel ? 'var(--accent)' : 'transparent',
                            color: isSel ? '#fff' : 'var(--text-secondary)',
                            textAlign: 'left',
                            cursor: 'pointer',
                            transition: 'background 180ms cubic-bezier(0.4, 0, 0.2, 1), color 180ms',
                          }}
                          onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'var(--bg-muted, rgba(0,0,0,0.04))' }}
                          onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent' }}
                        >
                          {m.name}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
