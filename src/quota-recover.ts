/**
 * R2626：跨 CI「额度尾条恢复」的持久设置与最近一次恢复记录。
 *
 * 背景（运营者 2026-11-13）：Option C 与自动循环互相独立，但旧的
 * decideBootResume 对 pre-boot 的 quota/429 尾条一律 skip(quota-error)。
 * 新一轮如果已经换到**不同出口**，旧尾条的 429 不再代表新出口没额度，
 * 应该允许一次 recover 续跑；出口没变则维持跳过，避免立刻再撞 429。
 *
 * R2664：额度尾恢复是**跨 CI 的一次性恢复，不是循环**，所以不受 `/loop off`
 * 与“自动循环活跃”限制；用户按 ⏹ 的 halted 仍是硬闸（明确表示不要再跑）。
 * R2665：429 rollover 的排斥也只针对**可执行**的请求；等待循环/已 halted/
 * Bot 离线的请求会让 bridge 一直保留，不能再因此全局关闭额度尾恢复。
 *
 * 设置文件（随 $HOME 快照跨 run 存活）：
 *   $HOME/.config/opencode/quota-recover.json
 *     {"mode":"auto"|"off","updated":"...","by":"<bot>"}
 *   缺省/读不到 = auto（换出口才恢复；本轮由 workflow 比较上一轮出口）。
 *   off = 永不恢复配额尾条（同出口行为不变）。
 *
 * 记录文件（只用于 TG 菜单展示，不是判定依据）：
 *   $HOME/.config/opencode/quota-recover-last.json
 *
 * 判定本身仍由 workflow（出口是否变化）与 resume-once 的 quotaRecover 入参
 * 完成；本模块只做 best-effort 的读写，任何 IO 失败都不影响主流程。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export type QuotaRecoverMode = "auto" | "off"

export type QuotaRecoverLast = {
  at: number
  sid?: string
  reason?: string
  prompt?: string
  run?: string
  trigger?: string
}

const home = (): string => process.env.HOME ?? "/root"
export const quotaRecoverPath = (): string => `${home()}/.config/opencode/quota-recover.json`
export const quotaRecoverLastPath = (): string => `${home()}/.config/opencode/quota-recover-last.json`

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

const writeJson = (path: string, body: Record<string, unknown>): boolean => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp.${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600 })
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/** 读取模式：只有明确的 off 才关闭；缺省/损坏一律按 auto。 */
export const readQuotaRecoverMode = (): QuotaRecoverMode => {
  const j = readJson(quotaRecoverPath())
  return j?.mode === "off" ? "off" : "auto"
}

export const readQuotaRecover = (): { mode: QuotaRecoverMode; updated: string; by: string } => {
  const j = readJson(quotaRecoverPath())
  return {
    mode: j?.mode === "off" ? "off" : "auto",
    updated: typeof j?.updated === "string" ? j.updated : "",
    by: typeof j?.by === "string" ? j.by : "",
  }
}

export const writeQuotaRecoverMode = (mode: QuotaRecoverMode, by = ""): boolean =>
  writeJson(quotaRecoverPath(), {
    mode: mode === "off" ? "off" : "auto",
    updated: new Date().toISOString(),
    by,
  })

export const readQuotaRecoverLast = (): QuotaRecoverLast | null => {
  const j = readJson(quotaRecoverLastPath())
  if (!j || typeof j !== "object") return null
  const at = Number(j.at)
  if (!Number.isFinite(at) || at <= 0) return null
  return {
    at,
    sid: typeof j.sid === "string" ? j.sid : undefined,
    reason: typeof j.reason === "string" ? j.reason : undefined,
    prompt: typeof j.prompt === "string" ? j.prompt : undefined,
    run: typeof j.run === "string" ? j.run : undefined,
    trigger: typeof j.trigger === "string" ? j.trigger : undefined,
  }
}

export const writeQuotaRecoverLast = (r: QuotaRecoverLast): boolean =>
  writeJson(quotaRecoverLastPath(), {
    at: Number(r.at) || Date.now(),
    sid: r.sid ?? "",
    reason: r.reason ?? "",
    prompt: r.prompt ?? "",
    run: r.run ?? "",
    trigger: r.trigger ?? "",
  })
