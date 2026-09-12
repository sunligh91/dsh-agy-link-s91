// Single source of truth for every settable plugin option.
//
// Both halves read this list: the host validates /config writes against it and
// reports effective values from it, and the browser renders an input per entry.
// Adding an option therefore means adding ONE record here — a field cannot drift
// out of sync between the settings panel and the endpoint that persists it, and
// the panel can never offer a key the server would reject.
//
// Keep this module dependency-free (types only): the client bundle imports it.
import type { PluginConfig } from './types.ts'

/** How the panel renders and how the host coerces the value. */
export type SettingKind = 'number' | 'boolean' | 'string' | 'enum'

/** Panel grouping; mirrors how the options are reasoned about. */
export type SettingGroup = 'watchdog' | 'general' | 'model' | 'aux' | 'media' | 'advanced'

export interface SettingOption {
  value: string
  label: string
}

export interface SettingDef {
  /** PluginConfig key this controls. */
  key: keyof PluginConfig & string
  kind: SettingKind
  group: SettingGroup
  /** Short label shown next to the control. */
  label: string
  /** What the option does and when to change it. */
  description: string
  /** Environment variable that overrides this setting (env wins). */
  env?: string
  // ---- number ----
  min?: number
  max?: number
  /** Value increment for the spinner / stepper. */
  step?: number
  /** Rendered after the input, e.g. 'ms'. */
  unit?: string
  /** Values at or above this are displayed with a human-friendly hint. */
  msScale?: boolean
  // ---- enum ----
  options?: readonly SettingOption[]
  /** Hidden behind the "advanced" fold when true. */
  advanced?: boolean
}

