/**
 * R2883（运营者：「改事件机制」「做自我检查」）：
 * **按会话维护的事件溯源运行态（SessionRuntime）**。
 *
 * 这里刻意不读 DB、不读宿主时间、不碰队列数组：
 *   · 输入只有事件（入队、认领、受理、落盘、回合状态、宿主忙闲、429、停止…）；
 *   · 输出只有状态与决策（`runtimeDecision` 复用 injection-contract 的优先级）。
 *
 * 生产阶段先做 **shadow**：桥仍按原逻辑注入，但把同一批事实喂给这里并记录
 * `runtime` 决策；回放测试则用事故时间线直接驱动 reducer。
 *
 * 这样下一步把 `pumpInject` 接到 reducer 时，行为已经有可重复的基线，
 * 而不是再靠“某个 if 看起来对”。
 */
import {
  decideInjection,
  type BarrierState,
  type ContractDecision,
  type InjectMode,
  type RolloverState,
  type TurnPhase,
} from "./injection-contract"

export type RuntimeAnomaly = {
  seq: number
  at: number
  code: string
  detail: string
}

export type RuntimeStats = {
  events: number
  accepted: number
  landed: number
  failed: number
  requeued: number
  decisions: number
  injects: number
  holds: number
  handoffs: number
}

export type RuntimeBarrier = {
  at: number
  itemId: string
  state: Exclude<BarrierState, "none">
}

export type RuntimeState = {
  sid: string
  version: string
  /** 本会话维度的事件序号；用于发现乱序/丢事件，不用全局 trace 序号。 */
  seq: number
  bootAt: number
  lastEventAt: number
  mode: InjectMode
  turn: { phase: TurnPhase; why: string; finish: string; at: number }
  host: { state: "unknown" | "busy" | "idle"; at: number; hostAt: number }
  bootHold: boolean
  rollover: { from: string; to: string; at: number } | null
  barrier: RuntimeBarrier | null
  queue: string[]
  inFlight: string[]
  stop: "none" | "requested" | "confirmed"
  lastDecision: ContractDecision | null
  decisionAt: number
  stats: RuntimeStats
  anomalies: RuntimeAnomaly[]
}

export type RuntimeEvent =
  | { type: "runtime.boot"; sid: string; at: number; version: string; mode: InjectMode; queue?: string[]; inFlight?: string[]; barrierAt?: number }
  | { type: "mode.changed"; sid: string; at: number; mode: InjectMode }
  | { type: "queue.added"; sid: string; at: number; id: string }
  | { type: "queue.removed"; sid: string; at: number; id: string; why?: string }
  | { type: "inject.claimed"; sid: string; at: number; id: string; barrierAt: number }
  | { type: "inject.accepted"; sid: string; at: number; id: string; delivery: "steer" | "queue" }
  | { type: "inject.landed"; sid: string; at: number; id: string }
  | { type: "inject.failed"; sid: string; at: number; id: string; reason: string }
  | { type: "inject.timeout"; sid: string; at: number; id: string; attempt: number }
  | { type: "turn.state"; sid: string; at: number; phase: TurnPhase; why: string; finish?: string }
  | { type: "host.state"; sid: string; at: number; state: "unknown" | "busy" | "idle"; hostAt?: number }
  | { type: "boot.hold"; sid: string; at: number; detail?: string }
  | { type: "boot.released"; sid: string; at: number }
  | { type: "stop.requested"; sid: string; at: number }
  | { type: "stop.confirmed"; sid: string; at: number }
  | { type: "rollover.moved"; sid: string; at: number; from: string; to: string }
  | { type: "decision"; sid: string; at: number; decision: ContractDecision }
  | { type: "resync"; sid: string; at: number; queue: string[]; inFlight: string[]; barrierAt: number; mode?: InjectMode }

const MAX_ANOMALIES = 50

const emptyStats = (): RuntimeStats => ({
  events: 0,
  accepted: 0,
  landed: 0,
  failed: 0,
  requeued: 0,
  decisions: 0,
  injects: 0,
  holds: 0,
  handoffs: 0,
})

export const initialRuntimeState = (
  sid: string,
  at: number,
  version = "unknown",
  mode: InjectMode = "now",
): RuntimeState => ({
  sid,
  version,
  seq: 0,
  bootAt: at,
  lastEventAt: at,
  mode,
  turn: { phase: "unknown", why: "", finish: "", at },
  host: { state: "unknown", at, hostAt: 0 },
  bootHold: false,
  rollover: null,
  barrier: null,
  queue: [],
  inFlight: [],
  stop: "none",
  lastDecision: null,
  decisionAt: 0,
  stats: emptyStats(),
  anomalies: [],
})

