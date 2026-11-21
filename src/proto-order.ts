/**
 * R2873（运营者：「确定全部消息发送的时序是否正确，比如 ❌ 生成失败 和 🧠 思考 的先后顺序」）：
 * 错误卡抢在更早的思考/正文卡前面。
 *
 * 2026-11-20 14:42:35 实证（bot6）：
 *   · `msg_1f968b2d`（工具步）的 reasoning part 于 .013 完成，整行 .060 完成；
 *   · 紧随其后的 `msg_1f968c3c` 于 .309 以 provider.free-limit 失败；
 *   · Telegram 上错误卡 = 72648，思考卡 = 72649 —— 后生产的错误卡先到。
 *
 * 根因不是事件并发（v2 适配器的事件循环是串行 `await hook`），而是**两条投递路径**：
 *   · 思考/正文主要靠 2s 的 catchup 补扫（`proto part-push` 在当前宿主上从不触发）；
 *   · 致命错误走 `session.step.failed → message.updated`，错误行此时已落盘，立即投递。
 * catchup 还没来得及补推上一行时，错误卡就先发了。
 *
 * 本模块只做**纯判定**：一条 assistant 行按当前过滤档位会生成哪些卡片键。
 * 桥在发错误卡前用它检查同一回合更早的 assistant 行，把缺失的卡片先补推，
 * 保证 Telegram 上的顺序与生产顺序一致。发送动作仍在 tg-bridge。
 */

export type VisibleCardKeyOptions = {
  sid: string
  mid: string
  parts: unknown
  /** `full` = 主目标（思考+正文）；`text` = 附加镜像（只正文）。 */
  mode?: "full" | "text"
  /** `filters.think` 档位；<=0 不生成思考卡。 */
  think?: number
  /** `filters.reply` 档位；<=0 不生成正文卡。 */
  reply?: number
  /** 与桥的 `isInternalLog` 同源；返回 false 的文本不生成卡片。 */
  include?: (text: string) => boolean
}

/**
 * 按 `protoPushAssistantMessage` 的同一套 part 下标规则，列出该行会投递的卡片键。
 *
 * 关键：**每个** part 都占一个下标（工具/思考/正文都算），只有非空且未被过滤的
 * reasoning/text 才产出键。下标漂移会让「已投递」判断失效，所以这里刻意复刻循环。
 */
export const visibleCardKeys = (o: VisibleCardKeyOptions): string[] => {
  const sid = String(o.sid ?? "")
  const mid = String(o.mid ?? "")
  if (!sid || !mid) return []
  const msgKey = mid.slice(0, 20)
  const mode = o.mode === "text" ? "text" : "full"
  const think = Number(o.think ?? 2)
  const reply = Number(o.reply ?? 2)
  const include = o.include
  const out: string[] = []
  let idx = 0
  for (const p of Array.isArray(o.parts) ? (o.parts as any[]) : []) {
    const pIdx = idx++
    const t = String(p?.type ?? "")
    if (t === "reasoning") {
      if (mode !== "full" || !(think > 0)) continue
      const txt = String(p?.text ?? "").trim()
      if (!txt || (include && !include(txt))) continue
      out.push(`${sid}:thinking:${msgKey}:${pIdx}`)
    } else if (t === "text") {
      if (!(reply > 0)) continue
      const txt = String(p?.text ?? "").trim()
      if (!txt || (include && !include(txt))) continue
      out.push(`${sid}:message:${msgKey}:${pIdx}`)
    }
  }
  return out
}

/**
 * 返回 required 中尚未**真正落地**的键（保持原顺序）。`delivered` 只传
 * `protoMap.keys()`。
 *
 * 刻意不接受 `protoRetry.keys()` 当“已投递”：进了重试队列只代表“稍后再发”，
 * Telegram 上还没有这张卡。把它算作已投递会让错误卡先发、重试卡后到，正好复现
 * 本模块要修的倒挂。调用方对重试中的键应交给 `protoSend` 的等待屏障
 *（`pendingProtoRetryForChat`）或让错误卡也进入同一重试队列，而不是直接忽略。
 */
export const missingCardKeys = (required: Iterable<string>, delivered: Iterable<string>): string[] => {
  const have = new Set(delivered)
  const out: string[] = []
  for (const k of required) {
    if (typeof k !== "string" || !k) continue
    if (have.has(k)) continue
    out.push(k)
  }
  return out
}
