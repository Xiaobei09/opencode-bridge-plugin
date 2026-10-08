/**
 * 中止事件分类 + 遥测（R1548）
 *
 * 背景：用户在 TUI 按 ESC → 宿主在末条 assistant 消息上写 error（实测
 * error.name="aborted"）。auto-continue 旧代码只认精确名 "MessageAbortedError"
 * 才走「用户中止 → 停循环」，而 host 实际给出的 "aborted" 落进致命错误 RECOVER
 * 分支 → 注入恢复提示 → 循环在暂停后复活（用户 2026-09-29 实测报告）。
 *
 * 本模块收敛两点：
 *   ① 分类判据（纯函数，可单测）：中止族错误按下述三要素分类——
 *      pause   新鲜中止（锚=time.completed||time.created，窗口默认 180s）且无用户后续发言：
 *              用户撤销（ESC//stop）。**仅暂停该会话本轮** —— 不写全局 loop-ctl 闸、
 *              其他会话照常循环；该会话下一条用户消息自然恢复（R1553 语义修正：
 *              用户确认「ESC 应是仅本轮暂停，不是永久停循环」）。
 *      skip    新鲜中止但有用户后续发言：不停闸也不注入恢复提示（用户消息自然续跑，
 *              自动注入会把双份提示叠上去）。
 *      recover 陈旧中止或无时间锚：不是「当下撤销」行为，保持既有可恢复恢复提示路径
 *             （与 provider 瞬时错误同等待遇；中止族之外的错误不受本模块影响）。
 *   ② 遥测：每次中止事件/判定落盘 abort-events.json（cap 200），供「监测取消事件」。
 *
 * 语义沿革：R1548 曾把「新鲜+无用户后续」判为 stop（写全局 stopped=true 硬闸），
 * 用户实测按 ESC 后整循环死透（需 /loop start 才能复活），2026-09-29 澄清：
 * 「在 tui 使用 esc 导致的应该是仅本轮暂停，不是永久」「不同会话分开」→ 改 pause。
 */

import { readFileSync, writeFileSync } from "node:fs"

export type AbortVerdict = "pause" | "skip" | "recover"

export interface AbortClassifyArgs {
  /** msg.time.completed（0=宿主未写） */
  completed: number
  /** msg.time.created（0=未知） */
  created: number
  /** 末条真实用户消息 time.created；0=无 */
  lastUserTime: number
  /** 新鲜度窗口 ms，默认 180_000（与 auto-continue 的 ABORT_STALE_MS 对齐） */
  staleMs?: number
  /** 测试注入时钟，默认 Date.now() */
  now?: number
  /**
   * 本插件实例的启动时刻（Date.now()）。R1910：用于区分「进程重启打断的在途回合」与
   * 「用户按 ESC」。见 classifyAbort 内说明；缺省不参与判定（老行为）。
   */
  bootAt?: number
}

export interface AbortDecision {
  verdict: AbortVerdict
  fresh: boolean
  userAfter: boolean
  /** 新鲜度锚点 = completed || created；0 表示两者皆无 */
  anchor: number
}

export const classifyAbort = (a: AbortClassifyArgs): AbortDecision => {
  const now = a.now ?? Date.now()
  const staleMs = a.staleMs ?? 180_000
  const anchor = a.completed > 0 ? a.completed : a.created
  const fresh = anchor > 0 && now - anchor < staleMs
  const userAfter = anchor > 0 && a.lastUserTime > anchor
  // R1910：进程自己重启/热重载会打断在途回合（host 在**上一实例创建**的 assistant 消息上
  // 写 error=aborted）。这不是用户按 ESC，不能按"新鲜中止 → pause"处理：pause 分支会
  // `settle()` 把该消息记进 `decided`，而 evaluate 在拿消息后 `if (decided.has(msg.id)) return`
  // 是**唯一不打日志的静默早退** —— 于是该会话此后每 60s 的评估都被它吞掉，永远走不到
  // classifyAbort 的"超龄(>staleMs) → recover"分支，症状是**该会话循环永久停摆且无任何日志**
  //（实测 bot2 两度停摆 30+ 分钟）。
  // 判据：消息 time.created 早于本实例启动时刻 = 它是上一实例的在途回合、被我们的启动杀掉
  //（真正的用户 ESC 只会发生在本实例启动之后，created >= bootAt）。→ recover 走既有恢复提示。
  const restartCaused =
    a.bootAt !== undefined && a.bootAt > 0 && a.created > 0 && a.created < a.bootAt
  let verdict: AbortVerdict = "recover"
  if (restartCaused) verdict = userAfter ? "skip" : "recover"
  else if (fresh && !userAfter) verdict = "pause"
  else if (fresh && userAfter) verdict = "skip"
  return { verdict, fresh, userAfter, anchor }
}

const ABORT_EVENTS_CAP = 200
/** 遥测文件路径：默认生产路径，可用 AC_ABORT_EVENTS_PATH 覆盖（测试隔离用）；
 *  惰性读取以支持测试运行时覆盖。 */
const abortEventsPath = (): string =>
  process.env.AC_ABORT_EVENTS_PATH ?? "REDACTED_ROOT/.config/opencode/abort-events.json"

export interface AbortEvent {
  ts: number
  session: string
  name: string
  verdict: AbortVerdict
  fresh: boolean
  userAfter: boolean
  src: "eval" | "serve-event" | "tui-event"
}

/** 追加一条中止事件；cap 200、原子写、best-effort（遥测绝不阻断主逻辑）。 */
export const noteAbortEvent = (ev: AbortEvent): void => {
  try {
    let events: AbortEvent[] = []
    try {
      const j = JSON.parse(readFileSync(abortEventsPath(), "utf8")) as any
      if (Array.isArray(j?.events)) events = j.events as AbortEvent[]
    } catch {
      /* first write */
    }
    events = [...events, ev].slice(-ABORT_EVENTS_CAP)
    writeFileSync(
      abortEventsPath(),
      JSON.stringify({ events, updatedAt: Date.now() }),
      { encoding: "utf8", mode: 0o600 },
    )
  } catch {
    /* best-effort */
  }
}