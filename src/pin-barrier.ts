/**
 * R2783（运营者：「有多条消息在队列里时，不会一轮一个，而是一起注入，这是错误的」）：
 * 置顶注入队列的「注入后栅栏」。
 *
 * 泵本身在成功注入一条后会 `break`，但 `doPrompt(delivery:"queue")` 返回时宿主只是
 * **受理**，注入的 user 行可能还没落盘。这个空档里：
 *   · 上一条 assistant 仍是 completed；
 *   · 事件静默期也可能已经超过 10s；
 *   · `idleVerdict` 因此判「空闲」。
 * 于是下一次 poll / idle 事件触发的泵会把第二条也发出去，宿主可能把两条并进同一个
 * 回合 —— 用户看到「一起注入」。
 *
 * 修法：成功注入前登记 `barrierAt`。在会话里看到一条 `barrierAt` 之后的
 * **非 assistant / 非压缩** 消息（就是刚注入的 user/synthetic 行）落盘之前，泵不得
 * 再注入同一会话的下一条。行落盘后，`idleVerdict` 的 `newer-message` 分支会继续
 * 持有到该回合 assistant 完成，于是严格「一个回合一条」。
 *
 * 超时兜底：宿主可能静默丢掉已受理的 prompt（进程重启等），不能让队列永久卡死。
 * 超过 `maxMs` 仍不见行落盘就放行，并由调用方记一条 warn。
 */
export const PIN_BARRIER_MAX_MS = 120_000

export type PinBarrierState = "none" | "landed" | "waiting" | "timeout"

export interface PinBarrierVerdict {
  state: PinBarrierState
  /** 距登记时刻的毫秒数；none 时为 0。 */
  ageMs: number
}

const infoOf = (row: unknown): any => (row as any)?.info ?? row

const createdAt = (row: unknown): number => {
  const info = infoOf(row)
  return Number(info?.time?.created ?? (row as any)?.time?.created ?? 0) || 0
}

const isAssistantRow = (row: unknown): boolean => {
  const info = infoOf(row)
  const role = String(info?.role ?? info?.type ?? "")
  return role === "assistant"
}

/** 行内可见文本（兼容 v1 的 row.parts 与 v2 的 info.parts）。 */
const textOf = (row: unknown): string => {
  const parts = Array.isArray((row as any)?.parts)
    ? (row as any).parts
    : Array.isArray((row as any)?.info?.parts)
      ? (row as any).info.parts
      : []
  return parts
    .filter((p: any) => String(p?.type ?? "") === "text")
    .map((p: any) => String(p?.text ?? ""))
    .join("\n")
}

/**
 * 只认桥自己注入的 TG 用户行。别的 synthetic（rollover / resume / 循环「继续」）即使
 * 先落盘，也不能当作「本条注入已完成」的证据，否则仍可能在宿主队列里再叠一条。
 * 没拿到 parts/文本时退回「任意非 assistant 行」的旧口径，避免宿主形状变化后死等。
 */
const isInjectedUserRow = (row: unknown): boolean => {
  const text = textOf(row)
  return !text || text.includes("[TG user message]")
}

/** 压缩行不是回合，不能拿来证明注入已落盘。兼容 v1（info.compaction）与 v2（type）。 */
const isCompactionRow = (row: unknown): boolean => {
  const info = infoOf(row)
  return info?.compaction === true || String(info?.type ?? (row as any)?.type ?? "") === "compaction"
}

export const pinBarrierVerdict = (
  barrierAt: number,
  rows: unknown,
  now: number,
  maxMs: number = PIN_BARRIER_MAX_MS,
): PinBarrierVerdict => {
  const at = Number(barrierAt) || 0
  if (!(at > 0)) return { state: "none", ageMs: 0 }
  const ageMs = Math.max(0, (Number(now) || Date.now()) - at)
  const arr = Array.isArray(rows) ? rows : []
  for (const row of arr) {
    if (!row || typeof row !== "object") continue
    if (isCompactionRow(row) || isAssistantRow(row)) continue
    if (!isInjectedUserRow(row)) continue
    if (createdAt(row) >= at) return { state: "landed", ageMs }
  }
  const limit = Number(maxMs) > 0 ? Number(maxMs) : PIN_BARRIER_MAX_MS
  if (ageMs > limit) return { state: "timeout", ageMs }
  return { state: "waiting", ageMs }
}
