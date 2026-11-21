/**
 * R2883（运营者：「改事件机制」「日志足够详细」「能不能做自我检查」）：
 * **注入闸门的显式契约**。
 *
 * 背景：注入链路的判据散在 `turnActuallyIdle` / `pumpInject` / 队列回执里，
 * `now` 和 `idle` 的语义被 R2871 合并过一次，R2881 只改文案，R2882 才恢复。
 * 根因不是某个 if 写错，而是**没有一份可执行的优先级契约**：
 *
 *   1. 队列空 = 什么都不做；
 *   2. boot 恢复提示未落盘 = 等（否则用户消息会插到恢复提示前面）；
 *   3. 429 换会话 = 跟随 successor / 等待（绝不注入已放弃的旧会话）；
 *   4. 上一条注入的 user 行未确认落盘 = 等（一次只放一条，防重复/乱序）；
 *   5. now  = 跳过“回合是否结束”，立即交给宿主（steer）；
 *   6. idle = 只在回合正常结束、正文投递完后注入（queue）。
 *
 * 本模块只做**纯决策**，不读 DB、不写日志、不改队列。生产代码先以 shadow
 * 方式调用（只记日志，不改变实际行为）；回放测试用同一份契约断言事故时间线。
 */

export type InjectMode = "now" | "idle"

/** 注入后栅栏：上一条 prompt 已受理，但宿主还没把 user 行落盘。 */
export type BarrierState = "none" | "waiting" | "landed" | "timeout"

/** 429 换会话状态。remapped = 已有明确 successor。 */
export type RolloverState = "none" | "moving" | "remapped"

/**
 * 回合状态。**由权威判据（idleVerdict + 宿主 time_busy/time_idle + 消息尾部）
 * 归一后传入**，契约本身不重复实现那套启发式。
 */
export type TurnPhase = "idle" | "busy" | "unknown"

export type ContractInput = {
  mode: InjectMode
  queue: { empty: boolean }
  boot: { hold: boolean; detail?: string }
  rollover: { state: RolloverState; to?: string }
  barrier: { state: BarrierState; ageMs?: number }
  turn: { phase: TurnPhase; why?: string; finish?: string }
  eventBusy?: boolean
  now?: number
}

export type ContractAction = "inject" | "hold" | "handoff" | "requeue"

export type ContractDecision = {
  action: ContractAction
  /**
   * 稳定的机器可读原因码。日志、自检、回放测试都按它断言；
   * 不要用自然语言句子当键（文案会变，键不能变）。
   */
  code: string
  /** 一行中文说明，给 /inject diag 与日志读者。 */
  reason: string
  /** 命中的优先级层（越小越先）。用于解释“为什么不是另一个原因”。 */
  precedence: number
  detail?: string
}

/**
 * 原因码 → 中文说明。新增原因码必须同步这里，避免日志出现裸 code。
 * 键的稳定性是回放测试的基础，禁止随文案调整而改名。
 */
export const DECISION_REASON: Record<string, string> = {
  "queue-empty": "队列为空",
  "boot-resume-pending": "等待 boot 恢复提示先落盘",
  "rollover-remapped": "429 已换会话，交给 successor",
  "rollover-moving": "429 换会话进行中，暂不注入",
  "barrier-waiting": "上一条注入尚未被宿主确认落盘",
  "barrier-timeout": "上一条注入确认超时，需要重新入队",
  "now-immediate": "立即注入（不等回合结束）",
  "idle-turn-ended": "回合已正常结束",
  "idle-empty-session": "空会话，没有需要等待的回合",
  "idle-stop-ended": "用户刚显式停止，旧回合按结束处理",
  "turn-busy": "回合仍在运行",
  "turn-event-silence": "回合刚结束，等待事件/落盘静置窗",
  "turn-error": "上一回合以错误结束，等尾恢复",
  "turn-incomplete": "上一回合未正常完成，等续完/恢复",
  "turn-compacting": "会话正在压缩",
  "turn-settling": "回合边界尚未落定",
  "turn-unknown": "回合状态未知，保守等待",
  "user-prompt-without-assistant": "user 行后还没有 assistant，回合已开始",
  "empty-session-busy": "空会话但宿主仍标记忙",
  "no-assistant-hold": "没有可判定的 assistant 尾条",
}

