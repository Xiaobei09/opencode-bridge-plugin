/**
 * R2801（运营者：「查找全部延时轮询实现，全部换成事件机」的收尾）：
 * **按键事件唤醒器**（idle 注入 / 投递闸门 / 停止复核 / 外发排空共用）。
 *
 * 背景：`tg-bridge` 的 `injectMode=idle` 过去用
 * `while (busy) await sleep(3000)` 每 3 秒重查一次会话是否空闲。R2801 先把它
 * 改成事件唤醒；R2842 再把剩下的三处有界条件轮询收进同一个原语：
 *   · `waitTurnContentDelivered` 每 500ms 重查上一回合正文是否投递；
 *   · `verifyTurnEnded` 每 900ms 重查中断后的回合是否真的结束；
 *   · egress stop 后每 500ms 等待外发队列排空。
 *
 * 语义：
 *   · 等待器只负责「可能有状态变化」的唤醒；是否真的满足条件仍由调用方做
 *     权威判定（事件只是提示，不是结论）。
 *   · 注册在前、判定在后：调用方先 `wait()` 再查状态，避免「查完→注册」之间
 *     到达的信号丢失（lost wakeup）。
 *   · `fallbackMs` 是**看门狗/截止时间**，不是轮询间隔：宿主完全没有事件/DB
 *     写入时才有机会用到（例如终端被冻结），保证等待不会永久卡死。
 *   · `cancel()` 只撤销等待，不 resolve；调用方在权威判定满足后撤销即可。
 *   · 同一键多个等待器（主泵/重载后的新实例）都唤醒；不同键互不干扰。
 */

/** 看门狗上限：宿主完全静默时才走这里。正常路径由 completed/idle/DB 事件唤醒。 */
export const IDLE_WAIT_FALLBACK_MS = 30_000

export type EventWait = {
  promise: Promise<void>
  cancel: () => void
}

export type EventWaiters = {
  /** 注册一个等待器；返回的 promise 在 notify/notifyAll/超时时 resolve。 */
  wait: (key: string, fallbackMs?: number) => EventWait
  /** 唤醒某键的全部等待器；返回被唤醒的数量。 */
  notify: (key: string) => number
  /** 唤醒所有键的等待器（DB/状态落盘等全局信号）。 */
  notifyAll: () => number
  /** 当前等待器总数（诊断/测试用）。 */
  pending: () => number
  /** 当前有等待器的键（快照，供 list-idle 逐会话比对）。 */
  sessions: () => string[]
}

/** R2801 的旧名字保留给既有调用/测试；实现已泛化为按键事件唤醒。 */
export type IdleWait = EventWait
export type IdleWaiters = EventWaiters

const unref = (t: unknown): void => {
  const u = (t as { unref?: () => void })?.unref
  if (typeof u === "function") u.call(t)
}

export const createEventWaiters = (defaultFallbackMs = IDLE_WAIT_FALLBACK_MS): EventWaiters => {
  const map = new Map<string, Set<() => void>>()

  const wait = (key: string, fallbackMs = defaultFallbackMs): EventWait => {
    let settled = false
    let resolveFn: () => void = () => {}
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve
    })
    let timer: ReturnType<typeof setTimeout> | undefined

    const detach = (): void => {
      const set = map.get(key)
      if (!set) return
      set.delete(fire)
      if (set.size === 0) map.delete(key)
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

    let set = map.get(key)
    if (!set) {
      set = new Set()
      map.set(key, set)
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

  const notify = (key: string): number => {
    const set = map.get(key)
    if (!set) return 0
    const fires = [...set]
    // 先摘除再触发：fire() 里的 detach 看到的是已清空的 map，不会重复删。
    map.delete(key)
    for (const fn of fires) fn()
    return fires.length
  }

  const notifyAll = (): number => {
    const keys = [...map.keys()]
    let n = 0
    for (const key of keys) n += notify(key)
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

/** R2801 的旧名字：语义不变，仍按会话键等待/唤醒。 */
export const createIdleWaiters = createEventWaiters
