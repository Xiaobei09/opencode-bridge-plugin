/**
 * R2672：turn-end note 的「🔁 继续循环」按钮 → auto-continue 即时评估。
 *
 * 为什么需要一条进程内通道：循环状态（loop-sessions.json / loop-sessions-off.json）
 * 是**轮询**语义 —— auto-continue 有 60s 兜底 tick，空闲观测只在 `time.idle` 变化时
 * 触发。用户按下「继续循环」时回合刚结束，idle 不会再变；若只写文件，用户可能要等
 * ≤60s 才看到下一轮，看起来像按钮无效。
 *
 * 这里用 globalThis 注册一个回调（两个插件同进程，且热重载会重新求值模块，模块级
 * 变量每个实例各有一份）。新实例覆盖旧实例；旧实例即使被调用也会在回调里用
 * auto-continue 的代数键自行拦截。没有 auto-continue（TUI / 测试 / 未加载）时
 * nudge 返回 false，调用方只记日志，不把它当失败。
 */

export const AC_NUDGE_KEY = "__acNudge"

export type AutoContinueNudge = (sessionID: string) => void

/** 注册/清除当前进程的 nudge 回调（传 null 清除）。 */
export const installAutoContinueNudge = (fn: AutoContinueNudge | null): void => {
  const g = globalThis as Record<string, unknown>
  if (typeof fn === "function") g[AC_NUDGE_KEY] = fn
  else if (AC_NUDGE_KEY in g) delete g[AC_NUDGE_KEY]
}

/** 立即催 auto-continue 评估该会话。返回 false = 当前进程没有可用的自动循环。 */
export const nudgeAutoContinue = (sessionID: string): boolean => {
  if (!String(sessionID ?? "").startsWith("ses_")) return false
  const fn = (globalThis as Record<string, unknown>)[AC_NUDGE_KEY]
  if (typeof fn !== "function") return false
  try {
    ;(fn as AutoContinueNudge)(sessionID)
    return true
  } catch {
    return false
  }
}