const text = (code: string, detail?: string): string =>
  DECISION_REASON[code] ?? (detail ? `${code}（${detail}）` : code)

const decision = (
  action: ContractAction,
  code: string,
  precedence: number,
  detail?: string,
): ContractDecision => ({
  action,
  code,
  precedence,
  reason: text(code),
  ...(detail ? { detail } : {}),
})

/**
 * 注入决策的唯一优先级。**顺序就是语义**：
 * 安全性（boot/429/栅栏）压过模式，模式压过回合判据。
 *
 * `now` 的“立即”只跳过第 6 层，不跳过 2–4 层；否则会重新出现
 * “上一条还没落盘就发下一条”“注入进被 429 放弃的旧会话”这类事故。
 */
export const decideInjection = (input: ContractInput): ContractDecision => {
  if (input.queue.empty) return decision("hold", "queue-empty", 10)

  if (input.boot.hold) {
    return decision("hold", "boot-resume-pending", 20, input.boot.detail)
  }

  if (input.rollover.state === "remapped") {
    return decision(
      "handoff",
      "rollover-remapped",
      30,
      input.rollover.to ? `successor=${input.rollover.to}` : undefined,
    )
  }
  if (input.rollover.state === "moving") {
    return decision("hold", "rollover-moving", 31)
  }

  if (input.barrier.state === "waiting") {
    const age = Math.max(0, Math.round(Number(input.barrier.ageMs ?? 0) / 1000))
    return decision("hold", "barrier-waiting", 40, `age=${age}s`)
  }
  if (input.barrier.state === "timeout") {
    const age = Math.max(0, Math.round(Number(input.barrier.ageMs ?? 0) / 1000))
    return decision("requeue", "barrier-timeout", 41, `age=${age}s`)
  }

  // 第 5 层：now 不关心回合是否结束。这是 R2882 恢复、R2871 弄丢的语义。
  if (input.mode === "now") return decision("inject", "now-immediate", 50)

  // 第 6 层：idle 必须等正常结束。turn.phase 已由调用方用权威判据归一。
  if (input.turn.phase === "idle") {
    const why = String(input.turn.why ?? "")
    const code =
      why === "empty-session" || why === "empty-session-idle"
        ? "idle-empty-session"
        : why === "explicit-stop"
          ? "idle-stop-ended"
          : "idle-turn-ended"
    return decision("inject", code, 60, why || input.turn.finish)
  }

  const why = String(input.turn.why ?? "")
  const code =
    input.turn.phase === "unknown"
      ? "turn-unknown"
      : why === "compaction-in-flight"
        ? "turn-compacting"
        : why.includes("error")
          ? "turn-error"
          : why.includes("incomplete") || why.includes("tool-calls")
            ? "turn-incomplete"
            : why.startsWith("event-")
              ? "turn-event-silence"
              : why === "user-prompt-without-assistant"
                ? "user-prompt-without-assistant"
                : why === "empty-session-busy"
                  ? "empty-session-busy"
                  : why === "no-assistant"
                    ? "no-assistant-hold"
                    : why
                      ? "turn-busy"
                      : "turn-settling"
  return decision("hold", code, 61, why || undefined)
}

/**
 * 生产代码已知“实际结果”时，用它构造同形状的决策对象（用于 trace/runtime）。
 * 不重新跑判据，避免日志与真实行为各说一套。
 */
export const decisionOf = (
  action: ContractAction,
  code: string,
  detail?: string,
): ContractDecision => ({
  action,
  code,
  reason: text(code, detail),
  precedence: 0,
  ...(detail ? { detail } : {}),
})

/** 是否属于“安全闸”层（与模式无关，切换 now/idle 也不能绕过）。 */
export const isSafetyHold = (d: ContractDecision): boolean =>
  d.action !== "inject" && d.precedence >= 20 && d.precedence < 50

/** 供状态卡/诊断使用的单行摘要。 */
export const formatDecision = (d: ContractDecision): string =>
  `${d.action}/${d.code}${d.detail ? ` (${d.detail})` : ""}`
