/**
 * R2832（运营者：「13：45再次出现消息重复发送，必须完全解决！」）：
 * 过期注入队列条目的判定。
 *
 * 背景：idle 模式下用户消息先入 pinqueue，再由泵逐条注入。运营者 13:45 的
 * 投诉在 R2826 已从队列卡读到并处理，但条目一直留在队列里；07:05 又被补投，
 * 同一个问题被回答第二次。这里给泵一道「被后续消息越过」的闸：
 * 若会话里已有比该条目晚 30 分钟以上的 TG 用户消息，说明它已是旧副本，
 * 注入前跳过，避免重复执行。
 *
 * 只处理带真实时间戳的条目；缺失/为 0 时 fail-open（照常注入），
 * 避免历史遗留条目被误杀。
 */
export const PIN_SUPERSEDED_GAP_MS = 30 * 60_000

const TG_USER_PREFIX = "[TG user message]"

const rowCreatedAt = (row: any): number =>
  Number(row?.info?.time?.created ?? row?.time?.created ?? 0) || 0

const rowText = (row: any): string => {
  if (typeof row?.text === "string" && row.text) return row.text
  if (Array.isArray(row?.parts)) {
    return row.parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
  }
  return ""
}

/** 会话快照里最新一条「TG 用户消息」的创建时间；没有则返回 0。 */
export const newestTgUserCreatedAt = (rows: readonly unknown[]): number => {
  let newest = 0
  for (const raw of rows) {
    const row: any = raw
    const role = row?.info?.role ?? row?.role
    if (role !== "user") continue
    if (!rowText(row).includes(TG_USER_PREFIX)) continue
    const t = rowCreatedAt(row)
    if (t > newest) newest = t
  }
  return newest
}

/** 队列条目是否已被会话里更晚的 TG 消息越过（超过 gapMs）。 */
export const isSupersededPin = (
  itemTs: number,
  newestTgUserAt: number,
  gapMs: number = PIN_SUPERSEDED_GAP_MS,
): boolean => {
  if (!Number.isFinite(itemTs) || itemTs <= 0) return false
  if (!Number.isFinite(newestTgUserAt) || newestTgUserAt <= 0) return false
  return newestTgUserAt - itemTs > Math.max(0, gapMs)
}
