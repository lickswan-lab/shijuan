// Per-provider default rate limits for the adaptive throttler (aiThrottle.ts).
//
// Values here target the FREE / entry tier of each provider as of 2026-04
// (typical new-account values) so that a user who signs up without paying
// won't hit 429s on first use. If they have a paid tier, they can override
// via user settings (surfaced through setProviderRpmOverride() in
// aiThrottle).
//
// Source of the numbers (rough — each provider publishes slightly different
// per-tier limits, and the effective ceiling depends on model too):
//   GLM (智谱):      免费层 ~4-5 RPM；glm-4-flash 更松但账号级也就几十；保守用 3
//   Kimi:            ~3 RPS 起步（付费几十）；按 RPM 记 180 保守太激进，取 60 RPM = 1 RPS
//   OpenAI:          tier 1 ~500 RPM，免费层 3 RPM；保守 100 RPM 给 tier 1 用户
//   Claude:          tier 1 ~50 RPM，高 tier 1000+；保守 30 RPM
//   DeepSeek:        ~60 RPM，免费送 10 元；60 RPM 是账号默认
//   Gemini:          AI Studio 免费 ~15 RPM；保守 10 RPM
//   豆包:            实名后账号级，seed 模型 ~60 RPM；保守 30 RPM
//   claude_cli:      走本地 CLI，没有真·限流，但别并发（spawn 多进程会挤爆 CPU）
//   ollama:          本地模型，也没限流，但一次一个请求（模型不支持并发）
//
// 这些值故意保守——免费 tier 可用是目标，触发 429 后自适应降挡（×0.7）会自动
// 再紧一些。撞墙恢复策略见 aiThrottle.ts 的 RECOVERY_WINDOW_MS / RECOVERY_STEP。

export interface ProviderRateLimit {
  // 每分钟最大请求数（effective RPM = rpm × multiplier）
  rpm: number
  // 最大并发（一次最多几个请求在飞）。多数 provider 串行发最稳，
  // 但 OpenAI/Claude 高 tier 可以并发发。保守默认 1。
  maxConcurrency: number
  // 撞墙后的初始 backoff（毫秒）。跟 response headers 里的 retry-after
  // 结合用——有 header 就听 header，没 header 就用这个。
  initialBackoffMs: number
  // 显示用名字
  displayName: string
}

export const PROVIDER_RATE_LIMITS: Record<string, ProviderRateLimit> = {
  glm: {
    // 2026-04-28 · 3 → 30 提速:之前按 GLM-4-Flash 免费 4 RPM 设的极保守值,
    //   导致付费用户(GLM-5.1 / GLM-4-Plus 通常 60+ RPM)被无谓限速,召唤对话
    //   每次都"请求过于频繁"。改 30 RPM 平衡两端:付费用户立刻享受 30 RPM,
    //   免费 Flash 用户撞墙后自适应 ×0.7 降挡会自动收紧到 ~9-15 RPM(仍比
    //   原来 3 RPM 流畅得多)。理想的修法是按 model 区分 RPM(Flash=4 / 5.1=60),
    //   待后续 schedule() 加 modelId 参数支持。
    rpm: 30,
    maxConcurrency: 1,
    initialBackoffMs: 500,
    displayName: '智谱 GLM',
  },
  hunyuan: {
    rpm: 30,
    maxConcurrency: 2,
    initialBackoffMs: 500,
    displayName: '腾讯混元',
  },
  kimi: {
    rpm: 60,  // ≈ 1 RPS，kimi 免费起步是 3 RPS 但账号共享，保守点
    maxConcurrency: 2,
    initialBackoffMs: 500,
    displayName: 'Kimi',
  },
  openai: {
    rpm: 100,  // tier 1 默认 500 RPM，我们留 5× 安全边
    maxConcurrency: 3,
    initialBackoffMs: 500,
    displayName: 'OpenAI',
  },
  claude: {
    rpm: 30,
    maxConcurrency: 2,
    initialBackoffMs: 500,
    displayName: 'Claude',
  },
  deepseek: {
    rpm: 60,
    maxConcurrency: 2,
    initialBackoffMs: 500,
    displayName: 'DeepSeek',
  },
  gemini: {
    rpm: 10,  // AI Studio 免费层紧，保守到 10
    maxConcurrency: 1,
    initialBackoffMs: 500,
    displayName: 'Google Gemini',
  },
  doubao: {
    rpm: 30,
    maxConcurrency: 2,
    initialBackoffMs: 500,
    displayName: '豆包',
  },
  claude_cli: {
    // 本地 CLI 没真限流，但 spawn 多进程昂贵，限一个在飞就好
    rpm: 600,
    maxConcurrency: 1,
    initialBackoffMs: 1000,
    displayName: 'Claude Code CLI',
  },
  ollama: {
    // 本地模型，模型本身不支持并发——串行跑
    rpm: 600,
    maxConcurrency: 1,
    initialBackoffMs: 1000,
    displayName: 'Ollama',
  },
}

// Default fallback for unknown providers. Keep this conservative so a new
// provider accidentally routed here doesn't torch anyone's quota.
export const DEFAULT_RATE_LIMIT: ProviderRateLimit = {
  rpm: 30,
  maxConcurrency: 1,
  initialBackoffMs: 500,
  displayName: 'Unknown',
}

export function getBaseRateLimit(providerId: string): ProviderRateLimit {
  return PROVIDER_RATE_LIMITS[providerId.toLowerCase()] || DEFAULT_RATE_LIMIT
}
