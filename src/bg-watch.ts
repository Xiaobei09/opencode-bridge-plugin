/**
 * bg-watch：插件层「shell 跑超 N 秒强制转后台」的合规实现（R1488）。
 *
 * 方案史（务必保留）：
 *  · R1482 同名覆盖内置 shell 工具 → 作废。既顶掉内置（宿主报 No tool named "shell"），
 *    又改写发往 provider 的 tools 定义 → Console 免费层 FreeTierError，用户勒令回滚。
 *  · 现路径：**执行期钩子 ctx.tool.hook（execute.before / execute.after）**，只读事件、
 *    不改任何请求；到点（默认 60s）调宿主原生端点 POST /api/session/:id/background
 *    （= TUI 的 ctrl+b：把当前执行中的步丢后台，进程不杀继续跑，完成后宿主把结果带回会话）。
 *    宿主根因要求是「插件判断，不是模型判断」——本模块只靠时钟，不靠模型自觉。
 *
 * 边界：
 *  · 只认 tool === "shell"（本宿主模型侧唯一的 shell 工具名；若未来改名需同步这里）。
 *  · 一个执行步（sessionID:messageID:partID 键）最多 promote 一次。
 *  · execute.after 到达 → 计时器作废（命令已结束，无从"后台"）。
 *  · enabled=false 时全程静默（不计时、不 promote）。
 *  · 永不触碰事件的 input/result（只读）。
 */

/** 默认阈值：60s（用户口径「跑超 1 分钟」）。 */
export const DEFAULT_PROMOTE_MS = 60_000

export interface BgWatchEvent {
  tool?: string
  sessionID?: string
  messageID?: string
  id?: string
  status?: string
  [k: string]: unknown
}

export interface BgWatchDeps {
  /** 熔断：false 时全程静默。外面接 config（默认读 background-mode.json 的 shellPromo）。 */
  enabled: () => boolean
  /**
   * 超时阈值 ms，默认 60_000。
   * R1505 起接受「数字」或「返回数字的函数」：函数会在**每次起计时时**现读
   * （读 background-mode.json 的 promoteMs），做到改配置立即生效、无需重载。
   */
  promoteMs?: number | (() => number)
  /** 只读日志（可空） */
  log?: (line: string) => void
  /** 触发转后台：POST /api/session/:id/background（注入以便单测）。
   *  R1610：第二参 evId = 被 promote 调用的标识（watch key 第三段，v2 为 call_XXX / TUI 为 call_function_XXX），
   *  桥侧据此精确编辑对应执行卡、避免扫描选错卡与日志洪泛。 */
  promote: (sessionID: string, evId?: string) => Promise<unknown>
  /** 测试注入时钟 */
  now?: () => number
  /** 测试注入计时器 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (t: unknown) => void
}

interface WatchEntry {
  timer: unknown
  startedAt: number
  thresholdMs: number
  fired: boolean
}

const keyOf = (ev: BgWatchEvent): string =>
  `${ev.sessionID ?? "?"}:${ev.messageID ?? "?"}:${ev.id ?? "?"}`

export function makeBgWatch(deps: BgWatchDeps) {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimeoutFn ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  /** 现读阈值：数字直接用（保持 R1488 语义）；函数每次起计时时调一次（改配置立即生效）。 */
  const th = (): number => {
    const v = typeof deps.promoteMs === "function" ? deps.promoteMs() : deps.promoteMs
    return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.round(v)) : DEFAULT_PROMOTE_MS
  }
  const entries = new Map<string, WatchEntry>()
  let dead = false

  const fire = (key: string, sid: string): void => {
    if (dead) return
    const e = entries.get(key)
    if (!e) return // after 已清过 → 不 promote
    if (e.fired) return
    e.fired = true
    log(`promote session=${String(sid).slice(0, 12)} (elapsed=${Math.round((now() - e.startedAt) / 1000)}s >= ${Math.round(e.thresholdMs / 1000)}s)`)
    // 保持 e.fired=true 与 entries 存在，避免竞态双发；after 到达时由 onAfter 清理。
    // R1610：把被 promote 的调用标识（key 第三段 = ev.id，v2 为 call_XXX、TUI 为 call_function_XXX）
    // 一并传给 promote，桥侧借此**精确**定位那张执行中卡片，避免扫描选错卡/日志洪泛。
    const evId = String(key).split(":").slice(2).join(":") || undefined
    deps.promote(sid, evId).catch((err) => log(`promote failed: ${String(err).slice(0, 120)}`))
  }

  return {
    /** execute.before：tool=shell 且开启时起计时（阈值现读） */
    onBefore(ev: BgWatchEvent): void {
      if (dead) return
      if (!deps.enabled()) return
      if (ev.tool !== "shell") return
      const key = keyOf(ev)
      const old = entries.get(key)
      if (old) clearTimer(old.timer)
      const ms = th()
      const entry: WatchEntry = { timer: null as unknown, startedAt: now(), thresholdMs: ms, fired: false }
      entry.timer = setTimer(() => fire(key, String(ev.sessionID ?? "")), ms)
      entries.set(key, entry)
      log(`watch start tool=${ev.tool} key=${key} (promote in ${Math.round(ms / 1000)}s)`)
    },
    /** execute.after：该步结束 → 计时作废 */
    onAfter(ev: BgWatchEvent): void {
      if (dead) return
      const key = keyOf(ev)
      const e = entries.get(key)
      if (!e) return
      clearTimer(e.timer)
      entries.delete(key)
      log(`watch end key=${key} (elapsed=${Math.round((now() - e.startedAt) / 1000)}s, fired=${e.fired})`)
    },
    /** 测试/重载崩溃恢复用：清掉全部计时，并使本世代钩子全部失活（后续事件一律忽略） */
    dispose(): void {
      dead = true
      for (const e of entries.values()) clearTimer(e.timer)
      entries.clear()
    },
    /** 测试内省 */
    activeCount(): number {
      return entries.size
    },
  }
}