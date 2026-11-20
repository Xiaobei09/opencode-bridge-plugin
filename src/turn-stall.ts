/**
 * R2868/R2869：回合「静默」判据（纯函数，不碰网络/文件/插件状态）。
 *
 * 背景（运营者 2026-11-20 实报）：「深度检查那些突然的一段时间没有消息，那是为什么，
 * 比如说 16:58 以后」。DB 实证两条形态：
 *   · 08:58:19 创建的 assistant 只有 383 字 reasoning，`time.updated` 停在 08:58:22，
 *     直到 09:15:42 用户手动换会话才被 abort —— 17 分 23 秒零输出；
 *   · 09:27:25 创建的 assistant 连 firstToken 都没有，直到 10:05 宿主重启才完成 ——
 *     37 分 44 秒零输出。
 *
 * R2869（运营者：「重新注入消息后仍然卡住，如果有队列会注入下一条信息，这是错误的，
 * 是不是直接换会话比较好」）补第二种形态：**桥/恢复流程已经注入了一条 user 提示，
 * 但宿主没有创建任何 assistant 行**。旧判据只看最后一条 assistant，会把注入前的
 * 已完成回合当成本轮结束 —— 既不发静默卡，也不阻止队列把下一条消息塞进同一个
 * 卡死的会话。现在 `rows` 模式会把「最后一条真实 user 提示之后没有 assistant」
 * 也当成一个回合起点。
 *
 * 判据刻意只认「宿主真的写了新东西」：
 *   · `time.updated`（DB 行 time_updated，随流式写入/工具状态变化刷新）优先；
 *   · 再取 message/part 的 created/firstToken/streamed/completed 的最大值；
 *   · running/pending 的工具一律不算静默（工具卡看门狗负责更新那张卡）；
 *   · question 待答也不算静默（询问卡已经可见，且宿主没有回答接口）；
 *   · 宿主 synthetic 行（后台完成通知等）不是新回合起点，不参与 user 尾条判断。
 *
 * 这样「模型在长思考但仍在吐 token」不会被误杀；只有宿主连 DB 都不再写、且没有任何
 * 可见卡在更新的真挂起才会落到 `stall`。
 */

import { htmlEsc } from "./tg-html"

export type TurnStallState = "idle" | "live" | "tool" | "question" | "stall"

export type TurnStallVerdict = {
  state: TurnStallState
  /** 最后一条 assistant 消息 id（空串=没有消息）。 */
  msgId: string
  /** 距最后一次宿主写入的毫秒数。 */
  silentMs: number
  /** 最后一次宿主写入的时间戳（0=未知）。 */
  lastActivity: number
  /** state=tool/question 时的工具名。 */
  tool?: string
  why: string
}

const positive = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const infoOf = (m: any): any => (m?.info && typeof m.info === "object" ? m.info : m)
const roleOf = (m: any): string => String(infoOf(m)?.role ?? "")
const isCompactionRow = (m: any): boolean => {
  const info = infoOf(m)
  return info?.compaction === true || String(info?.type ?? m?.type ?? "") === "compaction"
}
const createdOf = (m: any): number => positive(infoOf(m)?.time?.created ?? m?.time?.created)
const completedOf = (m: any): number => positive(infoOf(m)?.time?.completed ?? m?.time?.completed)
const idOf = (m: any): string => String(infoOf(m)?.id ?? m?.id ?? "")

/** 兼容 V1 `{info, parts}`、v2 原始 `{content}` 与直接传 info 的三种形状。 */
const messageParts = (m: any): any[] =>
  Array.isArray(m?.parts) ? m.parts : Array.isArray(m?.content) ? m.content : []

