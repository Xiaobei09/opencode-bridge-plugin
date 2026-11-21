/**
 * R2883（运营者：「甚至能不能做自我检查？」）：
 * **注入链路自检** —— 不猜“应该没问题”，而是把实际运行态拿来做不变量检查。
 *
 * 自检只读、不改行为。它回答的是运营者最常问的三类问题：
 *   1. 队列里还有消息，为什么宿主空闲却不注入？（queue-stalled-idle / no-waiter）
 *   2. 上一条到底落盘没有？为什么一直卡着？（barrier-stale / inflight-stale）
 *   3. 事件流是不是漏了/骗了我们？（event-busy-stale / runtime-anomalies）
 *
 * 阈值刻意比正常路径宽松（分钟级），避免长工具回合、429 换会话、boot 恢复
 * 这些“合法的等待”被误报。发现项带 `code` / `ageMs` / `hint`，可直接进日志或
 * `/inject diag`，不需要再靠人读 1.5 万行代码猜。
 */
import { safeCut } from "./log-safe"
import { PIN_BARRIER_MAX_MS } from "./pin-barrier"
import type { BarrierState, ContractAction, InjectMode } from "./injection-contract"
import { formatTraceEntry, type TraceEntry } from "./inject-trace"

export type SelfCheckQueueItem = {
  id: string
  ts: number
  retryCount?: number
}

export type SelfCheckInflightItem = {
  id: string
  claimedAt?: number
  retryCount?: number
}

export type SelfCheckSession = {
  sid: string
  mode: InjectMode
  host: "unknown" | "busy" | "idle"
  hostIdleAt: number
  eventBusy: boolean
  pumping: boolean
  rows: number
  queue: SelfCheckQueueItem[]
  inFlight: SelfCheckInflightItem[]
  barrierAt: number
  barrierState: BarrierState
  waiters: number
  lastDecision?: { at: number; action: ContractAction | "none"; code: string }
  runtime?: {
    seq: number
    anomalies: number
    lastEventAt: number
    turnPhase: string
    lastDecisionCode?: string
  }
}

export type SelfCheckInput = {
  now: number
  version: string
  mode: InjectMode
  sessions: SelfCheckSession[]
  traceSeq: number
  traceLastAt: number
}

export type SelfCheckSeverity = "info" | "warn" | "error"

export type SelfCheckFinding = {
  code: string
  severity: SelfCheckSeverity
  sid?: string
  ageMs?: number
  detail: string
  hint: string
}

export type SelfCheckReport = {
  ok: boolean
  findings: SelfCheckFinding[]
  checked: { sessions: number; queue: number; inflight: number; barriers: number }
  summary: string
}

/** 正常等待的上限；超过才认为“可能卡住”。 */
export const SELF_CHECK = {
  /** `now` 模式队列在宿主空闲时超过这么久没动 = 立即语义失效。 */
  nowIdleQueueMs: 15_000,
  /** idle 模式队列在宿主空闲时超过这么久没动 = 至少值得警告。 */
  idleQueueWarnMs: 60_000,
  /** 超过这么久仍是同一状态 = 错误级。 */
  stalledErrorMs: 10 * 60_000,
  /** 注入栅栏超过它仍 waiting = 宿主没确认落盘。 */
  barrierStaleMs: PIN_BARRIER_MAX_MS,
  /** in-flight 超过它仍未 landed = 看护路径可能没跑。 */
  inflightStaleMs: 10 * 60_000,
  /** 自动重试上限（与桥的 3 次口径一致）。 */
  maxRetry: 3,
  /** 宿主已空闲但事件流仍 busy 超过它 = busyTurn 滞留。 */
  eventBusyStaleMs: 60_000,
  /** 有队列但 trace 超过它没有任何新决策 = 泵/日志链路可能停了。 */
  traceStaleMs: 10 * 60_000,
  /** boot 恢复/boot 屏障超过它仍未释放 = 可能永远卡住。 */
  bootHoldStaleMs: 10 * 60_000,
} as const

const short = (sid: string): string => (sid ? sid.slice(0, 12) : "-")
const mins = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))}m`
const secs = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`