export const SETTINGS: readonly SettingDef[] = [
  // ---- watchdog + answer salvage ----
  {
    key: 'timeoutMs',
    kind: 'number',
    group: 'watchdog',
    label: '输出静默看门狗',
    description:
      'agy 连续多久没往 stdout 写任何内容就判定为卡死并终止本轮（毫秒）。' +
      '过长会让真卡住的任务白等；过短会在模型仍在自己思考/执行时被误杀。' +
      '实测正常工作时 agy 每 3~12 秒就有输出，偶发静默最长约 4 分钟，' +
      '因此 300000（5 分钟）是安全值，默认 600000（10 分钟）偏保守。',
    env: 'DSH_AGY_TIMEOUT_MS',
    min: 10_000,
    max: 3_600_000,
    step: 10_000,
    unit: 'ms',
    msScale: true,
  },
  {
    key: 'salvageAnswers',
    kind: 'boolean',
    group: 'watchdog',
    label: '答案抢救',
    description:
      'agy 有时其实已经在本地写完了答案，却没有把它写到 stdout，于是被看门狗误判为超时并丢弃。' +
      '开启后会去读 agy 自己的会话记录，把已完成的答案捞回来并正常返回（附一条说明）。' +
      '关掉则维持旧行为：静默超时即报 TIMEOUT。',
    env: 'DSH_AGY_SALVAGE',
  },
  {
    key: 'salvagePollMs',
    kind: 'number',
    group: 'watchdog',
    label: '抢救轮询间隔',
    description:
      '多久检查一次 agy 的会话记录，看完整答案是否已经落盘（毫秒）。' +
      '调小能更早发现已完成的答案，代价是更频繁地读磁盘；调大则发现得更晚。' +
      '默认 10000（10 秒）——实际拿到答案的时间主要由「抢救静默门槛」决定，' +
      '本项只影响最多多等一个轮询周期。',
    env: 'DSH_AGY_SALVAGE_POLL_MS',
    min: 1_000,
    max: 120_000,
    step: 1_000,
    unit: 'ms',
    msScale: true,
    advanced: true,
  },
  {
    key: 'salvageIdleMs',
    kind: 'number',
    group: 'watchdog',
    label: '抢救静默门槛',
    description:
      'stdout 必须安静这么久，才允许采信磁盘上的答案（毫秒）。' +
      '这是防止「输出还在陆续到达时被提前打断」的安全阀，也是决定多久能拿到答案的主要因素。' +
      '实测正常工作时 agy 每 3~12 秒就有输出，偶发静默最长约 4 分钟；' +
      '默认 45000（45 秒）—— 若把它调到 4 分钟以上，就可能误判仍在工作的运行。' +
      '必须明显小于「输出静默看门狗」。',
    env: 'DSH_AGY_SALVAGE_IDLE_MS',
    min: 5_000,
    max: 600_000,
    step: 5_000,
    unit: 'ms',
    msScale: true,
    advanced: true,
  },
  {
    key: 'salvageMinChars',
    kind: 'number',
    group: 'watchdog',
    label: '答案最短长度',
    description:
      '会话记录里的内容至少要有这么多字符，才算「完整答案」（字符）。' +
      '用于过滤空记录与中途片段，避免把一句话的过程说明误认成最终答复。' +
      '默认 40；调大更保守，但可能漏掉本身就很短的答案。',
    min: 1,
    max: 100_000,
    step: 10,
    unit: '字符',
    advanced: true,
  },

  // ---- general ----
  {
    key: 'permissionMode',
    kind: 'enum',
    group: 'general',
    label: '权限模式',
    description:
      'skip：免确认全自动（会传 --dangerously-skip-permissions）；' +
      'accept-edits：允许改文件但仍确认其他操作；plan：只读分析。',
    env: 'DSH_AGY_MODE',
    options: [
      { value: 'skip', label: 'skip (全自动免确认)' },
      { value: 'accept-edits', label: 'accept-edits (改代码)' },
      { value: 'plan', label: 'plan (只读)' },
    ],
  },
  {
    key: 'workspaceRoot',
    kind: 'string',
    group: 'general',
    label: '工作区根目录',
    description: 'agy 运行的工作目录。留空则跟随当前 DSH 会话的工作区（推荐）。',
    env: 'DSH_AGY_WORKSPACE_ROOT',
  },
  {
    key: 'defaultModel',
    kind: 'string',
    group: 'model',
    label: '默认模型',
    description: '新会话使用的 agy 模型 slug，例如 gemini-3.8-flash。留空则用 agy 自己的默认值。',
    env: 'DSH_AGY_DEFAULT_MODEL',
  },
  {
    key: 'defaultEffort',
    kind: 'enum',
    group: 'model',
    label: '思考强度',
    description:
      '思考预算。仅 Gemini 系模型支持 high/medium/low；Claude 与 GPT-OSS 会忽略该参数。auto 表示用模型默认。',
    env: 'DSH_AGY_DEFAULT_EFFORT',
    options: [
      { value: '', label: 'auto' },
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
    ],
  },

  // ---- aux ----
  {
    key: 'allowAuxiliary',
    kind: 'boolean',
    group: 'aux',
    label: '允许辅助调用',
    description: '允许会话压缩、会话标题这类辅助任务也去调用 agy。关掉可省额度，但历史压缩会退化。',
  },
  {
    key: 'askTool',
    kind: 'boolean',
    group: 'aux',
    label: 'agy_ask 工具',
    description: '额外暴露一个 agy_ask 工具，让主模型可以单独向 agy 提问（一问一答，不进入会话历史）。',
  },
  {
    key: 'autoFallbackModel',
    kind: 'boolean',
    group: 'aux',
    label: '额度耗尽自动降级',
    description: '当前模型额度用尽时，自动改用可用的低阶模型继续，而不是直接报错。',
    env: 'DSH_AGY_AUTO_FALLBACK_MODEL',
  },
  {
    key: 'rateLimitPerMinute',
    kind: 'number',
    group: 'aux',
    label: '每分钟请求上限',
    description: '对所有会话的 agy 调用做全局限流（0 = 不限制）。用于降低触发 Google 风控的概率。',
    env: 'DSH_AGY_RATE_LIMIT_PER_MINUTE',
    min: 0,
    max: 600,
    step: 1,
    unit: '次/分',
    advanced: true,
  },
  {
    key: 'maxConcurrent',
    kind: 'number',
    group: 'aux',
    label: '最大并发',
    description: '同时允许运行多少个 agy 进程。调高可并行，但更容易触发限流。',
    min: 1,
    max: 16,
    step: 1,
    advanced: true,
  },

  // ---- media ----
  {
    key: 'mediaTtlMs',
    kind: 'number',
    group: 'media',
    label: '图片暂存有效期',
    description: '为 agy 暂存的图片多久后清理（毫秒）。agy 打印模式无法直接接收图片，桥接会先落盘再按路径引用。',
    env: 'DSH_AGY_MEDIA_TTL_MS',
    min: 60_000,
    max: 30 * 86_400_000,
    step: 3_600_000,
    unit: 'ms',
    msScale: true,
    advanced: true,
  },
  {
    key: 'mediaMaxBytes',
    kind: 'number',
    group: 'media',
    label: '单张图片上限',
    description: '超过该大小的图片会被跳过并附一条提示（字节）。',
    min: 1024,
    max: 200 * 1024 * 1024,
    step: 1024 * 1024,
    unit: 'bytes',
    advanced: true,
  },
  {
    key: 'mediaMaxImages',
    kind: 'number',
    group: 'media',
    label: '单次图片上限',
    description: '一次请求最多为 agy 暂存多少张图片，超出部分会被忽略并附提示。调大可一次给更多截图，但会让单轮提示词显著变长。',
    min: 1,
    max: 64,
    step: 1,
    unit: '张',
    advanced: true,
  },

  // ---- advanced ----
  {
    key: 'forwardSystemPrompt',
    kind: 'boolean',
    group: 'advanced',
    label: '转发系统提示词',
    description: '把 DSH 的系统提示词一并交给 agy。可能改变模型的默认行为，默认关闭。',
    advanced: true,
  },
  {
    key: 'contextWindowDefault',
    kind: 'number',
    group: 'advanced',
    label: '默认上下文窗口',
    description: '无法从 agy 获知上下文大小时使用的兜底值（token）。它决定 DSH 何时触发历史压缩，设小了会过早压缩。',
    min: 1024,
    max: 20_000_000,
    step: 1024,
    unit: 'tokens',
    advanced: true,
  },
  {
    key: 'maxTokensDefault',
    kind: 'number',
    group: 'advanced',
    label: '默认最大输出',
    description: '无法从 agy 获知单轮输出上限时使用的兜底值（token）。设置过小会让长回答被截断。',
    min: 256,
    max: 1_000_000,
    step: 256,
    unit: 'tokens',
    advanced: true,
  },
  {
    key: 'digestMaxChars',
    kind: 'number',
    group: 'advanced',
    label: '历史摘要上限',
    description: '首次把会话绑定到 agy 时，将此前对话压缩成摘要前缀的字符上限。调大能让 agy 看到更多上下文，但首轮提示词会更长。',
    min: 0,
    max: 1_000_000,
    step: 1000,
    unit: '字符',
    advanced: true,
  },
  {
    key: 'compactionMaxChars',
    kind: 'number',
    group: 'advanced',
    label: '压缩输入上限',
    description: '交给 agy 做历史压缩时的正文长度上限（字符）。超大历史会被截断到该长度后再压缩，避免撑爆单次请求。',
    min: 1000,
    max: 5_000_000,
    step: 10_000,
    unit: '字符',
    advanced: true,
  },
  {
    key: 'modelsCacheTtlMs',
    kind: 'number',
    group: 'advanced',
    label: '模型列表缓存',
    description: 'agy 模型清单的缓存时长（毫秒）。调小可更快看到新上线的模型，但每次都要多跑一次 agy models 探测。',
    min: 10_000,
    max: 86_400_000,
    step: 60_000,
    unit: 'ms',
    msScale: true,
    advanced: true,
  },
  {
    key: 'logRetentionDays',
    kind: 'number',
    group: 'advanced',
    label: '日志保留天数',
    description: 'agy 自身日志文件的保留天数，超期会被自动清理以释放磁盘。排查历史问题时可以调大。',
    env: 'DSH_AGY_LOG_RETENTION_DAYS',
    min: 1,
    max: 365,
    step: 1,
    unit: '天',
    advanced: true,
  },
  {
    key: 'quotaPollIntervalMs',
    kind: 'number',
    group: 'advanced',
    label: '额度轮询间隔',
    description: '后台刷新账号额度的间隔（毫秒，最小 60000）。调小会增加风控暴露。',
    env: 'DSH_AGY_QUOTA_POLL_INTERVAL_MS',
    min: 60_000,
    max: 86_400_000,
    step: 60_000,
    unit: 'ms',
    msScale: true,
    advanced: true,
  },
  {
    key: 'disableTelemetry',
    kind: 'boolean',
    group: 'advanced',
    label: '关闭遥测',
    description: '向 agy 子进程注入禁用遥测的环境变量。',
    env: 'DSH_AGY_DISABLE_TELEMETRY',
    advanced: true,
  },
  {
    key: 'mcpBridge',
    kind: 'boolean',
    group: 'advanced',
    label: 'MCP 反向桥接（实验性）',
    description: '把 DSH 的工具通过本机回环 MCP 暴露给 agy，让它能调用 DSH 的工具。',
    env: 'DSH_AGY_MCP_BRIDGE',
    advanced: true,
  },
  {
    key: 'mcpToolAllowlist',
    kind: 'string',
    group: 'advanced',
    label: 'MCP 工具白名单',
    description: '逗号分隔的工具名，限制 MCP 桥接暴露哪些工具。留空表示所有非内部工具。',
    env: 'DSH_AGY_MCP_TOOL_ALLOWLIST',
    advanced: true,
  },
  {
    key: 'agyBin',
    kind: 'string',
    group: 'advanced',
    label: 'agy 可执行文件',
    description: '显式指定 agy 二进制路径。留空则按 PATH 与常见安装位置自动探测。',
    env: 'DSH_AGY_BIN',
    advanced: true,
  },
]

