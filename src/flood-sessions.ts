/**
 * R2779（运营者：「如果 tg429 期间换了会话呢」）：记录一轮 429 期间用过的会话。
 *
 * 背景：`rollover429` 会在限流期间把前台换到新会话；恢复时如果只导出“当前会话”，
 * 之前几段续接会话的正文就全丢了（实测 bot5 一轮 6h45m 的限流跨了 12 个会话）。
 *
 * 记法：限流进行中每 15s 心跳把**当时的前台会话**写进本文件；429 写入的瞬间也记
 * 一次（避免换会话发生在下一次心跳之前）。恢复时取并集，按时间合并导出。
 *
 * 为什么独立文件而不是塞进 bot-flood.json：
 *   · bot-flood.json 是跨 Bot 的“谁在限流”事实源，会被其它 Bot 读取/合并；
 *   · 恢复后 `clearSelfFlooded` 会清掉本条，而补发文件是异步的，需要窗口和会话
 *     集合在清标记后仍然可读。
 *
 * 只做状态读写 + 纯合并；渲染/上传/去重策略仍在桥的组合根。
 */
import { atomicWriteJson, readJson, STATE_DIR } from "./state-io"

export type FloodSessionEntry = {
  /** 与 bot-flood.json 的 since 对齐：同一轮限流才累积会话。 */
  since: number
  until: number
  /** 本轮限流期间用过（且被心跳看到）的会话，按出现顺序去重。 */
  sids: string[]
  /** 已成功补发过文件的时间；跨进程防重复。 */
  sentAt?: number
}

export type FloodSessionDisk = Record<string, FloodSessionEntry | undefined>

export const FLOOD_SESSIONS_PATH = `${STATE_DIR}/flood-sessions.json`

/** 单轮限流最多记 64 个会话；正常 rollover 远小于这个数。 */
export const FLOOD_SESSIONS_MAX = 64
/** 超过 24h 的旧记录在下次写入时清掉，避免长驻进程只增不减。 */
export const FLOOD_SESSIONS_MAX_AGE_MS = 24 * 3600_000

const goodMs = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const isSid = (v: unknown): v is string => typeof v === "string" && /^ses_[A-Za-z0-9_-]+$/.test(v)

/**
 * 纯合并：把一次“当前会话”采样并入本轮记录。
 *
 * 规则：
 *   · since 相同才算同一轮（bot-flood.mergeFloodFlag 续期时保留 since）；
 *   · 新一轮（since 不同）重置列表，避免把上一轮会话带进新文件；
 *   · 同一会话重复采样不重复追加、也不移动原位置（否则每 15s 都会写盘）；
 *   · until 取 max —— 续期不会把窗口改短；
 *   · 超过 64 个只保留最近 64 个。
 */
export const mergeFloodSession = (
  prev: FloodSessionEntry | undefined,
  since: number,
  until: number,
  sid: string,
  now = Date.now(),
): FloodSessionEntry | null => {
  const s = goodMs(since)
  const u = goodMs(until)
  if (!(s > 0) || !(u > s)) return prev ?? null
  if (!isSid(sid)) return prev ?? null
  const same = prev && Number(prev.since) === s && goodMs(prev.until) > now - FLOOD_SESSIONS_MAX_AGE_MS
  const base = same ? prev! : undefined
  const list = (base?.sids ?? []).filter((x) => isSid(x))
  if (!list.includes(sid)) list.push(sid)
  return {
    since: s,
    until: Math.max(goodMs(base?.until), u),
    sids: list.slice(-FLOOD_SESSIONS_MAX),
    ...(base?.sentAt ? { sentAt: base.sentAt } : {}),
  }
}

const sameEntry = (a: FloodSessionEntry | undefined, b: FloodSessionEntry | undefined): boolean =>
  Boolean(
    a &&
      b &&
      a.since === b.since &&
      a.until === b.until &&
      (a.sentAt ?? 0) === (b.sentAt ?? 0) &&
      a.sids.join(",") === b.sids.join(","),
  )

export const readFloodSessionsDisk = (): FloodSessionDisk => {
  const j = readJson(FLOOD_SESSIONS_PATH) as { floods?: unknown } | null
  if (j && typeof j === "object" && j.floods && typeof j.floods === "object") return j.floods as FloodSessionDisk
  return {}
}

const writeFloodSessionsDisk = (floods: FloodSessionDisk): void => {
  atomicWriteJson(FLOOD_SESSIONS_PATH, { floods })
}

const prune = (disk: FloodSessionDisk, now: number): FloodSessionDisk => {
  const out: FloodSessionDisk = {}
  for (const [k, v] of Object.entries(disk)) {
    if (!v) continue
    if (goodMs(v.until) > now - FLOOD_SESSIONS_MAX_AGE_MS) out[k] = v
  }
  return out
}

/** 心跳/429 时调用；内容没变就不写盘（15s 一拍不能变成持续空写）。 */
export const noteFloodSession = (bot: string, since: number, until: number, sid: string, now = Date.now()): void => {
  try {
    const disk = readFloodSessionsDisk()
    const next = mergeFloodSession(disk[bot], since, until, sid, now)
    if (!next) return
    if (sameEntry(disk[bot], next)) return
    const out = prune(disk, now)
    out[bot] = next
    writeFloodSessionsDisk(out)
  } catch {
    /* best-effort：补文件是增值功能，绝不影响发送/循环 */
  }
}

/** 恢复时读取；只返回与当前窗口 since 对齐的记录。 */
export const readFloodSessions = (bot: string, since?: number): FloodSessionEntry | undefined => {
  try {
    const e = readFloodSessionsDisk()[bot]
    if (!e) return undefined
    if (since !== undefined && Number(e.since) !== goodMs(since)) return undefined
    return e
  } catch {
    return undefined
  }
}

/** 成功补发后落盘 sentAt：跨进程重启也不会把同一轮窗口再发一遍。 */
export const markFloodSessionsSent = (bot: string, since?: number, now = Date.now()): void => {
  try {
    const disk = readFloodSessionsDisk()
    const e = disk[bot]
    if (!e) return
    if (since !== undefined && Number(e.since) !== goodMs(since)) return
    const next = { ...e, sentAt: now }
    if (sameEntry(e, next)) return
    const out = prune(disk, now)
    out[bot] = next
    writeFloodSessionsDisk(out)
  } catch {
    /* best-effort */
  }
}

/** 测试/排障用：删掉某个 Bot 的记录（不影响 bot-flood.json）。 */
export const clearFloodSessions = (bot: string, since?: number): void => {
  try {
    const disk = readFloodSessionsDisk()
    if (!(bot in disk)) return
    if (since !== undefined && Number(disk[bot]?.since) !== goodMs(since)) return
    const out = prune(disk, Date.now())
    delete out[bot]
    writeFloodSessionsDisk(out)
  } catch {
    /* best-effort */
  }
}
