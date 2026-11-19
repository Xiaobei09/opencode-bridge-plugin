/**
 * R2789（运营者：「重复方法合并，队列化，避免竞争关系」）：
 * **同名任务串行队列** —— 事件机可能同时收到多个来源的唤醒（目录事件、DB 事件、
 * 进程内事件、deadline），如果每个都直接 `void processX()`，两个扫描会并发改同一份
 * front/pinned/请求文件，出现“后读到的旧快照覆盖新值”的竞争。
 *
 * 规则：
 *   · 同一个 queue 内严格串行（一次只跑一个任务）；
 *   · 同一个 key 已在排队/运行时不重复入队；运行期间再次 push 只标一次“重跑”，
 *     保证扫描看到最新文件状态，又不会因为 10 个 fs 事件跑 10 遍；
 *   · 任务异常被隔离，队列继续；`idle()` 供测试/停机等待。
 *
 * 队列放 globalThis：OpenCode 热重载会重新求值模块，队列必须跨实例存活，
 * 否则旧实例正在跑的任务与新实例入队的任务会重新并发。
 */

export type TaskRun = () => void | Promise<void>

export type TaskQueue = {
  /** 入队；同 key 去重，运行中再次入队会在当前任务结束后补跑一次。 */
  push: (key: string, fn: TaskRun) => void
  /** 队列长度（含正在运行的任务）。 */
  size: () => number
  /** 等待队列清空；测试/停机用。 */
  idle: () => Promise<void>
}

type State = {
  pending: Map<string, TaskRun>
  running: string | null
  draining: boolean
  waiters: Array<() => void>
}

const REG_KEY = "__tgTaskQueuesR2789"

const registry = (): Map<string, State> => {
  const g = globalThis as Record<string, unknown>
  let r = g[REG_KEY] as Map<string, State> | undefined
  if (!(r instanceof Map)) {
    r = new Map()
    g[REG_KEY] = r
  }
  return r
}

const stateFor = (name: string): State => {
  const reg = registry()
  let st = reg.get(name)
  if (!st) {
    st = { pending: new Map(), running: null, draining: false, waiters: [] }
    reg.set(name, st)
  }
  return st
}

const settle = (st: State): void => {
  if (st.running || st.pending.size > 0) return
  const ws = st.waiters.splice(0)
  for (const w of ws) {
    try {
      w()
    } catch {
      /* ignore */
    }
  }
}

const drain = async (st: State): Promise<void> => {
  if (st.draining) return
  st.draining = true
  try {
    for (;;) {
      const first = st.pending.entries().next()
      if (first.done) break
      const [key, fn] = first.value
      st.pending.delete(key)
      st.running = key
      try {
        await fn()
      } catch {
        /* 任务失败不能堵死队列；下次事件会重试 */
      } finally {
        st.running = null
      }
    }
  } finally {
    st.draining = false
    settle(st)
  }
}

/** 取（或创建）一个命名串行队列。 */
export const taskQueue = (name: string): TaskQueue => {
  const st = stateFor(name)
  return {
    push: (key: string, fn: TaskRun): void => {
      const k = String(key || "default")
      // 运行中的同 key：只保留最新一次重跑（Map.set 覆盖旧闭包）。
      st.pending.set(k, fn)
      if (st.running === k) return // drain 的 for 循环会在当前任务结束后再取到它
      void drain(st)
    },
    size: (): number => st.pending.size + (st.running ? 1 : 0),
    idle: (): Promise<void> => {
      if (!st.running && st.pending.size === 0) return Promise.resolve()
      return new Promise<void>((resolve) => st.waiters.push(resolve))
    },
  }
}