const clone = (s: RuntimeState): RuntimeState => ({
  ...s,
  turn: { ...s.turn },
  host: { ...s.host },
  barrier: s.barrier ? { ...s.barrier } : null,
  rollover: s.rollover ? { ...s.rollover } : null,
  queue: [...s.queue],
  inFlight: [...s.inFlight],
  lastDecision: s.lastDecision ? { ...s.lastDecision } : null,
  stats: { ...s.stats },
  anomalies: [...s.anomalies],
})

const anomaly = (s: RuntimeState, code: string, detail: string): void => {
  s.anomalies.push({ seq: s.seq, at: s.lastEventAt, code, detail })
  if (s.anomalies.length > MAX_ANOMALIES) s.anomalies.splice(0, s.anomalies.length - MAX_ANOMALIES)
}

const dropFrom = (arr: string[], id: string): boolean => {
  const i = arr.indexOf(id)
  if (i < 0) return false
  arr.splice(i, 1)
  return true
}

/** 纯 reducer：同一事件序列必须得到同一状态。 */
export const applyRuntimeEvent = (state: RuntimeState, event: RuntimeEvent): RuntimeState => {
  const s = clone(state)
  s.seq += 1
  s.lastEventAt = Number(event.at) || s.lastEventAt
  s.stats.events += 1
  switch (event.type) {
    case "runtime.boot": {
      // 新实例启动：清掉上一实例的瞬时状态，再用持久化快照恢复。
      s.version = event.version
      s.bootAt = event.at
      s.mode = event.mode
      s.turn = { phase: "unknown", why: "", finish: "", at: event.at }
      s.host = { state: "unknown", at: event.at, hostAt: 0 }
      s.bootHold = false
      s.rollover = null
      s.queue = [...(event.queue ?? [])]
      s.inFlight = [...(event.inFlight ?? [])]
      s.barrier =
        Number(event.barrierAt) > 0
          ? { at: Number(event.barrierAt), itemId: s.inFlight[0] ?? "", state: "waiting" }
          : null
      s.stop = "none"
      s.lastDecision = null
      s.decisionAt = 0
      break
    }
    case "mode.changed":
      s.mode = event.mode
      break
    case "queue.added":
      if (!event.id) {
        anomaly(s, "queue-missing-id", "queue.added without id")
        break
      }
      if (s.queue.includes(event.id)) {
        anomaly(s, "queue-duplicate", `id=${event.id}`)
        break
      }
      s.queue.push(event.id)
      break
    case "queue.removed":
      if (!dropFrom(s.queue, event.id)) {
        anomaly(s, "queue-remove-miss", `id=${event.id} why=${event.why ?? ""}`)
      }
      break
    case "inject.claimed": {
      const claimed = dropFrom(s.queue, event.id)
      if (!claimed) anomaly(s, "claim-not-queued", `id=${event.id}`)
      if (!s.inFlight.includes(event.id)) s.inFlight.push(event.id)
      else anomaly(s, "claim-duplicate", `id=${event.id}`)
      s.barrier = {
        at: Number(event.barrierAt) || event.at,
        itemId: event.id,
        state: "waiting",
      }
      break
    }
    case "inject.accepted":
      s.stats.accepted += 1
      // 没有栅栏的旧路径（宿主已确认或无确认机制）在受理时即视为完成。
      if (!s.barrier) {
        dropFrom(s.inFlight, event.id)
        s.stats.landed += 1
      }
      break
    case "inject.landed":
      if (!dropFrom(s.inFlight, event.id)) anomaly(s, "landed-not-inflight", `id=${event.id}`)
      if (s.barrier?.itemId === event.id) s.barrier = null
      s.stats.landed += 1
      break
    case "inject.failed":
    case "inject.timeout": {
      const id = event.id
      dropFrom(s.inFlight, id)
      if (s.barrier?.itemId === id) s.barrier = null
      if (id && !s.queue.includes(id)) s.queue.unshift(id)
      if (event.type === "inject.failed") s.stats.failed += 1
      else s.stats.requeued += 1
      break
    }
    case "turn.state":
      s.turn = {
        phase: event.phase,
        why: String(event.why ?? ""),
        finish: String(event.finish ?? ""),
        at: event.at,
      }
      break
    case "host.state":
      s.host = {
        state: event.state,
        at: event.at,
        hostAt: Number(event.hostAt ?? 0),
      }
      break
    case "boot.hold":
      s.bootHold = true
      break
    case "boot.released":
      s.bootHold = false
      break
    case "stop.requested":
      s.stop = "requested"
      break
    case "stop.confirmed":
      s.stop = "confirmed"
      break
    case "rollover.moved":
      s.rollover = { from: event.from, to: event.to, at: event.at }
      // 旧会话已弃用：保留队列仅用于诊断，不再参与本会话决策。
      s.turn = { phase: "unknown", why: "rollover", finish: "", at: event.at }
      break
    case "decision": {
      const d = event.decision
      s.lastDecision = { ...d }
      s.decisionAt = event.at
      s.stats.decisions += 1
      if (d.action === "inject") s.stats.injects += 1
      else if (d.action === "hold") s.stats.holds += 1
      else if (d.action === "handoff") s.stats.handoffs += 1
      else if (d.action === "requeue") s.stats.requeued += 1
      break
    }
    case "resync":
      s.mode = event.mode ?? s.mode
      s.queue = [...event.queue]
      s.inFlight = [...event.inFlight]
      s.barrier =
        Number(event.barrierAt) > 0
          ? { at: Number(event.barrierAt), itemId: s.inFlight[0] ?? "", state: "waiting" }
          : null
      break
  }
  return s
}

