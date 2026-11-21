/**
 * R2789（运营者：「查找全部延时轮询实现，全部换成事件机」）：
 * **文件系统事件机** —— 跨进程的请求目录/状态文件不再按固定间隔轮询。
 *
 * 为什么需要它：rollover / quota-fork / CI 恢复请求、占用租约、限流标记、
 * session DB 都可能是**别的进程**（CI 脚本、另一个 Bot、宿主）写的。进程内
 * events.ts 看不到这些变化；固定 2s/15s/30s 轮询既慢又空转。fs.watch 把
 * “变化发生”本身变成事件，启动时再做一次扫描兜住注册前的存量文件。
 *
 * 语义（刻意固定下来，避免各调用点各写一套）：
 *   · 同一路径只保留一个 fs.watch（热重载不会叠加监听器）；
 *   · owner 重注册 = 替换旧回调（旧实例的异步回调仍由调用方的代数守卫负责）；
 *   · 事件先防抖（默认 80ms），再**串行**执行回调；运行期间的新事件合并成
 *     一次 pending 重跑，原子 rename 连发多次也不会漏掉最后一个文件；
 *   · 文件监听的是父目录并按 basename/过滤函数匹配 —— tmp+rename 原子写不丢事件；
 *   · 目录被删除/监听器报错时按 2s 退避重建，不把主机拖进忙等；
 *   · `persistent:false`：监听器本身不阻止进程退出。
 */

import { existsSync, mkdirSync, watch, type FSWatcher } from "node:fs"
import { basename, dirname } from "node:path"

export type WatchRun = () => void | Promise<void>

export type WatchOptions = {
  /** 同一 owner 再次注册时替换旧回调（热重载清理）。 */
  owner?: string
  /** 合并突发事件的窗口；默认 80ms。 */
  debounceMs?: number
  /** 目录不存在时是否创建（请求目录需要；状态文件目录通常已存在）。 */
  ensure?: boolean
  /** 只对匹配的文件名触发；默认目录=全部，文件=basename 精确匹配。 */
  match?: (filename: string) => boolean
  /** 注册后是否立即跑一次（兜住注册前的存量），默认 true。 */
  scanOnStart?: boolean
}

type Handler = { owner: string; fn: WatchRun }

type WatchState = {
  key: string
  target: string
  isDir: boolean
  base: string
  handlers: Map<string, Handler>
  watcher: FSWatcher | null
  timer: ReturnType<typeof setTimeout> | null
  retry: ReturnType<typeof setTimeout> | null
  running: boolean
  pending: boolean
  closed: boolean
  debounceMs: number
  ensure: boolean
  match?: (filename: string) => boolean
}

type Registry = { states: Map<string, WatchState> }
const REG_KEY = "__tgFsEventMachineR2789"

const registry = (): Registry => {
  const g = globalThis as Record<string, unknown>
  let r = g[REG_KEY] as Registry | undefined
  if (!r || !(r.states instanceof Map)) {
    r = { states: new Map() }
    g[REG_KEY] = r
  }
  return r
}

const unref = (t: unknown): void => {
  const u = (t as { unref?: () => void })?.unref
  if (typeof u === "function") u.call(t)
}

const schedule = (st: WatchState, delay: number): void => {
  if (st.closed) return
  if (st.running) {
    st.pending = true
    return
  }
  if (st.timer) {
    if (delay > 0) return // 已有防抖窗口：让已有那次统一跑
    clearTimeout(st.timer)
  }
  st.timer = setTimeout(() => {
    st.timer = null
    if (st.closed) return
    if (st.running) {
      st.pending = true
      return
    }
    void runHandlers(st)
  }, Math.max(0, delay))
  unref(st.timer)
}

const runHandlers = async (st: WatchState): Promise<void> => {
  st.running = true
  try {
    for (const h of [...st.handlers.values()]) {
      if (st.closed) break
      try {
        await h.fn()
      } catch {
        /* 单个订阅者失败不阻断其它订阅者，也不把 fs.watch 回调拖垮 */
      }
    }
  } finally {
    st.running = false
    if (st.pending && !st.closed) {
      st.pending = false
      schedule(st, 0)
    }
  }
}

