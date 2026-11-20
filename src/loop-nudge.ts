/**
 * R2672/R2686：turn-end note 的「🔁 继续循环」按钮 → auto-continue 即时评估。
 *
 * 为什么需要一条进程内通道：循环状态（loop-sessions.json / loop-sessions-off.json）
 * 是**轮询**语义 —— auto-continue 有 60s 兜底 tick，空闲观测只在 `time.idle` 变化时
 * 触发。用户按下「继续循环」时回合刚结束，idle 不会再变；若只写文件，用户可能要等
 * ≤60s 才看到下一轮，看起来像按钮无效。
 *
 * R2686（运营者：「模块联动采用事件注册/触发机制而不是轮询」）：原先这里自建
 * globalThis 回调槽，现在统一走 events.ts 的 `loop:nudge` 事件；订阅表跨热重载存活，
 * 且 `offOwner` 保证重新安装时不会累积旧实例。没有 auto-continue（TUI/测试/未加载）
 * 时 emit 返回 0，nudge 返回 false，调用方只记日志，不把它当失败。
 */
import { emit, offOwner, on } from "./events"

export type AutoContinueNudge = (sessionID: string) => void

/** 兼容旧代码/测试的 globalThis 槽名；实际订阅已由 events.ts 管理。 */
export const AC_NUDGE_KEY = "__acNudge"
const OWNER = "loop-nudge"

/** 注册/清除当前进程的 nudge 回调（传 null 清除）。 */
export const installAutoContinueNudge = (fn: AutoContinueNudge | null): void => {
  offOwner(OWNER)
  if (typeof fn !== "function") return
  on(
    "loop:nudge",
    ({ sessionID }) => {
      try {
        fn(sessionID)
      } catch {
        /* 订阅者失败不拖垮按钮回调 */
      }
    },
    OWNER,
  )
}

/** 立即催 auto-continue 评估该会话。返回 false = 当前进程没有可用的自动循环。 */
export const nudgeAutoContinue = (sessionID: string): boolean => {
  if (!String(sessionID ?? "").startsWith("ses_")) return false
  return emit("loop:nudge", { sessionID }) > 0
}