const assistantStallVerdict = (o: {
  now: number
  message: any | null | undefined
  /** 超过这个静默时长才返回 stall；之前返回 live。 */
  noticeMs: number
}): TurnStallVerdict => {
  const now = positive(o.now) || Date.now()
  const m = o.message
  if (!m || typeof m !== "object") {
    return { state: "idle", msgId: "", silentMs: 0, lastActivity: 0, why: "no-message" }
  }
  const info = m.info && typeof m.info === "object" ? m.info : m
  const msgId = String(info?.id ?? m?.id ?? "")
  const t = (info?.time ?? m?.time ?? {}) as any
  const completed = positive(t?.completed)
  const created = positive(t?.created)
  const updated = positive(t?.updated)
  const firstToken = positive(t?.firstToken)
  const streamed = positive(t?.streamed)

  // 已完成 = 回合边界；哪怕完成时间很新，也不是静默。
  if (completed > 0) {
    return { state: "idle", msgId, silentMs: 0, lastActivity: completed, why: "completed" }
  }

  let lastActivity = Math.max(updated, created, firstToken, streamed)
  let runningTool = ""
  let runningQuestion = false
  for (const p of messageParts(m)) {
    const pt = (p?.time ?? {}) as any
    lastActivity = Math.max(
      lastActivity,
      positive(pt?.updated),
      positive(pt?.created),
      positive(pt?.completed),
    )
    if (String(p?.type ?? "") !== "tool") continue
    const status = String(p?.state?.status ?? "")
    if (status !== "running" && status !== "pending") continue
    const tool = String(p?.tool ?? p?.state?.tool ?? "")
    if (tool === "question") runningQuestion = true
    else if (!runningTool) runningTool = tool || "tool"
  }
  if (!lastActivity) lastActivity = created
  const silentMs = lastActivity > 0 ? Math.max(0, now - lastActivity) : 0

  // 工具/询问优先于静默：它们都有可见卡在更新，或本来就在等用户。
  if (runningQuestion) {
    return {
      state: "question",
      msgId,
      silentMs,
      lastActivity,
      tool: "question",
      why: "question-pending",
    }
  }
  if (runningTool) {
    return {
      state: "tool",
      msgId,
      silentMs,
      lastActivity,
      tool: runningTool,
      why: `tool-running:${runningTool}`,
    }
  }
  if (lastActivity <= 0) {
    // 连创建时间都没有：无法判断，保守当活回合（不误报）。
    return { state: "live", msgId, silentMs: 0, lastActivity: 0, why: "no-clock" }
  }
  if (silentMs < Math.max(0, Number(o.noticeMs) || 0)) {
    return { state: "live", msgId, silentMs, lastActivity, why: "recent-activity" }
  }
  return { state: "stall", msgId, silentMs, lastActivity, why: "no-output" }
}

/**
 * R2869：`rows` 模式。除了最后一条 assistant 的静默，还识别「最后一条真实 user
 * 提示之后没有 assistant」——这正是「重新注入消息后仍然卡住」的数据库形态。
 *
 * 只把 `role=user` 且不是宿主 synthetic 的行当回合起点；桥通过 promptAsync 注入的
 * 恢复/续跑提示在 DB 里就是 user 行，因此能被抓到；后台 shell 完成通知等 synthetic
 * 行不会被误当成新回合。
 */
export const turnStallVerdict = (o: {
  now: number
  message?: any | null
  rows?: any[]
  /** 超过这个静默时长才返回 stall；之前返回 live。 */
  noticeMs: number
}): TurnStallVerdict => {
  const now = positive(o.now) || Date.now()
  if (!Array.isArray(o.rows)) return assistantStallVerdict({ now, message: o.message, noticeMs: o.noticeMs })

  const rows = o.rows.filter((m) => m && typeof m === "object" && !isCompactionRow(m))
  let lastAssistant: any = null
  let lastUser: any = null
  for (const m of rows) {
    const role = roleOf(m)
    if (role === "assistant") lastAssistant = m
    else if (role === "user") {
      const info = infoOf(m)
      // 宿主 synthetic 行（后台完成通知、系统提示）不是用户/桥发起的回合起点。
      if (info?.synthetic === true || String(info?.type ?? "") === "synthetic") continue
      lastUser = m
    }
  }

  const av = assistantStallVerdict({ now, message: lastAssistant, noticeMs: o.noticeMs })
  // 回合仍有 assistant 在写/在跑/在等工具：它才是当前回合。
  if (av.state !== "idle") return av

  const userCreated = lastUser ? createdOf(lastUser) : 0
  const assistantCompleted = lastAssistant ? completedOf(lastAssistant) : 0
  if (lastUser && userCreated > 0 && userCreated > assistantCompleted) {
    const msgId = idOf(lastUser)
    const silentMs = Math.max(0, now - userCreated)
    const noticeMs = Math.max(0, Number(o.noticeMs) || 0)
    if (silentMs < noticeMs) {
      return { state: "live", msgId, silentMs, lastActivity: userCreated, why: "user-prompt-recent" }
    }
    return { state: "stall", msgId, silentMs, lastActivity: userCreated, why: "user-prompt-no-assistant" }
  }
  return av
}

