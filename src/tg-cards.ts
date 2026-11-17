// R2701：状态卡 / 注入短消息 / 置顶队列卡的纯渲染与编辑决策。
// 从 tg-bridge 上收：只依赖 htmlEsc 与桥注入的 fmtTime，不碰桥运行态；
// 卡片持久化（inject-card-*.json）仍在桥内，等 tg/state.ts 统一迁移。
import { htmlEsc } from "./tg-html"

/** 渲染器需要的格式化函数；桥注入自己解析过的 fmtTime（TG_TZ / tg.env 级联一致）。 */
export type CardRenderFormats = { fmtTime: (ms: number) => string }

export const createCardRenderers = ({ fmtTime }: CardRenderFormats) => {
  /** 状态卡文案（纯函数，统一 htmlEsc 动态字段；调用方传原始未转义文本）。 */
  const injectCardText = (o: {
    bot: string
    lastAt: number
    kind: string
    sid: string
    count: number
    avgGapMs: number
    gate: { stopped: boolean; by: string; reason: string }
    now: number
    /**
     * R2678：当前展示的会话是否**没有**登记在自动循环名单里。
     * 只读 loop-ctl 的 Bot 闸会把「本会话 /loop off」误报成「循环运行中」，
     * 正是运营者看到“两套同时在跑”的一个来源。缺省 false 保持旧调用兼容。
     */
    sessionLoopOff?: boolean
    /** 可选：当前会话/队列状态；旧调用不传时保持原卡片文案不变（兼容单测）。 */
    session?: string
    /** R923：会话实时状态（运行中 / outcome（空闲 Nm）），置顶循环卡也显示。 */
    sessionState?: string
    queue?: number
    pinQueue?: number
    paused?: boolean
    /** R2508：本次实际渲染时间，让“每 60s 刷新”在卡上可见（否则状态没变时看起来像停更）。 */
    refreshedAt?: number
    /** R2508：token 无效被跳过的 Bot（仅 id，不含 token）。 */
    offline?: string
    /**
     * R2577：卡片实际是否在聊天里置顶。三态而不是 boolean：
     * true=已校验在顶；false=已校验丢失；undefined=还没探过（显示“待校验”）。
     * 旧实现无条件写“已置顶”，bot5 的 28732 明明钉不上也一直那样显示。
     */
    pinned?: boolean
  }): string => {
    const pad = (n: number): string => String(n).padStart(2, "0")
    const stamp = fmtTime(o.lastAt > 0 ? o.lastAt : o.now)
    const refreshStamp = fmtTime(o.refreshedAt && o.refreshedAt > 0 ? o.refreshedAt : o.now)
    const short = o.sid.replace(/^ses_/, "").slice(0, 10)
    const gap = o.avgGapMs > 0 ? `${Math.floor(o.avgGapMs / 60000)}分${pad(Math.round((o.avgGapMs % 60000) / 1000))}秒` : "—"
    const g = o.gate
    const byLabel = g.by === "user" ? "用户" : g.by === "auto" ? "自动" : g.by
    const gateLine = g.stopped
      ? `⏸ 循环已停${byLabel ? `（${htmlEsc(byLabel)}）` : ""}${g.reason ? ` · ${htmlEsc(g.reason.slice(0, 48))}` : ""}`
      : o.sessionLoopOff
        ? "⏸ 本会话未开循环（/loop on 开启）"
        : "▶ 循环运行中"
    return [
      `🔁 循环注入 · ${htmlEsc(o.bot)}`,
      ...(o.session
        ? [`会话 ${htmlEsc(o.session)}${o.sessionState ? ` · ${htmlEsc(o.sessionState)}` : ""} · ${o.paused ? "推送暂停" : "推送中"} · 队列 外发 ${o.queue ?? 0} / 注入 ${o.pinQueue ?? 0}`]
        : []),
      `最后注入：${stamp} · ${o.kind === "quota" ? "尾恢复" : o.kind === "recover" ? "恢复" : "轮次"} · ses_${htmlEsc(short)}`,
      `累计 ${o.count} 次 · 平均间隔 ${gap}`,
      gateLine,
      `刷新 ${refreshStamp} · 每 60s 自动刷新${o.pinned === true ? "（已置顶）" : o.pinned === false ? "（未置顶）" : "（置顶待校验）"}`,
      ...(o.offline ? [`离线 ${htmlEsc(o.offline)}（token 无效）`] : []),
    ].join("\n")
  }

  // R2666（运营者：「循环注入和尾恢复没有提示」）：注入状态卡是**静默编辑**，
  // Telegram 不会因此提醒；这里生成一条独立的短消息，由桥在注入成功后发送。
  // 卡片继续负责累计次数/状态，短消息负责“刚刚发生了什么”。
  const injectNoticeText = (o: {
    bot: string
    sid: string
    kind: "round" | "recover" | "quota"
    count: number
    at: number
  }): string => {
    const stamp = fmtTime(o.at > 0 ? o.at : Date.now())
    const short = String(o.sid ?? "").replace(/^ses_/, "").slice(0, 10)
    const head = o.kind === "quota" ? "🧯 额度尾恢复" : o.kind === "recover" ? "🩹 恢复续跑" : "🔁 循环注入"
    const detail = o.kind === "round" ? "自动轮次（非用户消息）" : "已续跑一次（非用户消息）"
    return [
      `${head} · ${htmlEsc(o.bot)}`,
      `会话 ses_${htmlEsc(short)} · ${detail}`,
      `累计注入 ${o.count} 次 · ${stamp}`,
    ].join("\n")
  }

  return { injectCardText, injectNoticeText }
}

