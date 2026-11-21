/**
 * R2879：⏹ 停止回合的**唯一判据**（纯函数，不碰网络/文件/插件状态）。
 *
 * 背景（运营者反复实报「会话停不下来」）：
 *   · 旧 `verifyTurnEnded` 只认「最后一条 assistant 的 time.completed」。
 *   · 若宿主中断后留下 `completed=0` 的 assistant 行（provider 断线、重试耗尽、
 *     abort 只写了半个行），或用户提示后宿主还没来得及创建 assistant 行，
 *     这个判据**永远**返回 false → 用户按多少次 ⏹ 都被告知「回合未结束」。
 *   · 但宿主自己的回合边界 `session_v2.time_busy / time_idle` 已经写明回合是否在跑；
 *     中断接口返回 `interrupted:false` 也表示宿主侧没有在途回合。
 *
 * 这里按可信度从高到低判定，全部条件都要求「尾段没有 running/pending 工具」：
 *   1. 最后一条 assistant 已 completed —— 明确结束；
 *   2. 宿主宣布 idle（idle >= busy 或 busy=0 且有 idle）且最后一条对话行已静置
 *      一个确认窗 —— 死回合残留也算结束；
 *   3. 中断接口明确回报 `interrupted:false`（没有在途回合）—— 结束；
 *   4. 消息为空且宿主判据可用 —— 没有回合可停。
 *
 * 刻意**不**用「固定等 N 秒后就算成功」的推断：那会把仍在生成的长回合误报成
 * 已停止，正是 R998 修掉的「假成功」。拿不到任何宿主信号时宁可如实回报未确认。
 */

export type StopHostTimes = { busy?: number; idle?: number }

export type StopInterruptAck = {
  /** 宿主/本机 API 明确回答是否有在途回合；undefined = 通道只回了成功，没给结论。 */
  interrupted?: boolean
  /** 实际生效的通道名，仅用于诊断。 */
  channel?: string
}

export type StopVerdict = { ended: boolean; why: string }

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

/** 宿主 synthetic 行（后台完成通知/重启提示）不是对话回合，不能挡住停止判定。 */
const isSyntheticRow = (m: any): boolean => {
  const info = infoOf(m)
  return info?.synthetic === true || String(info?.type ?? m?.type ?? "") === "synthetic"
}

const createdOf = (m: any): number => positive(infoOf(m)?.time?.created ?? m?.time?.created)

const completedOf = (m: any): number => positive(infoOf(m)?.time?.completed ?? m?.time?.completed)

const updatedOf = (m: any): number =>
  positive(infoOf(m)?.time?.updated ?? m?.time?.updated) || createdOf(m)

/** 尾段（末 6 行）是否有仍在执行/待执行的工具。 */
const tailLiveTool = (rows: any[]): string => {
  for (let i = rows.length - 1, seen = 0; i >= 0 && seen < 6; i--, seen++) {
    const row = rows[i]
    const parts = Array.isArray(row?.parts) ? row.parts : Array.isArray(row?.info?.parts) ? row.info.parts : []
    for (const p of parts) {
      if (String(p?.type ?? "") !== "tool") continue
      const st = String(p?.state?.status ?? "")
      if (st === "running" || st === "pending") return st
    }
  }
  return ""
}

/**
 * 宿主是否明确宣布空闲。
 * 与 `session-state.hostSessionRunning` 同一口径，但这里只关心「是否有可用信号」：
 *   · busy>0 且（idle 缺失/0 或 busy>idle）⇒ 运行中；
 *   · 其余有 busy/idle 的状态 ⇒ 空闲。
 */
const hostIdle = (host?: StopHostTimes | null): boolean | undefined => {
  const busy = positive(host?.busy)
  const idle = positive(host?.idle)
  if (!(busy > 0) && !(idle > 0)) return undefined
  return !(busy > 0 && (idle <= 0 || busy > idle))
}

