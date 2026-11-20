/**
 * R2687（运营者：「分模块化设计…不改表现」）：Telegram 传输策略的**纯函数层**。
 *
 * 从 tg-bridge.ts 抽出，原因不是“文件大”，而是这些规则此前躺在 14.5k 行的编排闭包里：
 *   · 429 / retry_after / 指数退避 —— 最需要单测，却只能靠桥的静态字符串断言；
 *   · inline keyboard / HTML 降级 —— 同一条规则被发送、分段、编辑三条路径共用；
 *   · stale reply anchor —— 400 降级时丢不丢锚点，直接影响回执是否丢。
 * 现在它们是显式输入/输出的纯函数，桥只负责编排与 I/O。
 *
 * 边界（刻意不做的事）：
 *   · 不发网络请求、不读写文件、不记日志 —— 真正的 fetch 仍在桥里（下一片再抽客户端）；
 *   · 不持有 flood gate / 429 streak 等运行态 —— 那些是实例级状态，归桥的组合根；
 *   · 输出与抽取前逐字节一致，含边界值与降级顺序（见各函数注释）。
 */

// ── 429 / retry_after ────────────────────────────────────────────────────────

// R1635：从 Telegram 错误响应体解析 retry_after（秒）。非 JSON / 无 parameters 返回 0。
export const parseTgRetryAfter = (text: string): number => {
  try {
    const j = JSON.parse(text) as { parameters?: { retry_after?: number } }
    if (j && typeof j === "object") return Number(j?.parameters?.retry_after) || 0
  } catch {
    /* 非 JSON 响应 */
  }
  return 0
}

// R1635：冷却判断。until=冷却截止 ms；now=当前 ms。true=仍在冷却（跳过 rename）。
export const renameCooling = (until: number, now: number): boolean => until > now

// R1834：由 setMyName/setMyShortDescription 的失败响应算出“本次冷却秒数”。
//   * retryAfter > 0             → 用原值；
//   * status===429 且 retryAfter≤0 → 保守兜底（默认 300s，必须装冷却防 hammer）；
//   * 其它状态且无 retry_after    → 0（瞬态错误不额外冷却）。
// 非有限/负数 retryAfter 视为“未给”。
export const rename429Seconds = (status: number, retryAfterSec: number, fallbackS = 300): number => {
  const ra = Number(retryAfterSec)
  if (Number.isFinite(ra) && ra > 0) return Math.max(1, Math.floor(ra))
  return status === 429 ? Math.max(1, Math.floor(fallbackS)) : 0
}

// R1844：botname-429.json 的写入合并。冷却截止是**单调**时间戳，逐 bot 取 max。
// 账本跨 bot/跨实例（重载）共享且是 read-modify-write：取 max 保证并发写不会把某 bot
// 的冷却改小，顺带规范化掉非正/非法条目。返回值可直接 atomicWrite 落盘。
export const mergeRename429Until = (
  disk: Record<string, { until?: number } | undefined>,
  bot: string,
  until: number,
): Record<string, { until: number }> => {
  const out: Record<string, { until: number }> = {}
  for (const [k, v] of Object.entries(disk)) {
    const u = Number(v?.until) || 0
    if (u > 0) out[k] = { until: u }
  }
  out[bot] = { until: Math.max(out[bot]?.until ?? 0, Number(until) || 0) }
  return out
}

// R1636：速率限制（429）时“下一次循环该等多久”的**指数退避**。
// 连续第 n 次 429 的等待 = max(指数项 base·2^(n-1), Telegram 的 retry_after)，封顶 cap；
// 成功一次即清零 attempt。抖动（jitter）让多 Bot / 多会话的重试不在同一个毫秒撞上。
// 不变量：返回值**永远 ≥ min(cap, Telegram 要求的 retry_after)**（抖动因子 ≥1）。
// ⚠️ retry_after > cap（默认 900s）时**不**成立 —— 超大 retry_after 会被 cap 收敛
// （有意为之，见测试“retry_after 巨大时按 cap 收敛”）。
export const FLOOD_BACKOFF_BASE_S = 60
export const FLOOD_BACKOFF_CAP_S = 900
export const FLOOD_BACKOFF_FLOOR_S = 5
export const FLOOD_BACKOFF_JITTER = 0.25

export type FloodBackoffInput = {
  /** Telegram 给的 retry_after（秒）；0/缺省/非法 = 未给。 */
  retryAfter?: number
  /** 已连续挨到的 429 次数（首次 = 1）。0/缺省按“首次”处理。 */
  attempt?: number
  /** 退避基数（秒），默认 60。 */
  baseSeconds?: number
  /** 封顶（秒），默认 900；小于 base 时按 base 处理。 */
  capSeconds?: number
  /** 抖动比例 0..1，默认 0.25。0 = 无抖动（完全确定）。 */
  jitter?: number
  /** 注入 [0,1) 随机数，供测试确定化；缺省取 0.5。 */
  rand?: number
}