/** Lookup by config key (undefined for unknown keys). */
export function settingByKey(key: string): SettingDef | undefined {
  return SETTINGS.find((s) => s.key === key)
}

/**
 * Ordered main sections. The `advanced` group is deliberately absent: it is not
 * a section, it IS the fold, so its members are collected by `planSettings`.
 */
export const SETTING_GROUPS: ReadonlyArray<{ id: SettingGroup; title: string }> = [
  { id: 'general', title: '通用' },
  { id: 'model', title: '模型' },
  { id: 'watchdog', title: '看门狗与超时' },
  { id: 'aux', title: '并发与限流' },
  { id: 'media', title: '图片与媒体' },
]

export interface SettingGroupPlan {
  id: SettingGroup
  title: string
  items: SettingDef[]
}

/**
 * The panel's render plan: every option lands in EXACTLY one place.
 *
 * This lives beside the schema rather than inside the renderer because
 * placement is a property of the option list, not of the drawing code. Keeping
 * it here makes the "rendered once" invariant testable, which matters: the
 * first version of the panel filtered groups and the fold independently, so any
 * option that was both grouped and advanced got drawn twice (8 of them), and
 * options whose group had no section were silently dropped (4 of them).
 *
 * `advanced` options are collected from every group into `fold`, so a section
 * never repeats what the fold already shows.
 */
