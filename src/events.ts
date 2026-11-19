/**
 * R2686（运营者：「模块联动采用事件注册/触发机制而不是轮询」）：
 * **进程内领域事件总线** —— 同进程的插件模块通过注册/触发联动，不再互相轮询状态文件。
 *
 * 为什么放在 globalThis：OpenCode 热重载会重新求值模块，模块级变量每个实例各有一份。
 * 订阅表必须跨实例存活，否则 tg-bridge 触发时 auto-continue 的新实例收不到。
 * 同时提供 `owner` 维度：同一模块热重载时先 `offOwner(owner)`，避免旧订阅累积。
 *
 * 边界（刻意不做的事）：
 *   · 不替代跨进程通信。两个 Bot 是不同进程，loop-ctl/tg-chats 仍是唯一事实源；
 *     本总线只做**同进程**的即时通知，文件轮询保留为兜底（60s tick / 10s TTL）。
 *   · 不承载大对象/消息正文。事件只传最小标识（sid/path），订阅方自行读状态。
 *   · 不吞掉错误：处理器异常被隔离，但不影响其它订阅者；触发方不被拖垮。
 */

export type TgEventMap = {
  /** 请求 auto-continue 立即评估某会话（turn-end note 的「继续循环」按钮等）。 */
  "loop:nudge": { sessionID: string }
  /** loop-ctl 总闸写入成功（来源 Bot/模块 + 时间），auto-continue 可立即重评目标。 */
  "loop:changed": { source: string; at: number }
  /** 桥的状态文件落盘成功（path），订阅方可失效自己的短 TTL 缓存，而不必等过期。 */
  "state:changed": { path: string; at: number }
  /** auto-continue 成功压缩会话后立即通知桥补发「已压缩」卡（R2789：替代 15s 轮询）。 */
  "compaction:done": { sessionID: string; at: number; reason: string }
}

type Handler = (payload: any) => void
type Entry = { fn: Handler; owner: string }
type Bus = { handlers: Map<string, Set<Entry>> }

const BUS_KEY = "__tgDomainEventBusR2686"

const bus = (): Bus => {
  const g = globalThis as Record<string, unknown>
  let b = g[BUS_KEY] as Bus | undefined
  if (!b || !(b.handlers instanceof Map)) {
    b = { handlers: new Map() }
    g[BUS_KEY] = b
  }
  return b
}

/**
 * 注册事件处理器，返回取消函数。
 * `owner` 用于热重载清理（同一 owner 的旧订阅可被 `offOwner` 一次性移除）。
 */
export const on = <K extends keyof TgEventMap>(
  event: K,
  fn: (payload: TgEventMap[K]) => void,
  owner = "anonymous",
): (() => void) => {
  const b = bus()
  let set = b.handlers.get(event)
  if (!set) {
    set = new Set()
    b.handlers.set(event, set)
  }
  const entry: Entry = { fn: fn as Handler, owner }
  set.add(entry)
  return () => {
    const cur = b.handlers.get(event)
    cur?.delete(entry)
    if (cur && cur.size === 0) b.handlers.delete(event)
  }
}

/** 移除某 owner 的全部订阅（模块重新装载前调用，避免旧实例累积）。 */
export const offOwner = (owner: string): void => {
  const b = bus()
  for (const [event, set] of b.handlers) {
    for (const entry of [...set]) if (entry.owner === owner) set.delete(entry)
    if (set.size === 0) b.handlers.delete(event)
  }
}

/** 触发事件，返回成功执行的处理器数量（0 = 当前进程没有订阅者）。 */
export const emit = <K extends keyof TgEventMap>(event: K, payload: TgEventMap[K]): number => {
  const set = bus().handlers.get(event)
  if (!set || set.size === 0) return 0
  let ok = 0
  for (const entry of [...set]) {
    try {
      entry.fn(payload)
      ok++
    } catch {
      /* 单个订阅者失败不影响其它订阅者，也不把触发方拖垮 */
    }
  }
  return ok
}

/** 诊断/测试用：当前订阅数（不传 event = 全部）。 */
export const listenerCount = (event?: keyof TgEventMap): number => {
  const b = bus()
  if (event) return b.handlers.get(event)?.size ?? 0
  let n = 0
  for (const set of b.handlers.values()) n += set.size
  return n
}