const oldest = (items: Array<{ ts?: number; claimedAt?: number }>, now: number): number => {
  let max = 0
  for (const it of items) {
    const at = Number(it.claimedAt ?? it.ts ?? 0)
    if (at > 0) max = Math.max(max, now - at)
  }
  return max
}

const severityRank: Record<SelfCheckSeverity, number> = { error: 0, warn: 1, info: 2 }

const isSafetyHold = (code: string): boolean =>
  code === "boot-resume-pending" ||
  code === "rollover-moving" ||
  code === "rollover-remapped" ||
  code === "barrier-waiting" ||
  code === "barrier-timeout"

export const runSelfCheck = (input: SelfCheckInput): SelfCheckReport => {
  const now = Number(input.now) || Date.now()
  const findings: SelfCheckFinding[] = []
  let totalQueue = 0
  let totalInflight = 0
  let totalBarriers = 0

  for (const s of input.sessions) {
    const sid = short(s.sid)
    const q = Array.isArray(s.queue) ? s.queue : []
    const inf = Array.isArray(s.inFlight) ? s.inFlight : []
    totalQueue += q.length
    totalInflight += inf.length
    if (s.barrierAt > 0) totalBarriers += 1

    // 1) 结构性错误：重复/空 ID 会让“认领—落盘”对不上。
    const qids = new Set<string>()
    for (const it of q) {
      if (!it.id) {
        findings.push({ code: "queue-missing-id", severity: "error", sid, detail: "队列条目缺少 id", hint: "检查 queueAndPump / 状态恢复" })
        continue
      }
      if (qids.has(it.id)) {
        findings.push({ code: "queue-duplicate-id", severity: "error", sid, detail: `id=${it.id.slice(0, 12)} 重复`, hint: "按 id 去重；重复条会被注入两次" })
      }
      qids.add(it.id)
    }
    const iids = new Set<string>()
    for (const it of inf) {
      if (iids.has(it.id)) {
        findings.push({ code: "inflight-duplicate-id", severity: "error", sid, detail: `id=${it.id.slice(0, 12)} 重复`, hint: "检查认领与恢复路径" })
      }
      iids.add(it.id)
    }

    // 2) 栅栏/在途一致性。合法路径里 barrier 与 inFlight 应同时存在。
    const barrierAge = s.barrierAt > 0 ? Math.max(0, now - s.barrierAt) : 0
    if (s.barrierState === "waiting" && barrierAge > SELF_CHECK.barrierStaleMs) {
      findings.push({
        code: "barrier-stale",
        severity: "error",
        sid,
        ageMs: barrierAge,
        detail: `注入栅栏等待 ${mins(barrierAge)} 仍未看到 user 行落盘`,
        hint: "宿主可能丢了 prompt；watchInjectedLanding 应重新入队，检查该看护是否存活",
      })
    }
    if (s.barrierAt > 0 && inf.length === 0) {
      findings.push({
        code: "barrier-orphan",
        severity: "warn",
        sid,
        ageMs: barrierAge,
        detail: "有注入栅栏但没有 in-flight 条目",
        hint: "可能已落盘但未清理；下次 gate 会处理。若持续出现，检查 landInjectedBarrier",
      })
    }
    if (inf.length > 0 && s.barrierAt <= 0) {
      findings.push({
        code: "inflight-orphan",
        severity: "warn",
        sid,
        detail: "有 in-flight 条目但没有栅栏",
        hint: "这条永远不会被 host-confirm 看护；检查认领时 injectBarrier.set",
      })
    }
    const inflightAge = oldest(inf, now)
    if (inflightAge > SELF_CHECK.inflightStaleMs) {
      findings.push({
        code: "inflight-stale",
        severity: "error",
        sid,
        ageMs: inflightAge,
        detail: `in-flight 已 ${mins(inflightAge)} 未确认落盘`,
        hint: "看 watchInjectedLanding / landInjectedBarrier 是否在跑；可能需要 /dropq 后重发",
      })
    }
    const maxRetry = Math.max(0, ...q.map((it) => Number(it.retryCount ?? 0)), ...inf.map((it) => Number(it.retryCount ?? 0)))
    if (maxRetry >= SELF_CHECK.maxRetry) {
      findings.push({
        code: "retry-exhausted",
        severity: "error",
        sid,
        detail: `队列条目已自动重试 ${maxRetry} 次仍未落盘`,
        hint: "宿主持续拒绝/丢弃 prompt；检查宿主日志与 429 状态，必要时 /dropq",
      })
    }

    // 3) 队列在宿主空闲时不动：最接近用户感知的“为什么没注入”。
    const waited = oldest(q, now)
    const last = s.lastDecision
    const lastAge = last ? Math.max(0, now - last.at) : Number.POSITIVE_INFINITY
    const safety = last ? isSafetyHold(last.code) : false
    const activelyWaiting = s.pumping || s.barrierState === "waiting"
    if (q.length > 0 && s.host === "idle" && !activelyWaiting && s.barrierState !== "waiting") {
      const limit = s.mode === "now" ? SELF_CHECK.nowIdleQueueMs : SELF_CHECK.idleQueueWarnMs
      if (waited > limit) {
        const error = waited > SELF_CHECK.stalledErrorMs
        findings.push({
          code: s.mode === "now" ? "queue-stalled-now" : "queue-stalled-idle",
          severity: error ? "error" : "warn",
          sid,
          ageMs: waited,
          detail:
            `宿主已空闲、队列 ${q.length} 条、最早一条等了 ${mins(waited)}` +
            (last ? `；最后决策 ${last.action}/${last.code}（${secs(lastAge)}前）` : "；没有任何决策记录"),
          hint:
            s.mode === "now"
              ? "now 应立即注入；检查泵是否被 boot/rollover/栅栏外的条件扣住"
              : "idle 合法等待正常结束；若尾条已结束，检查 idleVerdict/宿主时间是否漂移",
        })
      }
      if (s.waiters === 0 && waited > SELF_CHECK.idleQueueWarnMs && !safety) {
        findings.push({
          code: "no-waiter",
          severity: "warn",
          sid,
          ageMs: waited,
          detail: "队列在等，但没有任何空闲等待器登记",
          hint: "没有事件会唤醒泵，只能等 30s 看门狗；检查 pumpInject 是否在等待前退出",
        })
      }
    }

    // 4) 事件流与宿主时间矛盾：busyTurn 滞留会让菜单/回执误报“运行中”。
    if (s.eventBusy && s.host === "idle" && s.hostIdleAt > 0 && now - s.hostIdleAt > SELF_CHECK.eventBusyStaleMs) {
      findings.push({
        code: "event-busy-stale",
        severity: "warn",
        sid,
        ageMs: now - s.hostIdleAt,
        detail: `宿主已空闲 ${mins(now - s.hostIdleAt)}，事件流仍标记 busy`,
        hint: "busyTurn 可能漏收 completed；检查 message.updated/session.idle 与清理分支",
      })
    }

    // 5) 安全闸本身卡住：boot 恢复/429 换会话不应当无限期。
    if (last?.code === "boot-resume-pending" && lastAge > SELF_CHECK.bootHoldStaleMs) {
      findings.push({
        code: "boot-hold-stale",
        severity: "error",
        sid,
        ageMs: lastAge,
        detail: `boot 恢复提示等待 ${mins(lastAge)} 仍未落盘`,
        hint: "检查 resume-once claim/row 是否写入失败；必要时人工确认后 /flush",
      })
    }
    if (last?.code === "rollover-moving" && lastAge > SELF_CHECK.bootHoldStaleMs) {
      findings.push({
        code: "rollover-stale",
        severity: "error",
        sid,
        ageMs: lastAge,
        detail: `429 换会话已进行 ${mins(lastAge)} 仍未完成`,
        hint: "检查 successor 是否建出；旧会话不应继续接收注入",
      })
    }

    // 6) 契约违规：now 模式绝不应该因“回合没结束”而持有。
    if (s.mode === "now" && last?.action === "hold" && last.code.startsWith("turn-")) {
      findings.push({
        code: "contract-violation-now-held",
        severity: "error",
        sid,
        ageMs: lastAge,
        detail: `now 模式被回合闸门扣住：${last.code}`,
        hint: "R2882 语义要求 now 跳过回合结束判定；检查 gate 是否又合并了两种模式",
      })
    }

    // 7) 运行态异常（重复入队、认领不在队列、落盘不在在途…）。
    if (s.runtime && s.runtime.anomalies > 0) {
      findings.push({
        code: "runtime-anomalies",
        severity: "warn",
        sid,
        detail: `SessionRuntime 记录 ${s.runtime.anomalies} 条状态异常（turn=${s.runtime.turnPhase}）`,
        hint: "查看 trace 中 runtime/resync 条目；异常码会指出重复/丢失在哪一步",
      })
    }
  }

  if (totalQueue > 0 && input.traceLastAt > 0 && now - input.traceLastAt > SELF_CHECK.traceStaleMs) {
    findings.push({
      code: "trace-stale",
      severity: "warn",
      ageMs: now - input.traceLastAt,
      detail: `队列 ${totalQueue} 条，但 trace 已 ${mins(now - input.traceLastAt)} 没有新决策`,
      hint: "泵可能没被唤醒，或决策日志点被绕过；结合 no-waiter 一起看",
    })
  }

  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
  const errors = findings.filter((f) => f.severity === "error").length
  const warns = findings.filter((f) => f.severity === "warn").length
  const summary =
    errors > 0
      ? `ERROR ${errors}${warns > 0 ? ` / WARN ${warns}` : ""}`
      : warns > 0
        ? `WARN ${warns}`
        : "PASS"
  return {
    ok: errors === 0,
    findings,
    checked: {
      sessions: input.sessions.length,
      queue: totalQueue,
      inflight: totalInflight,
      barriers: totalBarriers,
    },
    summary,
  }
}

