/**
 * R2698（运营者：「代码的复用情况如何，精简，整理，优化，模块融合，分模块化设计」）：
 * 外发队列的**纯策略**（原 tg-bridge 的 flushQueue/sendQueued 内联判断）。
 *
 * 边界：队列状态（outQueue 数组、占位条 Map、flushing、floodNoticeFor）仍留在桥里，
 * 因为它与持久化、状态卡、/flush、/clear 多处共享；发送编排在 tg-send-text，
 * 削峰在 tg-pace，通道选择在 tg-send。本模块只回答四个判断，不持状态、不触网：
 *   · 这条排队项是否已过期到该丢（卡片提示类，15 分钟）；
 *   · 队列满 50 时该丢哪一条（R2384：命令回执插队后不能反被丢）；
 *   · 这次能否绕过队列直发；
 *   · 命令回执是否走队首优先。
 *
 * 行为与抽取前逐字一致（含边界：严格大于 15 分钟、`now == floodUntil` 视为已解除）。
 */

/** 外发队列项：和桥里的 outQueue 元素同形。 */
export type OutQueueItem = { chat: string; text: string; ts: number; kb?: unknown; replyTo?: number }

/** 排队超过 15 分钟的瞬时提示已过时，直接丢，给真正的内容让路。 */
export const STALE_HINT_MS = 15 * 60_000
/** 瞬时提示的固定前缀（📌 置顶变更 / 💉 注入 / ⏳ 进行中 / ✅ 完成 / ◻️ 自然停止）。 */
export const STALE_HINT_RE = /^(📌|💉|⏳|✅|◻️)/

/**
 * 是否为过期提示：`ts` 缺失按 0 计（等同极旧），文本必须以提示前缀开头。
 * 恰好等于 `maxAgeMs` 时**不算**过期（与旧实现 `>` 一致）。
 */
export const isStaleQueueHint = (
  item: { text?: unknown; ts?: number },
  now: number,
  maxAgeMs: number = STALE_HINT_MS,
): boolean => now - (item.ts ?? 0) > maxAgeMs && STALE_HINT_RE.test(String(item.text ?? ""))

/** 命令回执插队首，优先于旧通知。历史前缀 `[tg-bridge]` 仍识别；
 *  R2710 起桥对命令回执显式传 priority=true，不再依赖文案前缀（回执已改口语化）。 */
export const isPriorityQueueText = (text: string): boolean => text.trimStart().startsWith("[tg-bridge]")

/**
 * R2384：队列满 50 时选真正“最旧”的一项丢弃。
 *   · 普通追加（队尾）→ 队首即最旧；
 *   · 命令回执走 `unshift` 插到**队首**（最新）→ 跳过队首优先块，
 *     丢其中第一个普通项；
 *   · 整队都是命令回执时，丢队尾（最旧的那条回执）。
 */
export const pickQueueDropIndex = (queue: ReadonlyArray<{ text?: unknown }>, isPrio: boolean, skipHead = false): number => {
  if (!isPrio) return 0
  const ni = queue.findIndex((qq, i) => i >= (skipHead ? 1 : 0) && !isPriorityQueueText(String(qq.text ?? "")))
  return ni >= 0 ? ni : queue.length - 1
}

/**
 * 直发闸门：无积压、当前 chat 无占位条，且不在 Telegram 限流期。
 * 备用通道可用时允许直发（与旧实现 `Boolean(fallbackApiBase)` 一致）。
 */
export const canDirectSendQueue = (s: {
  queueLen: number
  hasPlaceholder: boolean
  floodUntil: number
  hasFallback: boolean
  now: number
}): boolean => s.queueLen === 0 && !s.hasPlaceholder && (s.now >= s.floodUntil || s.hasFallback)

// ---------------------------------------------------------------------------
// R2699：外发队列引擎（原 tg-bridge 的 flushQueue + sendQueued 闭包）。
//
// 队列数组与占位条 Map 仍由桥持有并注入：它们同时被持久化、状态卡、/flush、
// /clear 读取；引擎只拿引用，不复制状态。发送编排在 tg-send-text，削峰在
// tg-pace，通道在 tg-send。这样队列机制只有一份，桥里不再保留直发/排队流程。
// ---------------------------------------------------------------------------

export type QueueSendResult = { r: "sent" | "retry" | "drop" }

export type OutQueueEngineDeps = {
  /** 桥持有的外发队列（持久化/状态卡共用同一个数组）。 */
  items: OutQueueItem[]
  /** chat -> 占位条 message_id（排空即删）。 */
  placeholders: Map<string, number>
  /** 发送正文（桥注入 tg-send-text.createSendText）。第 4 参是 silent，与旧调用位一致。 */
  send: (chat: string, text: string, kb?: unknown, silent?: boolean, replyTo?: number) => Promise<QueueSendResult>
  /** 通道 fetch（仅用于占位条的发送/删除）。 */
  fetch: (method: string, body: Record<string, unknown>) => Promise<{ ok: boolean; id?: number }>
  log: (level: "info" | "warn" | "error", message: string) => Promise<void> | void
  sanitize: (value: unknown) => string
  save: () => void
  noteDrop: (kind: string, detail: string) => void
  markPushed: () => void
  notify: (chat: string, text: string) => Promise<void> | void
  getFloodUntil: () => number
  hasFallback: () => boolean
  now?: () => number
  /** 队列上限，默认 50（与旧实现一致）。 */
  maxItems?: number
}

export const OUT_QUEUE_MAX = 50

export type OutQueueEngine = {
  flush: () => Promise<void>
  send: (chatID: string, text: string, kb?: unknown, replyTo?: number) => Promise<void>
  isFlushing: () => boolean
}

