/**
 * R2832/R2848：注入队列条目的重复判定。
 *
 * 背景：idle 模式下用户消息先入 pinqueue，再由泵逐条注入。R2832 曾用「条目时间
 * 早于会话里最新一条 TG 用户消息 30 分钟以上」来判定旧副本，防止 13:45 那种
 * 「已从队列卡读到并处理、条目却还留着」的消息被补投第二次。
 *
 * 2026-11-19 16:55 运营者实报：「这个过期队列消息是什么鬼？必须修复」。15:32
 * 排队的「确定全部完成我上面注入的消息！」从未真正注入，只因为之后有更新的
 * TG 消息，就被时间闸当成过期副本跳过 —— 时间只能证明「之后有别的消息」，
 * 不能证明「这一条已经执行过」，旧消息因此被误丢。
 *
 * R2848 改为**同文 + 时间窗**判定：只有队列时间（`ts`）之后会话里出现过同一条
 * TG 用户消息（即这一条真正注入过）才跳过。这样：
 *   · 从未注入的旧消息照常注入，不再被误杀；
 *   · 注入后残留/重放的副本（行时间晚于入队时间）仍会被识别并清掉；
 *   · 运营者重复发送同一句（如「继续」）时，新条目晚于上一条注入行，不会被误判。
 *
 * 注入格式见 `doPrompt`：`[TG user message]( (回复引用：…))? <text>`，
 * 故用 trim 后 `endsWith` 比对正文。缺失时间戳/空正文一律 fail-open（照常注入）。
 */
const TG_USER_PREFIX = "[TG user message]"

const rowCreatedAt = (row: any): number =>
  Number(row?.info?.time?.created ?? row?.time?.created ?? 0) || 0

const rowText = (row: any): string => {
  if (typeof row?.text === "string" && row.text) return row.text
  if (Array.isArray(row?.parts)) {
    return row.parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
  }
  return ""
}

/**
 * 会话快照里是否已有这条队列内容的 TG 用户消息，且出现时间不早于入队时间。
 * 只认 user 行；assistant 的引用/推理不算投递。空正文、缺失/非法入队时间
 * 一律返回 false（fail-open，照常注入），避免历史遗留条目被误杀。
 */
export const pinTextDelivered = (
  rows: readonly unknown[],
  text: string,
  queuedAt: number,
): boolean => {
  const want = String(text ?? "").trim()
  if (!want) return false
  const since = Number(queuedAt) || 0
  if (since <= 0) return false
  for (const raw of rows) {
    const row: any = raw
    const role = row?.info?.role ?? row?.role
    if (role !== "user") continue
    if (rowCreatedAt(row) < since) continue
    const t = rowText(row).trim()
    if (!t.includes(TG_USER_PREFIX)) continue
    // 注入格式在正文前固定有一个空格（`… ${text}`）；带上边界再比，
    // 避免把「继续修复」当成「修复」的已投递副本。
    if (t.endsWith(` ${want}`)) return true
  }
  return false
}
