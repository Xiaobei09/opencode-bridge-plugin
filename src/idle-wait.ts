/**
 * R2801（运营者：「查找全部延时轮询实现，全部换成事件机」的收尾）：
 * **注入 idle 等待的事件唤醒器**。
 *
 * 背景：`tg-bridge` 的 `injectMode=idle` 过去用
 * `while (busy) await sleep(3000)` 每 3 秒重查一次会话是否空闲。这是最后一处
 * 真正的条件轮询，既把回合结束后的注入延迟最多拖 3 秒，也在长回合里空转。
 *
 * 语义：
 *   · 等待器只负责「可能有回合边界」的唤醒；是否真的空闲仍由 `turnActuallyIdle`
 *     的权威判定决定（事件只是提示，不是结论）。
 *   · 注册在前、判定在后：调用方先 `wait()` 再查状态，避免「查完→注册」之间
 *     到达的 completed/idle 信号丢失（lost wakeup）。
 *   · `fallbackMs` 是**看门狗**，不是轮询间隔：宿主完全没有事件/DB 写入时才有
 *     机会用到（例如终端被冻结），保证等待不会永久卡死。
 *   · `cancel()` 只撤销等待，不 resolve；调用方在权威判定为 idle 后撤销即可。
 *   · 同一会话多个等待器（主泵/重载后的新实例）都唤醒；不同会话互不干扰。
 */

/** 看门狗上限：宿主完全静默时才走这里。正常路径由 completed/idle/DB 事件唤醒。 */
export const IDLE_WAIT_FALLBACK_MS = 30_000

export type IdleWait = {
  promise: Promise<void>
  cancel: () => void
}

export type IdleWaiters = {
  /** 注册一个等待器；返回的 promise 在 notify/notifyAll/超时时 resolve。 */
  wait: (sid: string, fallbackMs?: number) => IdleWait
  /** 唤醒某会话的全部等待器；返回被唤醒的数量。 */
  notify: (sid: string) => number
  /** 唤醒所有会话的等待器（loop 停止等全局信号）。 */
  notifyAll: () => number
  /** 当前等待器总数（诊断/测试用）。 */
  pending: () => number
  /** 当前有等待器的会话 ID（快照，供 list-idle 轮询逐会话比对）。 */
  sessions: () => string[]
}

const unref = (t: unknown): void => {
  const u = (t as { unref?: () => void })?.unref
  if (typeof u === "function") u.call(t)
}

export const createIdleWaiters = (defaultFallbackMs = IDLE_WAIT_FALLBACK_MS): IdleWaiters => {
  const map = new Map<string, Set<() => void>>()

  const wait = (sid: string, fallbackMs = defaultFallbackMs): IdleWait => {
    let settled = false
    let resolveFn: () => void = () => {}
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve
    })
    let timer: ReturnType<typeof setTimeout> | undefined

    const detach = (): void => {
      const set = map.get(sid)
      if (!set) return
      set.delete(fire)
      if (set.size === 0) map.delete(sid)
    }

    const fire = (): void => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      detach()
      resolveFn()
    }

    let set = map.get(sid)
    if (!set) {
      set = new Set()
      map.set(sid, set)
    }
    set.add(fire)
    timer = setTimeout(fire, Math.max(1, Number(fallbackMs) || defaultFallbackMs))
    // 等待器自身不能阻止进程退出（CI 每轮会重建进程）。
    unref(timer)

    return {
      promise,
      cancel: () => {
        if (settled) return
        settled = true
        if (timer) {
          clearTimeout(timer)
          timer = undefined
        }
        detach()
      },
    }
  }

  const notify = (sid: string): number => {
    const set = map.get(sid)
    if (!set) return 0
    const fires = [...set]
    // 先摘除再触发：fire() 里的 detach 看到的是已清空的 map，不会重复删。
    map.delete(sid)
    for (const fn of fires) fn()
    return fires.length
  }

  const notifyAll = (): number => {
    const sids = [...map.keys()]
    let n = 0
    for (const sid of sids) n += notify(sid)
    return n
  }

  const pending = (): number => {
    let n = 0
    for (const set of map.values()) n += set.size
    return n
  }

  const sessions = (): string[] => [...map.keys()]

  return { wait, notify, notifyAll, pending, sessions }
}