export const createOutQueueEngine = (deps: OutQueueEngineDeps): OutQueueEngine => {
  const now = deps.now ?? (() => Date.now())
  const maxItems = Number.isFinite(deps.maxItems) ? Math.max(1, Math.floor(Number(deps.maxItems))) : OUT_QUEUE_MAX
  const { items, placeholders } = deps
  let flushing = false
  let floodNoticeFor: { chat: string; since: number; queued: number } | null = null

  const flush = async (): Promise<void> => {
    if (flushing || items.length === 0) return
    flushing = true
    try {
      while (items.length > 0) {
        const head = items[0]!
        // 排队超 15 分钟的瞬时提示（📌💉⏳✅◻️）已过时，直接丢，给真正的内容让路
        if (isStaleQueueHint(head, now())) {
          items.shift()
          await deps.log("info", `dropped stale hint (len=${head.text.length}, left=${items.length})`)
          deps.save()
          continue
        }
        const r = await deps.send(head.chat, head.text, head.kb, undefined, head.replyTo)
        if (r.r === "retry") {
          if (!floodNoticeFor) floodNoticeFor = { chat: head.chat, since: now(), queued: items.length }
          break
        }
        // 限流刚结束：把"刚才发生了什么"说清楚，别让聊天里凭空缺一段。
        if (floodNoticeFor) {
          const f = floodNoticeFor
          floodNoticeFor = null
          const secs = Math.max(1, Math.round((now() - f.since) / 1000))
          if (secs >= 20) {
            await deps.log("info", `flood recovered (waited ${secs}s, queued=${f.queued})`)
            await deps.notify(f.chat, `✅ Telegram 限流恢复（等待 ${secs}s${f.queued ? `，补发 ${f.queued} 条` : ""}）`)
          }
        }
        items.shift()
        if (r.r === "sent") {
          deps.markPushed()
          await deps.log("info", `sent queued to ${deps.sanitize(head.chat)} (len=${head.text.length}, left=${items.length})`)
        } else {
          await deps.log("error", `dropped queued to ${deps.sanitize(head.chat)} (len=${head.text.length}, left=${items.length})`)
        }
        // 该 chat 排空即删占位条
        if (!items.some((q) => q.chat === head.chat)) {
          const ph = placeholders.get(head.chat)
          if (ph) {
            placeholders.delete(head.chat)
            try {
              await deps.fetch("deleteMessage", { chat_id: Number(head.chat) || head.chat, message_id: ph })
            } catch {
              /* best-effort */
            }
          }
        }
        deps.save()
      }
    } finally {
      flushing = false
    }
  }

  const send = async (chatID: string, text: string, kb?: unknown, replyTo?: number, priority?: boolean): Promise<void> => {
    if (!text) return
    // 没有积压且当前没有占位/防洪闸时，先直接发送；只有明确失败才创建队列项。
    // 这样实时 assistant 内容不会短暂进入 outQueue，队列长度也能真实反映待重试消息。
    const canDirect = canDirectSendQueue({
      queueLen: items.length,
      hasPlaceholder: placeholders.has(chatID),
      floodUntil: deps.getFloodUntil(),
      hasFallback: deps.hasFallback(),
      now: now(),
    })
    if (canDirect) {
      const direct = await deps.send(chatID, text, kb, undefined, replyTo)
      if (direct.r === "sent") {
        deps.markPushed()
        await deps.log("info", `direct outbound sent (chat=${deps.sanitize(chatID)}) len=${text.length}`)
        deps.save()
        return
      }
      if (direct.r === "drop") {
        await deps.log("error", `direct outbound dropped (chat=${deps.sanitize(chatID)}): no retry`)
        deps.save()
        return
      }
      // retry：继续走下面的持久化队列，绝不把失败误报成已发送。
    }
    const congested = items.length > 0
    const item = { chat: chatID, text, ts: now(), kb, replyTo }
    // 命令回执优先于旧通知，避免用户刚发的 /whoami、/loop status 卡在历史队列尾。
    const isPrio = priority === true || isPriorityQueueText(text)
    if (isPrio) items.unshift(item)
    else items.push(item)
    if (items.length > maxItems) {
      // R2384：超限要丢的是**最旧**项。命令回执走 `unshift` 插到**队首**（那是最新、不是最旧），
      // 若仍照旧 `shift()` 就会正好把刚插入的这条回执丢掉 —— 与上面"命令回执优先"自相矛盾，
      // 且日志"dropped oldest"是假话。故按入队方向选真正的最旧项（判据见 pickQueueDropIndex）。
      const dropIdx = pickQueueDropIndex(items, isPrio, priority === true)
      const [dropped] = items.splice(dropIdx, 1)
      await deps.log("error", `outbound queue full (${maxItems}): dropped oldest (len=${(dropped as any)?.text?.length ?? 0})`)
      deps.noteDrop("queue-full", `outbound queue full (${maxItems}): dropped oldest`)
    }
    // 拥塞时先立占位条（直发不进队），排空即删；限流期跳过占位（省一次触网）
    if (congested && !placeholders.has(chatID) && now() >= deps.getFloodUntil()) {
      try {
        const pr = await deps.fetch("sendMessage", {
          chat_id: Number(chatID) || chatID,
          text: "⏳ 已列队，发送中…",
          ...(replyTo ? { reply_to_message_id: replyTo } : {}),
        })
        if (pr.ok && pr.id) placeholders.set(chatID, pr.id)
      } catch {
        /* best-effort */
      }
    }
    deps.save()
    await flush()
  }

  return { flush, send, isFlushing: () => flushing }
}
