// Batch 43 · AI / API 错误转译。把后端透传的 raw 字符串（可能是 "GLM API
// error 401: {...}" 这种）转成用户能看懂的中文 + 给一个明确的下一步建议。
//
// 输入兼容三种 shape：
//   1. Error 对象（来自 throw）
//   2. 字符串（来自 IPC 返回 {success:false, error: string}）
//   3. unknown（兜底）
//
// 输出 silent=true 时调用方应直接吞掉（用户主动 abort 不该弹 toast）。
// ctaSettings=true 时调用方应给一个"去设置"按钮（API Key 类问题）。

export interface HumanizedError {
  message: string
  hint?: string
  ctaSettings?: boolean
  silent?: boolean
}

const KEY_KEYWORDS = [
  'api key',
  'apikey',
  'api-key',
  'invalid_api_key',
  'invalid key',
  '未设置',
  '未配置',
  '无效',
  '已过期',
  'unauthorized',
  'authentication',
]

const QUOTA_KEYWORDS = [
  'insufficient',
  'quota',
  'balance',
  '余额',
  '额度',
  '欠费',
  'billing',
  'payment required',
]

const RATE_LIMIT_KEYWORDS = [
  '429',
  'rate limit',
  'rate_limit',
  'too many requests',
  '过于频繁',
  '1302',
]

const NETWORK_KEYWORDS = [
  'network',
  'fetch failed',
  'failed to fetch',
  'enotfound',
  'econnrefused',
  'etimedout',
  'getaddrinfo',
  'socket hang up',
  '网络',
]

const ABORT_KEYWORDS = ['aborted', '已取消', '已中止', 'usercancel', 'user cancel']

function rawText(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (input instanceof Error) return input.message || String(input)
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.error === 'string') return obj.error
    if (typeof obj.message === 'string') return obj.message
    try {
      return JSON.stringify(input)
    } catch {
      return String(input)
    }
  }
  return String(input)
}

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k))
}

export function humanizeAiError(input: unknown): HumanizedError {
  const raw = rawText(input).trim()
  if (!raw) return { message: 'AI 调用失败（未知错误）' }

  const lower = raw.toLowerCase()

  if (hasAny(lower, ABORT_KEYWORDS)) {
    return { message: raw, silent: true }
  }

  if (hasAny(lower, RATE_LIMIT_KEYWORDS)) {
    return {
      message: '请求过于频繁，请稍后重试',
      hint: '拾卷已根据当前 provider 速率自动节流并自适应降挡。如长期触发可在设置里手动调高 RPM 或切换其他 provider。',
    }
  }

  if (hasAny(lower, QUOTA_KEYWORDS)) {
    return {
      message: 'API 余额不足或额度已耗尽',
      hint: '请到对应 provider 控制台充值，或在设置切换到其他 provider',
      ctaSettings: true,
    }
  }

  if (lower.includes('401') || lower.includes('403') || hasAny(lower, KEY_KEYWORDS)) {
    return {
      message: 'API Key 无效或未配置',
      hint: '请到设置 → AI Provider 检查 Key',
      ctaSettings: true,
    }
  }

  if (hasAny(lower, NETWORK_KEYWORDS)) {
    return {
      message: '网络连接失败',
      hint: '检查网络或代理配置；境外 provider 可能需要 VPN',
    }
  }

  if (lower.includes('500') || lower.includes('502') || lower.includes('503') || lower.includes('504')) {
    return {
      message: 'AI 服务暂时不可用',
      hint: '通常是上游故障，过几分钟再试',
    }
  }

  if (lower.includes('timeout') || lower.includes('超时')) {
    return {
      message: '请求超时',
      hint: '可能是网络慢或上游处理太久；可重试',
    }
  }

  // 400 + Model Not Exist / invalid_request_error → 多半是模型 ID 不被 provider 识别
  if (lower.includes('400') && (lower.includes('model not exist') || lower.includes('model not found') || lower.includes('invalid_request_error'))) {
    return {
      message: '模型 ID 不被 provider 识别',
      hint: '请到顶部模型下拉重新选一个，或检查 provider 是否更新了模型名',
      ctaSettings: true,
    }
  }

  if (lower.includes('400')) {
    return {
      message: '请求参数错误',
      hint: '可能是模型 ID / 上下文超长 / 内容被审核拦截',
    }
  }

  // 兜底：把 raw 截短并去掉常见冗余前缀
  let trimmed = raw
  // "GLM API error 401: {...}" → 去掉 "{...}" 后段
  const jsonStart = trimmed.indexOf('{')
  if (jsonStart > 0 && jsonStart < 120) {
    trimmed = trimmed.slice(0, jsonStart).trim().replace(/[:,\s]+$/, '')
  }
  if (trimmed.length > 200) trimmed = trimmed.slice(0, 200) + '…'
  return { message: trimmed }
}

// 便捷拼装：返回用户可见的单行字符串（toast / inline 用）
export function humanizeAiErrorLine(input: unknown): string {
  const h = humanizeAiError(input)
  if (h.silent) return ''
  return h.hint ? `${h.message}（${h.hint}）` : h.message
}
