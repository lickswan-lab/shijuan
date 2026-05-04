// Batch 43 · OCR 范围选择 modal
//
// 用户场景：300 页大书只想 OCR 第 50-100 页。之前没选项，必须整本 OCR——慢、烧 quota。
// 现在弹 modal 让用户选：
//   - 整本（默认）
//   - 范围（输入起止页码）
//   - 当前页附近（基于 currentVisiblePage 自动填充 ±25 页）
//
// 设计：受控组件（不用 imperative 调用）。Esc 取消、Enter 确认。
// 视觉：与 ConfirmDialog / ImportModal 同款暖金风格。

import { useEffect, useRef, useState } from 'react'

export type OcrMode = 'full' | 'range' | 'around-current'
export type OcrEngine = 'glm' | 'rapidocr'

export interface OcrRangeChoice {
  startPage?: number
  endPage?: number
  engine?: OcrEngine
}

export interface OcrRangeModalProps {
  open: boolean
  totalPages: number       // PDF 总页数
  currentPage: number      // 用户当前可见页（用于"当前页附近"默认值）
  defaultMode?: OcrMode
  ocrEngine?: OcrEngine
  glmApiKeyStatus?: 'set' | 'not-set' | 'checking'
  onEngineChange?: (engine: OcrEngine) => void
  onConfirm: (choice: OcrRangeChoice) => void
  onCancel: () => void
}

