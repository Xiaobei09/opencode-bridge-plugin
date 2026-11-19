/**
 * 压缩卡片（纯函数，供单测钉死）。
 *
 * v2 把压缩存成独立的 `session_message.type = "compaction"`，它不是 assistant 回合。
 * 兼容层过去为了喂 v1 消费者，把压缩行伪装成 `role=assistant` 的「假完成消息」，
 * 桥随后按普通 assistant 消息推送 → 标题变成「💬 回复」。这与 v2 语义不符，也把
 * 压缩摘要混进了消息流。
 *
 * 这里把压缩的展示口径单独定下来：
 *   · 标题固定为「🗜 压缩 · 状态」，不再叫「回复」；R2747 再去掉「会话」二字；
 *   · 状态/原因/错误只出现一次，不重复塞进正文；
 *   · 摘要按分片长度切开，片数和截断量都明说，避免 Telegram 的 4096 字符上限截断。
 */

export const COMPACTION_CHUNK_CHARS = 2800
export const COMPACTION_MAX_CHUNKS = 5

export const compactionStatusLabel = (status: string): string => {
  const s = String(status ?? "")
  if (s === "completed") return "完成"
  if (s === "failed") return "失败"
  if (s === "running") return "进行中"
  return s || "未知"
}

export type CompactionCard = { title: string; body: string }

export const compactionCards = (input: {
  status?: string
  reason?: string
  error?: string
  summary?: string
}): CompactionCard[] => {
  const status = String(input.status ?? "unknown")
  const title = `🗜 压缩 · ${compactionStatusLabel(status)}`
  const reasonLabel = input.reason === "auto" ? "自动" : input.reason === "manual" ? "手动" : String(input.reason ?? "")
  const meta = [
    reasonLabel ? `原因：${reasonLabel}` : "",
    input.error ? `错误：${String(input.error).slice(0, 200)}` : "",
  ]
    .filter(Boolean)
    .join("\n")
  const summary = String(input.summary ?? "")
  if (!summary) return [{ title, body: meta || `状态：${compactionStatusLabel(status)}` }]

  const chunks: string[] = []
  for (let off = 0; off < summary.length && chunks.length < COMPACTION_MAX_CHUNKS; off += COMPACTION_CHUNK_CHARS) {
    chunks.push(summary.slice(off, off + COMPACTION_CHUNK_CHARS))
  }
  const shown = chunks.length * COMPACTION_CHUNK_CHARS
  const truncated = summary.length > shown

  return chunks.map((chunk, i) => {
    const last = i === chunks.length - 1
    const suffix = last ? (truncated ? `\n[已截断 ${summary.length - shown} 字]` : "") : "\n…（续）"
    return {
      title: chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title,
      body: [i === 0 ? meta : "", `${chunk}${suffix}`].filter(Boolean).join("\n\n"),
    }
  })
}