export function planSettings(): { groups: SettingGroupPlan[]; fold: SettingDef[] } {
  const fold = SETTINGS.filter((s) => s.advanced === true)
  const groups = SETTING_GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    items: SETTINGS.filter((s) => s.advanced !== true && s.group === g.id),
  })).filter((g) => g.items.length > 0)
  return { groups, fold }
}

/**
 * Coerce a value submitted by the settings panel into the type this option
 * expects. Returns a message instead of a value when the input is unusable, so
 * the endpoint can answer 400 with something actionable rather than silently
 * storing a bad value.
 */
export function coerceSetting(def: SettingDef, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (def.kind === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw }
    if (raw === 'true' || raw === '1') return { ok: true, value: true }
    if (raw === 'false' || raw === '0') return { ok: true, value: false }
    return { ok: false, error: def.key + ' expects a boolean' }
  }
  if (def.kind === 'number') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
    if (!Number.isFinite(n)) return { ok: false, error: def.key + ' expects a number' }
    if (def.min !== undefined && n < def.min) return { ok: false, error: def.key + ' must be >= ' + def.min }
    if (def.max !== undefined && n > def.max) return { ok: false, error: def.key + ' must be <= ' + def.max }
    return { ok: true, value: n }
  }
  if (def.kind === 'enum') {
    const s = typeof raw === 'string' ? raw : ''
    if (def.options === undefined || !def.options.some((o) => o.value === s)) {
      return { ok: false, error: def.key + ' must be one of: ' + (def.options ?? []).map((o) => o.value).join(', ') }
    }
    return { ok: true, value: s }
  }
  if (typeof raw !== 'string') return { ok: false, error: def.key + ' expects a string' }
  return { ok: true, value: raw }
}

/** Human-friendly rendering of a millisecond value, e.g. 600000 -> '10 分钟'. */
export function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return ms + ' 毫秒'
  const s = ms / 1000
  if (s < 60) return (Number.isInteger(s) ? s : s.toFixed(1)) + ' 秒'
  const m = s / 60
  if (m < 60) return (Number.isInteger(m) ? m : m.toFixed(1)) + ' 分钟'
  const h = m / 60
  return (Number.isInteger(h) ? h : h.toFixed(1)) + ' 小时'
}
