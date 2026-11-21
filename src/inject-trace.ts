/**
 * R2883（运营者：「日志也足够详细，方便发现问题」）：
 * **注入决策 trace** —— 每条注入/等待都留一条结构化、可 grep 的证据。
 *
 * 旧日志的问题不是“没有日志”，而是关键决定（为什么没注入）散在多个分支，
 * 每个分支各写一句自然语言，既无法汇总，也无法回答“过去 10 分钟卡在哪个原因”。
 *
 * 本模块只做三件事：
 *   · 记录固定字段（sid / seq / actor / phase / decision / code / queue / barrier / host / turn）；
 *   · 提供环形缓冲与按原因码计数，供 `/inject diag` 和自检读取；
 *   · 跨热重载保留（globalThis），避免“刚重载完就看不到上一实例为什么卡住”。
 *
 * 它**不改变任何注入行为**，也不替代现有日志；桥在关键点调用 `record()`。
 */
import type { ContractAction, InjectMode } from "./injection-contract"
import { safeCut } from "./log-safe"

export type TraceEntry = {
  seq: number
  at: number
  sid: string
  /** queue / pump / gate / claim / accepted / landing / selfcheck / runtime */
  actor: string
  /** enqueue / pump-start / gate / claimed / accepted / landed / failed / timeout / skip / resync */
  phase: string
  code: string
  decision?: ContractAction
  mode?: InjectMode
  detail?: string
  queue?: number
  inflight?: number
  barrierAgeMs?: number
  host?: "unknown" | "busy" | "idle"
  turn?: string
  version?: string
}

export type TraceInput = Omit<TraceEntry, "seq" | "at"> & { at?: number }

export type TraceCounts = {
  total: number
  inject: number
  hold: number
  handoff: number
  requeue: number
  byCode: Record<string, number>
}

export type InjectTrace = {
  record: (entry: TraceInput) => TraceEntry
  tail: (n?: number, sid?: string) => TraceEntry[]
  last: (sid?: string) => TraceEntry | undefined
  counts: (sinceMs?: number, now?: number) => TraceCounts
  seq: () => number
  clear: () => void
  size: () => number
}

const MAX_DEFAULT = 500

const oneLine = (v: unknown, max = 220): string => {
  const s = String(v ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  // R2883：截断不能切开代理对，否则 /inject diag 的 trace 行会带 U+FFFD。
  return safeCut(s, max)
}

const shortSid = (sid: string): string => {
  const s = oneLine(sid, 80)
  if (!s) return "-"
  // 保留前缀便于区分 ses_ / msg_；只截断随机部分，日志里不出现完整 ID。
  return s.length > 16 ? safeCut(s, 15) : s
}

/** 纯格式化：测试断言这一行，不要在生产里另拼一套。 */
export const formatTraceEntry = (e: TraceEntry): string => {
  const parts = [
    "pinject trace",
    `seq=${e.seq}`,
    `at=${new Date(e.at).toISOString()}`,
    `sid=${shortSid(e.sid)}`,
    `actor=${oneLine(e.actor, 24)}`,
    `phase=${oneLine(e.phase, 24)}`,
  ]
  if (e.mode) parts.push(`mode=${e.mode}`)
  if (e.decision) parts.push(`decision=${e.decision}`)
  parts.push(`code=${oneLine(e.code, 40)}`)
  if (e.queue !== undefined) parts.push(`q=${e.queue}`)
  if (e.inflight !== undefined) parts.push(`if=${e.inflight}`)
  if (e.barrierAgeMs !== undefined) {
    parts.push(`bar=${e.barrierAgeMs > 0 ? `${Math.round(e.barrierAgeMs / 1000)}s` : "-"}`)
  }
  if (e.host) parts.push(`host=${e.host}`)
  if (e.turn) parts.push(`turn=${oneLine(e.turn, 48)}`)
  if (e.version) parts.push(`ver=${oneLine(e.version, 16)}`)
  if (e.detail) parts.push(`detail=${JSON.stringify(oneLine(e.detail))}`)
  return parts.join(" ")
}

export const createInjectTrace = (opts?: { max?: number; startSeq?: number }): InjectTrace => {
  const max = Math.max(20, Number(opts?.max) || MAX_DEFAULT)
  const ring: TraceEntry[] = []
  let seq = Math.max(0, Number(opts?.startSeq) || 0)

  const record = (entry: TraceInput): TraceEntry => {
    seq += 1
    const e: TraceEntry = {
      ...entry,
      seq,
      at: Number(entry.at) || Date.now(),
    }
    ring.push(e)
    if (ring.length > max) ring.splice(0, ring.length - max)
    return e
  }

  const tail = (n = 20, sid?: string): TraceEntry[] => {
    const want = Math.max(0, Math.min(max, Math.floor(Number(n) || 0)))
    const all = sid ? ring.filter((e) => e.sid === sid) : ring
    return all.slice(Math.max(0, all.length - want))
  }

  const last = (sid?: string): TraceEntry | undefined => {
    if (!sid) return ring[ring.length - 1]
    for (let i = ring.length - 1; i >= 0; i--) if (ring[i]!.sid === sid) return ring[i]
    return undefined
  }

  const counts = (sinceMs = 0, now = Date.now()): TraceCounts => {
    const since = now - Math.max(0, Number(sinceMs) || 0)
    const out: TraceCounts = {
      total: 0,
      inject: 0,
      hold: 0,
      handoff: 0,
      requeue: 0,
      byCode: {},
    }
    for (const e of ring) {
      if (e.at < since) continue
      out.total += 1
      if (e.decision === "inject") out.inject += 1
      else if (e.decision === "hold") out.hold += 1
      else if (e.decision === "handoff") out.handoff += 1
      else if (e.decision === "requeue") out.requeue += 1
      out.byCode[e.code] = (out.byCode[e.code] ?? 0) + 1
    }
    return out
  }

  return {
    record,
    tail,
    last,
    counts,
    seq: () => seq,
    clear: () => {
      ring.length = 0
    },
    size: () => ring.length,
  }
}

/**
 * 跨热重载单例。OpenCode 会重新求值模块，模块级 ring 会丢；放到 globalThis 上，
 * 新实例仍能看到上一实例最后的决策（`/inject diag` 在重载后尤其需要）。
 *
 * R2883：**按 Bot 分槽**。多 Bot 是同进程里的多个模块实例，若共用一个 ring，
 * A 的 `/inject diag` 会看到 B 的决策，B 的活跃还会让 A 的 `trace-stale` 永远不触发。
 * 传 `scope`（桥传 BOT_ID）即按 Bot 隔离；不传保持旧的全局单例，兼容测试/单实例。
 */
const GLOBAL_KEY = "__tgInjectTraceR2883"

export const getInjectTrace = (scope?: string): InjectTrace => {
  const g = globalThis as Record<string, unknown>
  const key = scope ? `${GLOBAL_KEY}:${scope}` : GLOBAL_KEY
  let t = g[key] as InjectTrace | undefined
  if (!t) {
    t = createInjectTrace()
    g[key] = t
  }
  return t
}

/** 汇总一行：`inject=3 hold=12 top=barrier-waiting×7`。 */
export const formatTraceCounts = (c: TraceCounts): string => {
  const top = Object.entries(c.byCode)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, n]) => `${k}×${n}`)
    .join(" ")
  const head = `trace ${c.total}（inject=${c.inject} hold=${c.hold} handoff=${c.handoff} requeue=${c.requeue}）`
  return top ? `${head} · ${top}` : head
}
