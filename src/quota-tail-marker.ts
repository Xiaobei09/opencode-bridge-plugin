/**
 * R2676（运营者选定 fix 1）：同一个 CI run 内，`resume-once` 的额度尾恢复与
 * `auto-continue` 的 pre-boot 429 恢复**只能有一个**注入同一条尾消息。
 *
 * 背景（bot5 ses_e1c244d52ffe2otPfmtb2UE0ob，2026-11-16 20:08:57）：
 *   · 新 run 换出口后，resume-once 判定 `quota-recovered` 并注入「额度尾恢复」；
 *   · 同一秒 auto-continue 也看到这条 pre-boot 429 尾条，按 fatal recover 又注入
 *     一次「继续」；
 *   · 两条消息都进了同一会话，用户看到重复恢复。
 *
 * 约束（运营者明确否决时间限制）：
 *   · 不设冷却、不设时间窗、不拖慢「秒失败 → 换出口」；
 *   · 只针对**本 run + 这一条 message id** 排他，后来的新 429 仍可正常恢复；
 *   · 标记放在 `$RUNNER_TEMP`，每个 GitHub run 天然独立；下一 run 重新获得机会。
 *
 * 认领使用 `wx` 独占创建：resume-once / auto-continue 谁先写谁赢，另一方只跳过
 * 这一条尾消息，不改变各自的后续轮次。损坏、旧 run 或字段不匹配的标记会被清理
 * 后重试一次，避免一个坏文件永久挡住恢复。
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"

export const QUOTA_TAIL_MARKER_VERSION = 1

export type QuotaTailMarker = {
  v: number
  sid: string
  msgId: string
  run: string
  owner: string
  at: number
}

export type QuotaTailClaimResult = "ok" | "exists" | "error"

export type PreBootQuotaTailInput = {
  hasError: boolean
  rateLimit: boolean
  created: number
  bootAt: number
}

const SID_RE = /^ses_[A-Za-z0-9_-]+$/
const MAX_MSG_ID = 240

const runID = (): string => String(process.env.GITHUB_RUN_ID ?? "")
const tempDir = (): string => `${process.env.RUNNER_TEMP ?? "/tmp/opencode"}`

const filePart = (value: string): string => encodeURIComponent(value)

/** 供测试与实际排障使用：标记文件的确定路径。 */
export const quotaTailMarkerPath = (sid: string, msgId: string): string =>
  `${tempDir()}/quota-tail-${filePart(sid)}-${filePart(msgId)}.json`

const validMsgID = (msgId: string): boolean => msgId.length > 0 && msgId.length <= MAX_MSG_ID

const sameRun = (marker: QuotaTailMarker): boolean => {
  const current = runID()
  // 本地/测试没有 GITHUB_RUN_ID 时不把标记误判成旧 run；生产两者都有值。
  return !current || !marker.run || marker.run === current
}

const isMarker = (value: unknown, sid: string, msgId: string): value is QuotaTailMarker => {
  if (!value || typeof value !== "object") return false
  const m = value as Record<string, unknown>
  return (
    Number(m.v) === QUOTA_TAIL_MARKER_VERSION &&
    String(m.sid ?? "") === sid &&
    String(m.msgId ?? "") === msgId &&
    typeof m.owner === "string" &&
    m.owner.length > 0 &&
    typeof m.run === "string" &&
    Number.isFinite(Number(m.at)) &&
    Number(m.at) > 0
  )
}

/** 读取本 run 的有效标记；损坏、旧 run、sid/msg 不匹配一律返回 null。 */
export const readQuotaTailMarker = (sid: string, msgId: string): QuotaTailMarker | null => {
  if (!SID_RE.test(sid) || !validMsgID(msgId)) return null
  try {
    const parsed = JSON.parse(readFileSync(quotaTailMarkerPath(sid, msgId), "utf8"))
    if (!isMarker(parsed, sid, msgId)) return null
    if (!sameRun(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 认领「本 run 的这条 pre-boot quota 尾」。
 *   · ok     = 当前调用者成为唯一恢复者；
 *   · exists = 另一个恢复者（或本调用者更早一次成功注入）已经认领；
 *   · error  = 路径/参数不可用，调用方必须放弃本次注入（无排他 = 不注入）。
 */
export const claimQuotaTail = (sid: string, msgId: string, owner: string): QuotaTailClaimResult => {
  const who = String(owner ?? "").trim()
  if (!SID_RE.test(sid) || !validMsgID(msgId) || !who) return "error"
  const path = quotaTailMarkerPath(sid, msgId)
  const body: QuotaTailMarker = {
    v: QUOTA_TAIL_MARKER_VERSION,
    sid,
    msgId,
    run: runID(),
    owner: who,
    at: Date.now(),
  }
  try {
    mkdirSync(tempDir(), { recursive: true })
  } catch {
    return "error"
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(body), { encoding: "utf8", mode: 0o600, flag: "wx" })
      return "ok"
    } catch (err) {
      if ((err as any)?.code !== "EEXIST") return "error"
      // 有效标记 = 真正的排他；损坏/旧 run/字段不匹配 = 坏文件，清掉后重试一次。
      if (readQuotaTailMarker(sid, msgId)) return "exists"
      try {
        unlinkSync(path)
      } catch {
        return "exists"
      }
    }
  }
  return "exists"
}

/** 仅释放自己写下的标记；别人的标记绝不清除。 */
export const releaseQuotaTail = (sid: string, msgId: string, owner: string): boolean => {
  const marker = readQuotaTailMarker(sid, msgId)
  if (!marker || marker.owner !== String(owner ?? "")) return false
  try {
    unlinkSync(quotaTailMarkerPath(sid, msgId))
    return true
  } catch {
    return false
  }
}

/** 当前有效标记的 owner（无标记/坏标记 = null）。 */
export const quotaTailOwner = (sid: string, msgId: string): string | null =>
  readQuotaTailMarker(sid, msgId)?.owner ?? null

export const quotaTailClaimedByOther = (sid: string, msgId: string, owner: string): boolean => {
  const current = quotaTailOwner(sid, msgId)
  return !!current && current !== String(owner ?? "")
}

/**
 * 纯判定：这是不是「本进程启动前的 assistant quota/429 尾条」。
 * 与 auto-continue 的 `messageCompletedThisRun` 同口径：只看 created。
 * 该判据只用于选择排他标记，不改变原有的错误策略/换出口节奏。
 */
export const isPreBootQuotaTail = (o: PreBootQuotaTailInput): boolean => {
  const created = Number(o.created)
  const bootAt = Number(o.bootAt)
  if (!o.hasError || !o.rateLimit) return false
  if (!Number.isFinite(created) || created <= 0) return false
  if (!Number.isFinite(bootAt) || bootAt <= 0) return false
  return created < bootAt
}