/** 循环状态卡底部按钮：只放一个高频动作，避免把置顶卡变成第二套菜单。 */
export const injectCardKeyboard = (): unknown[][] => [
  [{ text: "✍️ AI 改标题", callback_data: "title:ai" }],
]

/**
 * R2574（D7）：置顶队列卡的文案（纯函数）。
 * 状态行 + 两条队列计数由同一函数生成，edit/create 两条路径不再各写一份字面量。
 */
export const queuePinCardText = (statusLine: string, nPin: number, nOut: number): string =>
  `${statusLine}\n📥 队列 ${nPin + nOut} 条（注入 ${nPin} · 外发 ${nOut}；/queue 查看）`

/**
 * R2575（运营者：「隔壁置顶的队列消息怎么没有更新」）：判断一条消息是否是
 * 本桥的队列置顶卡。用于启动时从 `getChat().pinned_message` 认领
 * 「Telegram 侧还在、状态文件里已丢失记录」的卡；注入状态卡虽然也带队列
 * 计数，但**没有** `📥 队列` 这一行与 `/queue 查看` 入口，不能误认。
 */
export const isQueuePinCardText = (text: string): boolean =>
  text.includes("📥 队列 ") && text.includes("/queue 查看")

/**
 * R2577：判断一条消息是否是本桥的循环注入状态卡。用于置顶自愈时区分
 * 「当前这张卡没钉上」与「别的消息（队列卡/用户消息）占着置顶」。
 * 只认状态卡的固定抬头 + 刷新行，避免把注入短消息（🔁 循环注入 · ...）误认。
 */
export const isInjectCardText = (text: string): boolean =>
  text.startsWith("🔁 循环注入 · ") && text.includes("每 60s 自动刷新")

/**
 * R2574（D7）：置顶队列卡是否需要重算状态行。
 *
 * 旧实现只在 `n !== lastQPinCount` 时重算 → 队列条数不变时，会话从「进行中」
 * 变成「完成/错误」也不会写回卡面（用户看到状态卡停在旧状态）。现在：
 *   ① 条数变化立即重算；
 *   ② 条数不变时也至少每 ttlMs 重算一次（由 30s tick 驱动）。
 */
export const queuePinStatusDue = (o: {
  count: number
  lastCount: number
  now: number
  lastStatusAt: number
  ttlMs: number
}): boolean => {
  if (o.count !== o.lastCount) return true
  if (!(o.lastStatusAt > 0)) return true
  return o.now - o.lastStatusAt >= Math.max(0, o.ttlMs)
}

/**
 * R2574（D7）：编辑置顶队列卡的决策。
 *   - 文案没变 → skip（Telegram 也不接受同文编辑，省一次 API）；
 *   - 距上次编辑不足 minEditMs → defer（调用方置 qpinDirty，3s 后重试，绝不丢更新）；
 *   - 否则 edit。
 */
export const queuePinEditDecision = (o: {
  text: string
  lastText: string
  now: number
  lastEditAt: number
  minEditMs: number
}): "skip" | "defer" | "edit" => {
  if (o.text === o.lastText) return "skip"
  if (o.lastEditAt > 0 && o.now - o.lastEditAt < Math.max(0, o.minEditMs)) return "defer"
  return "edit"
}