const arm = (st: WatchState): void => {
  if (st.closed || st.watcher) return
  try {
    if (st.ensure) mkdirSync(st.isDir ? st.target : dirname(st.target), { recursive: true })
    const watchTarget = st.isDir ? st.target : dirname(st.target)
    // 目标目录不存在时 fs.watch 会抛 ENOENT；等目录出现后由 rearm 重建。
    if (!existsSync(watchTarget)) {
      rearm(st)
      return
    }
    const w = watch(watchTarget, { persistent: false }, (_event, filename) => {
      const name = filename == null ? "" : String(filename)
      if (name) {
        if (!st.isDir && name !== st.base && !(st.match?.(name) ?? false)) return
        if (st.isDir && st.match && !st.match(name)) return
      }
      schedule(st, st.debounceMs)
    })
    w.on("error", () => {
      try {
        w.close()
      } catch {
        /* ignore */
      }
      if (st.watcher === w) st.watcher = null
      rearm(st)
    })
    w.on("close", () => {
      if (st.watcher === w) st.watcher = null
      if (!st.closed) rearm(st)
    })
    st.watcher = w
  } catch {
    st.watcher = null
    rearm(st)
  }
}

const rearm = (st: WatchState): void => {
  if (st.closed || st.watcher || st.retry) return
  st.retry = setTimeout(() => {
    st.retry = null
    arm(st)
  }, 2_000)
  unref(st.retry)
}

const stateFor = (target: string, isDir: boolean, opts: WatchOptions): WatchState => {
  // 目录/文件分别建 state：同一目录既可能被“监听目录”也可能被“监听其中某个文件”
  // 使用，共用 key 会让后注册的语义覆盖前一个。
  const key = `${isDir ? "dir" : "file"}:${target}`
  const reg = registry()
  let st = reg.states.get(key)
  if (!st) {
    st = {
      key,
      target,
      isDir,
      base: basename(target),
      handlers: new Map(),
      watcher: null,
      timer: null,
      retry: null,
      running: false,
      pending: false,
      closed: false,
      debounceMs: Math.max(0, Number(opts.debounceMs ?? 80) || 80),
      ensure: opts.ensure === true,
      match: opts.match,
    }
    reg.states.set(key, st)
  }
  return st
}

const register = (target: string, isDir: boolean, fn: WatchRun, opts: WatchOptions): (() => void) => {
  const owner = String(opts.owner ?? "anonymous")
  const st = stateFor(target, isDir, opts)
  // owner 重注册 = 替换（不是叠加）；不同 owner 可共享同一个 watcher。
  st.handlers.set(owner, { owner, fn })
  st.ensure = st.ensure || opts.ensure === true
  if (opts.match) st.match = opts.match
  if (!st.watcher) arm(st)
  if (opts.scanOnStart !== false) schedule(st, 0)
  return () => {
    const cur = st.handlers.get(owner)
    if (cur && cur.fn === fn) st.handlers.delete(owner)
    if (st.handlers.size === 0) {
      st.closed = true
      try {
        if (st.timer) clearTimeout(st.timer)
      } catch {
        /* ignore */
      }
      try {
        if (st.retry) clearTimeout(st.retry)
      } catch {
        /* ignore */
      }
      try {
        st.watcher?.close()
      } catch {
        /* ignore */
      }
      st.watcher = null
      registry().states.delete(st.key)
    }
  }
}

/** 监听目录变化（改名/新增/删除都触发）；注册后立即扫描一次。 */
export const watchDir = (dir: string, fn: WatchRun, opts: WatchOptions = {}): (() => void) =>
  register(dir, true, fn, opts)

/** 监听单个文件；实际监听父目录，因此 tmp+rename 原子写同样会触发。 */
export const watchFile = (file: string, fn: WatchRun, opts: WatchOptions = {}): (() => void) =>
  register(file, false, fn, opts)

/**
 * 同进程写完请求后主动踢一脚（不等 fs.watch 的调度）。
 * 用于“写请求的代码”和“消费请求的代码”在同一进程时降低延迟。
 */
export const triggerWatch = (target: string): void => {
  const reg = registry()
  const dir = reg.states.get(`dir:${target}`)
  if (dir) schedule(dir, 0)
  for (const [key, st] of reg.states) {
    if (!key.startsWith("file:")) continue
    if (st.target === target || dirname(st.target) === target) schedule(st, 0)
  }
}

/** 诊断/测试用：当前仍在监听的路径数。 */
export const watchCount = (): number => registry().states.size