export const stopEndedVerdict = (o: {
  rows: unknown
  now: number
  host?: StopHostTimes | null
  ack?: StopInterruptAck | null
  /** 宿主 idle 后尾行至少静置多久才采信（默认 1500ms）。 */
  settleMs?: number
}): StopVerdict => {
  const now = positive(o.now) || Date.now()
  const settleMs = Math.max(0, Number(o.settleMs ?? 1_500))
  const rows = Array.isArray(o.rows) ? (o.rows as any[]).filter((m) => m && !isCompactionRow(m)) : []

  let lastAssistant: any = null
  let lastDialog: any = null
  for (const m of rows) {
    const role = roleOf(m)
    if (role !== "user" && role !== "assistant") continue
    // synthetic user 行不构成回合起点；否则后台通知会把「已完成」判成「未结束」。
    if (role === "user" && isSyntheticRow(m)) continue
    lastDialog = m
    if (role === "assistant") lastAssistant = m
  }

  // 宿主明确 busy（busy>idle）时，即使最后一步 assistant 已 completed，也只能说明
  // **这一步**结束，宿主可能马上接下一步。停止复核必须继续等 idle/中断结论，不能
  // 拿这一步的 completed 冒充「整回合已停」——那正是用户按了 ⏹ 却继续出字的假成功。
  const idle = hostIdle(o.host)
  const hostBusy = idle === false

  // ① 最后一条 assistant 的**这一步**已完成，其后没有更新的真实 user 行，且宿主
  // 没有报告还在跑：这是最直接的结束信号。旧实现只看 assistant，会把「上一条已完成
  // + 新 user 正在起回合」误判成已停止（假成功）；新 user 之后必须等宿主 idle / ack。
  const lastCompleted = lastAssistant ? completedOf(lastAssistant) : 0
  if (lastCompleted > 0 && lastDialog === lastAssistant && !hostBusy) {
    return { ended: true, why: "assistant-completed" }
  }
  // 本轮尾条是比最后 assistant 更新的 user 行：旧 assistant 的 completed 属于上一轮，
  // 不能拿它判「本轮结束」。
  const trailingUser = lastDialog !== lastAssistant && roleOf(lastDialog) === "user"

  const live = tailLiveTool(rows)

  // ② 中断接口明确说「没有在途回合」：即便 DB 尾部是半行/只有 user、或尾段还
  //    残留 running/pending 工具（中断后宿主没来得及改状态），也以宿主的明确结论为准。
  //    旧实现没有这条通道，只能看 assistant 半行 → 用户按多少次 ⏹ 都停不了。
  if (o.ack?.interrupted === false) {
    return {
      ended: true,
      why: trailingUser
        ? "no-active-turn(user tail)"
        : lastAssistant && lastCompleted <= 0
          ? "no-active-turn(incomplete assistant)"
          : "no-active-turn",
    }
  }

  // ③ 宿主明确 idle：这是回合边界，比 incomplete assistant 行权威。
  if (idle === true) {
    if (live) return { ended: false, why: `host-idle, tool-${live}` }
    const rowAt = lastDialog ? Math.max(createdOf(lastDialog), completedOf(lastDialog), updatedOf(lastDialog)) : 0
    const idleAt = positive(o.host?.idle)
    // 旧 idle 不能给新回合作证：busy 可能还没写、idle 还停在上一回合。若 idle 早于
    // 本轮最后一行（新 user / 半条 assistant），它只说明**上一回合**结束过；继续等
    // busy/ack，避免把刚注入的回合误报成已停止。
    if (idleAt > 0 && rowAt > 0 && idleAt < rowAt) {
      return { ended: false, why: `host-idle-stale-${Math.round((rowAt - idleAt) / 1000)}s` }
    }
    // 宿主可能刚写 idle，最后一行还在流式写入的尾巴上；给一个短确认窗。
    const newest = Math.max(rowAt, idleAt)
    if (newest > 0 && now - newest < settleMs) {
      return { ended: false, why: `host-idle-settling-${Math.round((now - newest) / 1000)}s` }
    }
    return {
      ended: true,
      why: trailingUser
        ? "host-idle(user tail)"
        : lastAssistant && lastCompleted <= 0
          ? "host-idle(incomplete assistant)"
          : "host-idle",
    }
  }

  // ④ 完全没有对话行，且宿主给了可用状态（idle=false 已在上面处理；这里只可能是
  //    「已知运行中但没有任何消息」的异常态，不能当结束）。
  if (!lastDialog && hostBusy) return { ended: false, why: "host-busy, no-message" }

  return {
    ended: false,
    why: live
      ? `turn-live(tool-${live})`
      : hostBusy
        ? trailingUser
          ? "host-busy(user tail)"
          : "host-busy(turn-continuing)"
        : trailingUser
          ? "user-tail-unconfirmed"
          : lastAssistant && lastCompleted <= 0
            ? "assistant-incomplete"
            : lastDialog
              ? "user-tail-unconfirmed"
              : "no-host-signal",
  }
}