export default function OcrRangeModal({
  open,
  totalPages,
  currentPage,
  defaultMode = 'full',
  ocrEngine = 'glm',
  glmApiKeyStatus = 'checking',
  onEngineChange,
  onConfirm,
  onCancel,
}: OcrRangeModalProps) {
  const [mode, setMode] = useState<OcrMode>(defaultMode)
  const [startStr, setStartStr] = useState('1')
  const [endStr, setEndStr] = useState(String(totalPages || 1))
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [rapidStatus, setRapidStatus] = useState<{ checking: boolean; available: boolean; message: string; installCommand?: string } | null>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  // 重置默认值（每次打开 modal 时）
  useEffect(() => {
    if (!open) return
    setMode(defaultMode)
    setStartStr('1')
    setEndStr(String(totalPages || 1))
    setErrorMsg(null)
    const t = setTimeout(() => confirmBtnRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open, defaultMode, totalPages])

  useEffect(() => {
    if (!open || ocrEngine !== 'rapidocr') return
    let cancelled = false
    setRapidStatus({ checking: true, available: false, message: '正在检查本地 RapidOCR...' })
    window.electronAPI?.rapidOcrProbe?.()
      .then(r => {
        if (cancelled) return
        if (r?.available) {
          setRapidStatus({
            checking: false,
            available: true,
            message: `已连接 ${r.api || 'RapidOCR'}${r.version ? ` ${r.version}` : ''}${r.python ? ` · ${r.python}` : ''}`,
            installCommand: r.installCommand,
          })
        } else {
          setRapidStatus({
            checking: false,
            available: false,
            message: r?.error || '未检测到本地 RapidOCR',
            installCommand: r?.installCommand || 'python -m pip install rapidocr onnxruntime pymupdf',
          })
        }
      })
      .catch(err => {
        if (cancelled) return
        setRapidStatus({
          checking: false,
          available: false,
          message: err?.message || 'RapidOCR 检查失败',
          installCommand: 'python -m pip install rapidocr onnxruntime pymupdf',
        })
      })
    return () => { cancelled = true }
  }, [open, ocrEngine])

  // mode 切换时自动填合理默认
  useEffect(() => {
    if (mode === 'full') {
      setStartStr('1')
      setEndStr(String(totalPages || 1))
    } else if (mode === 'around-current') {
      // 当前页 ± 25 页
      const center = Math.max(1, currentPage)
      const s = Math.max(1, center - 25)
      const e = Math.min(totalPages || center, center + 25)
      setStartStr(String(s))
      setEndStr(String(e))
    }
    // mode === 'range' 保留用户已输入值
  }, [mode, currentPage, totalPages])

  // Esc 取消 / Enter 确认
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter') {
        const ae = document.activeElement as HTMLElement | null
        const tag = ae?.tagName.toLowerCase()
        if (tag === 'textarea') return  // textarea 内 Enter 是换行
        e.preventDefault()
        handleConfirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, startStr, endStr, ocrEngine, glmApiKeyStatus, rapidStatus])

  function handleConfirm() {
    setErrorMsg(null)
    if (ocrEngine === 'glm' && glmApiKeyStatus !== 'set') {
      setErrorMsg('GLM OCR 需要先在设置里配置 GLM API KEY，或切换到本地 RapidOCR。')
      return
    }
    if (ocrEngine === 'rapidocr') {
      if (!rapidStatus || rapidStatus.checking) {
        setErrorMsg('正在检查本地 RapidOCR，请稍等。')
        return
      }
      if (!rapidStatus.available) {
        setErrorMsg('本地 RapidOCR 还不可用，请先按下方命令安装依赖，或切回 GLM OCR。')
        return
      }
    }
    if (mode === 'full') {
      onConfirm({ engine: ocrEngine })
      return
    }
    const start = parseInt(startStr, 10)
    const end = parseInt(endStr, 10)
    if (!Number.isFinite(start) || start < 1) {
      setErrorMsg('起始页必须是 ≥ 1 的整数')
      return
    }
    if (totalPages > 0 && start > totalPages) {
      setErrorMsg(`起始页不能超过总页数 ${totalPages}`)
      return
    }
    if (!Number.isFinite(end) || end < start) {
      setErrorMsg('结束页必须 ≥ 起始页')
      return
    }
    if (totalPages > 0 && end > totalPages) {
      setErrorMsg(`结束页不能超过总页数 ${totalPages}`)
      return
    }
    onConfirm({ startPage: start, endPage: end, engine: ocrEngine })
  }

  // 输入失焦时把越界值 clamp 回合法区间——避免用户输完后还以为 200 页能 OCR
  function clampPage(s: string): string {
    const n = parseInt(s, 10)
    if (!Number.isFinite(n)) return s  // 空字符串/非数字保留,让用户继续输
    if (n < 1) return '1'
    if (totalPages > 0 && n > totalPages) return String(totalPages)
    return String(n)
  }

  if (!open) return null

  // 估算费用 / 时长——粗略提示
  //
  // 旧公式 estChunks * 0.5min + Math.round 让 1-3 个 chunk 全部显示成 1 分钟,
  // 完全抹平了大小差异。重新校准:
  //   - 单 chunk 实际 GLM-OCR 处理 ≈ 50-70s(80 页大 batch)
  //   - GLM 4 RPM 节流 → 每个新 chunk 至少要等 15s 才能发起
  //   - 网络/启动 buffer ~15s
  // 公式: max(45, chunks * 60 + 15),小于 60s 显示秒,否则显示分钟。
  const pageCount = mode === 'full'
    ? totalPages || 0
    : Math.max(0, (parseInt(endStr, 10) || 0) - (parseInt(startStr, 10) || 0) + 1)
  const estChunks = Math.ceil(pageCount / 80)
  const estSeconds = pageCount > 0 ? Math.max(45, estChunks * 60 + 15) : 0
  const estTimeLabel = estSeconds < 60
    ? `${estSeconds} 秒`
    : `${Math.ceil(estSeconds / 60)} 分钟`

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 9998,
        background: 'rgba(61, 53, 41, 0.52)',
        backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'sj-anno-toast-in 0.18s cubic-bezier(.2,.9,.3,1.2)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg)', borderRadius: 14,
          boxShadow: '0 20px 48px rgba(60, 45, 25, 0.18)',
          padding: 30, minWidth: 420, maxWidth: 520,
          border: '1px solid var(--border-light)',
        }}
      >
        <div style={{
          fontFamily: 'var(--font-serif)', fontSize: 17, fontWeight: 500,
          letterSpacing: '1.2px', color: 'var(--text)', marginBottom: 14,
        }}>
          OCR 范围
        </div>
        <div style={{
          fontSize: 12, color: 'var(--text-muted)', marginBottom: 20,
          lineHeight: 1.6,
        }}>
          PDF 共 {totalPages || '?'} 页。你可以只 OCR 一部分（大文件全本 OCR 慢且费 quota）。
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>OCR 引擎</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <EngineOption
              checked={ocrEngine === 'rapidocr'}
              title="本地 RapidOCR"
              sub="离线 · 不消耗 API KEY"
              onClick={() => onEngineChange?.('rapidocr')}
            />
            <EngineOption
              checked={ocrEngine === 'glm'}
              title="GLM OCR"
              sub={glmApiKeyStatus === 'set' ? '云端 · 版式解析更强' : '需要 GLM API KEY'}
              onClick={() => onEngineChange?.('glm')}
            />
          </div>
          {ocrEngine === 'rapidocr' && rapidStatus && (
            <div style={{
              marginTop: 8,
              padding: '8px 10px',
              borderRadius: 6,
              background: rapidStatus.available ? 'rgba(114, 153, 124, 0.10)' : 'rgba(201, 112, 112, 0.08)',
              border: `1px solid ${rapidStatus.available ? 'rgba(114, 153, 124, 0.22)' : 'rgba(201, 112, 112, 0.18)'}`,
              color: rapidStatus.available ? 'var(--success, #6E8F6B)' : 'var(--danger, #C97070)',
              fontSize: 11.5,
              lineHeight: 1.55,
            }}>
              <div>{rapidStatus.message}</div>
              {!rapidStatus.available && rapidStatus.installCommand && (
                <code style={{
                  display: 'block',
                  marginTop: 6,
                  color: 'var(--text)',
                  background: 'rgba(61, 53, 41, 0.06)',
                  borderRadius: 4,
                  padding: '5px 7px',
                  userSelect: 'text',
                }}>{rapidStatus.installCommand}</code>
              )}
            </div>
          )}
        </div>

        {/* mode 选项 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
          <ModeRadio
            checked={mode === 'full'}
            label="整本"
            sub={totalPages ? `OCR 全部 ${totalPages} 页` : '加载页数后再选'}
            onChange={() => setMode('full')}
          />
          <ModeRadio
            checked={mode === 'around-current'}
            label="当前页附近"
            sub={`第 ${Math.max(1, currentPage - 25)} – ${Math.min(totalPages || currentPage, currentPage + 25)} 页（前后各 25）`}
            onChange={() => setMode('around-current')}
          />
          <ModeRadio
            checked={mode === 'range'}
            label="自定义范围"
            sub="手动指定起止页码"
            onChange={() => setMode('range')}
          />
        </div>

        {/* range 输入 */}
        {(mode === 'range' || mode === 'around-current') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>第</span>
            <input
              type="number"
              value={startStr}
              onChange={(e) => { setStartStr(e.target.value); if (mode !== 'range') setMode('range') }}
              onBlur={(e) => setStartStr(clampPage(e.target.value))}
              min={1}
              max={totalPages || undefined}
              style={inputStyle}
            />
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>到第</span>
            <input
              type="number"
              value={endStr}
              onChange={(e) => { setEndStr(e.target.value); if (mode !== 'range') setMode('range') }}
              onBlur={(e) => setEndStr(clampPage(e.target.value))}
              min={1}
              max={totalPages || undefined}
              style={inputStyle}
            />
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>页</span>
          </div>
        )}

        {/* 估算提示 */}
        {pageCount > 0 && (
          <div style={{
            fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 18,
            padding: '8px 12px', background: 'var(--bg-warm, rgba(200,149,108,0.08))',
            borderRadius: 6, lineHeight: 1.55,
          }}>
            将处理 <strong style={{ color: 'var(--accent)' }}>{pageCount}</strong> 页，
            {ocrEngine === 'rapidocr'
              ? ` 本地逐页识别，首次运行可能下载模型，预计 ${estTimeLabel} 起。`
              : ` 约 ${estChunks} 个分片，预计 ${estTimeLabel}（GLM 4 RPM 节流，实际可能更长）。`}
          </div>
        )}

        {/* 错误提示 */}
        {errorMsg && (
          <div style={{
            fontSize: 12, color: 'var(--danger, #C97070)', marginBottom: 14,
            padding: '6px 10px', background: 'rgba(201, 112, 112, 0.08)',
            borderRadius: 4,
          }}>
            {errorMsg}
          </div>
        )}

        {/* 按钮 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={onCancel}
            style={cancelBtnStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-muted)'; e.currentTarget.style.color = 'var(--text)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}
          >取消</button>
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={handleConfirm}
            style={confirmBtnStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-hover)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--accent)' }}
          >开始 OCR</button>
        </div>
      </div>
    </div>
  )
}

function EngineOption({
  checked, title, sub, onClick,
}: { checked: boolean; title: string; sub: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: '11px 12px',
        borderRadius: 8,
        border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-light)'}`,
        background: checked ? 'var(--accent-soft, rgba(200,149,108,0.10))' : 'transparent',
        color: 'var(--text)',
        cursor: 'pointer',
        transition: 'all 160ms ease',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{sub}</div>
    </button>
  )
}

// 单选项小组件
function ModeRadio({
  checked, label, sub, onChange,
}: { checked: boolean; label: string; sub: string; onChange: () => void }) {
  return (
    <label
      onClick={onChange}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '10px 12px', borderRadius: 6, cursor: 'pointer',
        border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-light)'}`,
        background: checked ? 'var(--accent-soft, rgba(200,149,108,0.10))' : 'transparent',
        transition: 'all 180ms cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        style={{ marginTop: 2, accentColor: 'var(--accent)' }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: checked ? 500 : 400, color: 'var(--text)' }}>{label}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>
      </div>
    </label>
  )
}

const inputStyle: React.CSSProperties = {
  width: 80, padding: '5px 8px', fontSize: 13,
  border: '1px solid var(--border)', borderRadius: 4,
  outline: 'none', background: 'var(--bg)', color: 'var(--text)',
  textAlign: 'center',
}

const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 18px', fontSize: 13,
  border: '1px solid var(--border)', borderRadius: 5,
  background: 'transparent', color: 'var(--text-muted)',
  cursor: 'pointer', letterSpacing: '0.5px',
  transition: 'all 200ms cubic-bezier(0.4, 0, 0.2, 1)',
}

const confirmBtnStyle: React.CSSProperties = {
  padding: '8px 22px', fontSize: 13, fontWeight: 500,
  letterSpacing: '0.8px',
  border: '1px solid var(--accent)', borderRadius: 5,
  background: 'var(--accent)', color: '#fff',
  cursor: 'pointer',
  transition: 'background 200ms cubic-bezier(0.4, 0, 0.2, 1)',
}