const icon = (s: SelfCheckSeverity): string => (s === "error" ? "⛔" : s === "warn" ? "⚠️" : "·")

/** `/inject diag` 的正文；纯函数，便于单测与长度控制。 */
export const formatSelfCheckReport = (
  report: SelfCheckReport,
  opts?: { version?: string; mode?: InjectMode; trace?: TraceEntry[]; maxTrace?: number; maxFindings?: number; maxChars?: number },
): string => {
  const maxChars = Math.max(500, Number(opts?.maxChars) || 3500)
  const lines: string[] = [
    `🔎 注入诊断 ${opts?.version ?? ""} · ${report.summary}`.trim(),
    `模式 ${opts?.mode ?? "?"} · 会话 ${report.checked.sessions} · 队列 ${report.checked.queue} · 在途 ${report.checked.inflight} · 栅栏 ${report.checked.barriers}`,
  ]
  const findings = report.findings.slice(0, Math.max(1, Number(opts?.maxFindings) || 8))
  if (findings.length === 0) {
    lines.push("✅ 未发现异常（队列/栅栏/事件流一致）")
  } else {
    lines.push(`发现 ${report.findings.length} 项：`)
    for (const f of findings) {
      const age = f.ageMs ? ` · ${f.ageMs >= 60_000 ? mins(f.ageMs) : secs(f.ageMs)}` : ""
      lines.push(`${icon(f.severity)} ${f.code}${f.sid ? ` · ${f.sid}` : ""}${age}`)
      lines.push(`  ${f.detail}`)
      lines.push(`  → ${f.hint}`)
    }
    if (report.findings.length > findings.length) lines.push(`… 另有 ${report.findings.length - findings.length} 项（见日志）`)
  }
  const trace = opts?.trace ?? []
  if (trace.length > 0) {
    lines.push("近期决策：")
    for (const e of trace.slice(-(Math.max(1, Number(opts?.maxTrace) || 8)))) {
      // 诊断里去掉重复的固定前缀，手机屏幕更短。
      lines.push(`· ${formatTraceEntry(e).replace(/^pinject trace /, "")}`)
    }
  }
  const out = lines.join("\n")
  // R2883：截断不能切开代理对；否则 emoji 会变成 U+FFFD，Telegram 也可能 400。
  return out.length <= maxChars ? out : `${safeCut(out, maxChars - 20)}\n…（已截断）`
}