export const floodBackoffSeconds = (input: FloodBackoffInput = {}): number => {
  const posOr = (v: unknown, dflt: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : dflt
  }
  const base = posOr(input.baseSeconds, FLOOD_BACKOFF_BASE_S)
  const cap = Math.max(base, posOr(input.capSeconds, FLOOD_BACKOFF_CAP_S))
  const jitter = Math.min(1, Math.max(0, Number(input.jitter ?? FLOOD_BACKOFF_JITTER)))
  const attempt = Math.max(0, Math.floor(posOr(input.attempt, 0)))

  // 指数项 base·2^(attempt-1)。shift 先夹到 30，避免 attempt 很大时溢出成 Infinity。
  const shift = Math.min(Math.max(attempt, 1) - 1, 30)
  const exponential = attempt <= 0 ? base : Math.min(cap, base * Math.pow(2, shift))

  // Telegram 项：尊重 retry_after，仍夹在 [floor, cap]。
  const ra = Number(input.retryAfter ?? 0)
  const telegram = Number.isFinite(ra) && ra > 0 ? Math.min(cap, Math.max(FLOOD_BACKOFF_FLOOR_S, Math.ceil(ra))) : 0

  // 取两者较大者：可以比 Telegram 更保守，但**不能更激进**。
  const wait = Math.max(exponential, telegram)
  if (jitter <= 0) return Math.round(wait)
  const r = Number(input.rand)
  const u = Number.isFinite(r) && r >= 0 && r < 1 ? r : 0.5
  return Math.min(cap, Math.round(wait * (1 + jitter * u)))
}

/** status 0 = fetch 抛异常（网络不可达/DNS/超时），与 429/5xx 一样属于可重试。 */
export const isTransientTgStatus = (status: number): boolean => status === 0 || status === 429 || status >= 500

// ── 发送/编辑的纯策略 ────────────────────────────────────────────────────────

/** Telegram 在 HTTP 2xx 时的统一结果；desc/status 只在失败时有值。 */
export type TelegramResult = {
  ok: boolean
  id?: number
  status?: number
  desc?: string
  retryAfter?: number
  viaFallback?: boolean
}

// callback 只会回到发送消息的 Bot。备用 Bot 没有主 Bot 的 callback 轮询，因此备用
// 发送一律去掉按钮：正文/命令回执立即可达，但不会出现看似可用、实际无法处理的死按钮。
export const fallbackBody = (body: Record<string, unknown>): Record<string, unknown> => {
  if (body.reply_markup !== undefined) {
    const out = { ...body }
    delete out.reply_markup
    return out
  }
  return body
}

// R2543：回复锚点消息可能已被删除（桥重载后旧消息 id 失效、用户删消息）。
// Telegram 返回 400 "message to be replied not found" —— 这不是正文/键盘非法，
// 降级重发时必须丢掉 reply_to_message_id，否则会拿同一个坏锚点再失败一次。
export const replyTargetMissing = (desc: string | undefined): boolean =>
  /message to be replied not found/i.test(desc ?? "")

// R1888：HTML 非法时的纯文本降级。**先解码、后剥标签**：text 是已 htmlEsc 的 HTML
// （随后按 parse_mode=HTML 发出），旧顺序先剥标签打在转义文本上是空操作，紧接着的
// 解码又把 &lt;b&gt; 还原成真标签 → 降级反而把标签当字面文本送到用户面前。
// 两条降级路径（分段/非分段）必须共用这一份，避免顺序再次漂移。
export const plainTextFromHtml = (text: string): string =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<[^>]*>/g, "")

export const validateInlineKeyboard = (kb: unknown): string | null => {
  if (kb === undefined || kb === null) return null
  if (!Array.isArray(kb)) return "inline_keyboard 不是数组"
  for (let i = 0; i < kb.length; i++) {
    const row = kb[i]
    if (!Array.isArray(row)) return `第 ${i} 行不是数组（每行必须是按钮数组）`
    if (row.length === 0) return `第 ${i} 行是空行`
    for (let j = 0; j < row.length; j++) {
      const b = row[j] as any
      if (!b || typeof b !== "object") return `第 ${i} 行第 ${j} 个按钮不是对象`
      const text = String(b.text ?? "")
      if (!text) return `第 ${i} 行第 ${j} 个按钮缺少 text`
      if (text.length > 64) return `第 ${i} 行第 ${j} 个按钮 text 超 64 字符（${text.length}）`
      const data = b.callback_data
      if (data !== undefined) {
        const bytes = Buffer.byteLength(String(data), "utf8")
        if (bytes > 64) return `第 ${i} 行第 ${j} 个按钮 callback_data 超 64 字节（${bytes}: ${String(data).slice(0, 40)}）`
        if (!String(data)) return `第 ${i} 行第 ${j} 个按钮 callback_data 为空`
      }
      if (b.url === undefined && data === undefined && b.web_app === undefined) {
        return `第 ${i} 行第 ${j} 个按钮既没有 callback_data 也没有 url`
      }
    }
  }
  return null
}
