/**
 * R2834（运营者：「出现重复，必须修复」）：热重载提示的**跨进程**去重。
 *
 * 背景：同一个 chat 可能同时被多个 opencode 进程里的插件实例服务（`--stdio`
 * 会话进程 + `--service` 常驻进程），每个进程都有自己的 `globalThis`。
 * `claimReloadNotice` 只能挡同进程内多个 Bot 的重复提示：实测 08:50:38
 * primary 与 bot5 各发了一条内容相同的「🔄 桥已热重载」，相差 317ms。
 *
 * 这里用共享的 JSON 认领文件把「同一 chat / 同一时间窗只提示一次」扩展到
 * 跨进程。认领过程用 `wx` 独占锁文件串行化，避免两个进程同时读到旧时间戳
 * 后都发一条；锁持有者崩溃时按 mtime 过期回收，不会永久堵死提示。
 *
 * 边界：只做认领，不发送、不记日志；失败时返回 false（宁可少一条提示，
 * 也不重复刷屏）。
 */
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"

/** 锁文件超过这个时长未释放，视为持有者已崩溃，可安全回收。 */
export const RELOAD_CLAIM_LOCK_STALE_MS = 5_000

/** 单次认领最多容忍的锁冲突；超过即放弃本次提示（另一进程正在认领/发送）。 */
const LOCK_TRIES = 3

export const claimReloadNoticeAcrossProcesses = (
  path: string,
  chat: string,
  now: number,
  gapMs: number,
): boolean => {
  if (!path || !chat) return false
  const lock = `${path}.lock`
  let locked = false
  for (let i = 0; i < LOCK_TRIES && !locked; i++) {
    try {
      closeSync(openSync(lock, "wx"))
      locked = true
    } catch {
      // 另一个进程正在认领。可能是它马上要发（本次放弃），也可能是崩溃残留。
      try {
        const st = statSync(lock)
        if (now - st.mtimeMs > RELOAD_CLAIM_LOCK_STALE_MS) unlinkSync(lock)
      } catch {
        /* 锁已消失；下一轮重试 */
      }
    }
  }
  if (!locked) return false
  try {
    let map: Record<string, number> = {}
    try {
      const j = JSON.parse(readFileSync(path, "utf8"))
      if (j && typeof j === "object" && !Array.isArray(j)) {
        for (const [k, v] of Object.entries(j)) {
          if (typeof k === "string" && k && typeof v === "number" && Number.isFinite(v)) map[k] = v
        }
      }
    } catch {
      /* 首次认领 / 文件损坏：按空表处理 */
    }
    // 与同进程版本同一个保留窗口：4 倍间隔，避免文件无限增长。
    for (const k of Object.keys(map)) if (now - map[k] > gapMs * 4) delete map[k]
    const last = map[chat] ?? 0
    if (last > 0 && now - last < gapMs) return false
    map[chat] = now
    const tmp = `${path}.tmp-${process.pid}`
    try {
      writeFileSync(tmp, JSON.stringify(map), { encoding: "utf8", mode: 0o600 })
      renameSync(tmp, path)
    } catch {
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      return false
    }
    return true
  } catch {
    return false
  } finally {
    try {
      unlinkSync(lock)
    } catch {
      /* ignore */
    }
  }
}