/** 把运行态映射成契约输入；barrier 的年龄按当前时钟计算。 */
export const runtimeContractInput = (state: RuntimeState, now = Date.now()) => {
  const rollover: RolloverState = state.rollover ? "remapped" : "none"
  return {
    mode: state.mode,
    queue: { empty: state.queue.length === 0 && state.inFlight.length === 0 },
    boot: { hold: state.bootHold },
    rollover: { state: rollover, to: state.rollover?.to },
    barrier: state.barrier
      ? {
          state: state.barrier.state,
          ageMs: Math.max(0, now - state.barrier.at),
        }
      : { state: "none" as const, ageMs: 0 },
    turn: { phase: state.turn.phase, why: state.turn.why, finish: state.turn.finish },
    eventBusy: state.host.state === "busy",
    now,
  }
}

export const runtimeDecision = (state: RuntimeState, now = Date.now()): ContractDecision =>
  decideInjection(runtimeContractInput(state, now))

export type RuntimeStore = {
  apply: (event: RuntimeEvent) => RuntimeState
  get: (sid: string) => RuntimeState | undefined
  list: () => RuntimeState[]
  reset: (sid?: string) => void
  size: () => number
}

export const createRuntimeStore = (opts?: { version?: string; mode?: InjectMode }): RuntimeStore => {
  const version = opts?.version ?? "unknown"
  const mode = opts?.mode ?? "now"
  const states = new Map<string, RuntimeState>()
  const apply = (event: RuntimeEvent): RuntimeState => {
    const at = Number(event.at) || Date.now()
    const base =
      states.get(event.sid) ?? initialRuntimeState(event.sid, at, version, mode)
    const next = applyRuntimeEvent(base, event)
    states.set(event.sid, next)
    return next
  }
  return {
    apply,
    get: (sid) => states.get(sid),
    list: () => [...states.values()].sort((a, b) => b.lastEventAt - a.lastEventAt),
    reset: (sid) => {
      if (sid) states.delete(sid)
      else states.clear()
    },
    size: () => states.size,
  }
}

/** 单行诊断：给 /inject diag 与 trace 日志复用。 */
export const formatRuntimeState = (s: RuntimeState, now = Date.now()): string => {
  const age = (at: number): string => (at > 0 ? `${Math.round((now - at) / 1000)}s` : "-")
  const bar = s.barrier ? `${s.barrier.state}@${age(s.barrier.at)}` : "-"
  const d = s.lastDecision ? `${s.lastDecision.action}/${s.lastDecision.code}` : "-"
  return [
    `sid=${s.sid.slice(0, 12)}`,
    `seq=${s.seq}`,
    `mode=${s.mode}`,
    `turn=${s.turn.phase}${s.turn.why ? `(${s.turn.why})` : ""}`,
    `host=${s.host.state}`,
    `q=${s.queue.length}`,
    `if=${s.inFlight.length}`,
    `bar=${bar}`,
    `last=${d}@${age(s.decisionAt)}`,
    `anomaly=${s.anomalies.length}`,
  ].join(" ")
}