export type StallCardPhase =
  | "notice"
  | "switching"
  | "switched"
  | "switch-failed"
  | "recovering"
  | "resumed"
  | "resume-failed"
  | "stopped"
  | "activity"

/**
 * 静默卡文案。`session` 是展示用短名（会被 htmlEsc）；`minutes` 是已静默分钟数。
 *
 * R2869：15 分钟到点后的首选动作从「注入续跑提示」改成「直接切换到新会话」，
 * 因为运营者实报「重新注入消息后仍然卡住」。`switching/switched/switch-failed`
 * 是主路径；`recovering/resumed/resume-failed` 只作为无法创建新会话时的回退。
 *
 * 注意：`resumed` 只由桥在「中断成功且已注入续跑提示」后使用；`activity` 表示
 * 回合自己恢复输出（或开始了工具）——两者不能混为一谈，否则日志/用户会误以为
 * 每次都发生了中断。
 */
export const stallCardText = (o: {
  session: string
  minutes: number
  phase: StallCardPhase
  recoverMinutes?: number
  detail?: string
}): string => {
  const session = htmlEsc(String(o.session ?? "").slice(0, 60))
  const mins = Math.max(1, Math.round(Number(o.minutes) || 1))
  const recover = Math.max(1, Math.round(Number(o.recoverMinutes) || 15))
  const detail = o.detail ? `\n${htmlEsc(String(o.detail).slice(0, 300))}` : ""
  switch (o.phase) {
    case "switching":
      return `⚠️ 本轮静默 · ${session}\n已 ${mins} 分钟没有任何新输出，判定上游流卡住。\n正在自动切换到新会话继续…`
    case "switched":
      return `♻️ 已自动切换会话并继续 · ${session}\n静默 ${mins} 分钟后切换到新会话（自动操作，非用户消息）。${detail}`
    case "switch-failed":
      return `⚠️ 自动切换会话未完成 · ${session}\n已 ${mins} 分钟无输出；切换新会话失败。\n请手动发消息或重启宿主。${detail}`
    case "recovering":
      return `⚠️ 本轮静默 · ${session}\n已 ${mins} 分钟没有任何新输出，判定上游流卡住。\n正在自动中断并续跑…`
    case "resumed":
      return `♻️ 已自动中断卡住的回合并续跑 · ${session}\n静默 ${mins} 分钟后恢复（自动注入，非用户消息）。${detail}`
    case "resume-failed":
      return `⚠️ 自动恢复未完成 · ${session}\n已 ${mins} 分钟无输出；中断请求已发出，但宿主未确认回合结束。\n请手动 ⏹ 或重启宿主。${detail}`
    case "stopped":
      return `⚠️ 本轮静默 · ${session}\n已 ${mins} 分钟没有任何新输出；循环/本会话已停，未自动中断。\n请手动处理。${detail}`
    case "activity":
      return `✅ 已恢复输出 · ${session}\n静默 ${mins} 分钟后重新有输出。`
    case "notice":
    default:
      return `⚠️ 本轮静默 · ${session}\n已 ${mins} 分钟没有任何新输出。\n可能是上游模型流卡住，不是你的操作。\n我会继续等待；到 ${recover} 分钟仍无输出会自动切换会话。${detail}`
  }
}

/**
 * 自动续跑提示。**前缀必须与 `_v2compat.SYNTHETIC_USER_PREFIXES` /
 * auto-continue `SYNTHETIC_PROMPT_PREFIXES` 对齐**：
 * `上一轮自动筛查应答因可恢复错误中断`。否则桥注入的这条会被当成真实用户消息，
 * 前端归属/「最近真实用户指令」统计会被它污染；对齐后 auto-continue 会把它识别为
 * 合成提示，abort 分类也会把它当作「用户后续发言」走 skip，不会重复注入恢复提示。
 */
export const STALL_RECOVER_PROMPT =
  "上一轮自动筛查应答因可恢复错误中断（实际原因：上游流长时间无输出，桥已自动中断该回合）。" +
  "请忽略该中断，直接从断点继续既定循环规则（不要重复已完成的内容）。" +
  "\n\n（自动注入提示：本消息由桥的回合静默看门狗发出，非用户新指令。）"
