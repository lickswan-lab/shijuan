// 2026-04-25 PERF · 通用 IME-aware 输入框
// 中文用户拼音中间态（"n"→"ni"→"你"）每键都会触发 onChange，
// 如果 onChange 下游有 useEffect / useMemo 重运行 filter / IPC，会浪费三次。
// 用 isComposing ref 拦截：IME 中只更新本地展示值，IME 结束时统一抛一次。
//
// 使用：
//   <ImeInput value={query} onChange={setQuery} placeholder="..." />

import { useState, useEffect, useRef, forwardRef, memo } from 'react'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  style?: React.CSSProperties
  className?: string
  autoFocus?: boolean
  onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
}

const ImeInput = memo(forwardRef<HTMLInputElement, Props>(function ImeInput(
  { value, onChange, placeholder, style, className, autoFocus, onFocus, onBlur, onKeyDown },
  ref,
) {
  const [localValue, setLocalValue] = useState(value)
  const isComposingRef = useRef(false)
  useEffect(() => { setLocalValue(value) }, [value])
  return (
    <input
      ref={ref}
      type="text"
      placeholder={placeholder}
      value={localValue}
      autoFocus={autoFocus}
      className={className}
      onChange={e => {
        setLocalValue(e.target.value)
        if (!isComposingRef.current) onChange(e.target.value)
      }}
      onCompositionStart={() => { isComposingRef.current = true }}
      onCompositionEnd={e => {
        isComposingRef.current = false
        onChange((e.target as HTMLInputElement).value)
      }}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      style={style}
    />
  )
}))

export default ImeInput
