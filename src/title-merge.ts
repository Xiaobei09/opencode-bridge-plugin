/**
 * R2673（运营者原文：「增加一种模式，给仅标题的同种信息模式的连续的合并为一个，
 * 时间标记为最后时间，后面增加一个（×n)的标记」）：「仅标题消息合并」模式。
 *
 * 背景：推送过滤里「仅标题」档（filt=1）下，思考/工具/回复卡片只剩一行
 * `<b>… · HH:MM:SS · 会话名</b>`。同一回合里连续出现时，手机上一屏会被同种标题
 * 刷满。模式开启后，**同一 chat、同一会话、同一标题种类**的连续仅标题卡片不再
 * 各发一条，而是改写上一条：标题时钟取最后一条的时间，末尾追加 `（×n）`。
 *
 * 为什么单独一个文件：
 *   · 文案判据（仅标题 / 种类 / 计数后缀）是可单测的纯函数；
 *   · R2674：开关是**本 Bot 的推送显示设置**，和 filters/compress 一样持久化在
 *     各 Bot 自己的 tg-chats[-<id>].json 里，不再使用全局 title-merge-mode.json。
 *     这样在 bot5 的菜单里切换不会改到 bot6；默认 off，不改变既有部署行为。
 *
 * 断开条件（由 tg-bridge 负责）：任何**新发出**的非仅标题、或不同种类的卡片
 * （回复正文、错误卡、问询卡、别的会话）都会结束当前链条。
 */

export type TitleMergeMode = "on" | "off"

/** 仅标题卡片：整条消息只有一个 <b>…</b>，没有正文行。 */
const TITLE_ONLY_RE = /^\s*<b>([\s\S]*?)<\/b>\s*$/

/** 计数后缀：兼容全角/半角括号（用户原文混用「（×n)」）。 */
const COUNT_RE = /\s*(?:（×(\d+)）|\(×(\d+)\))\s*$/

/** 菜单/状态文案里的短名。开关本身由 tg-bridge 从**本 Bot 的状态文件**读写。 */
export const titleMergeModeShortLabel = (mode: TitleMergeMode): string =>
  mode === "on" ? "开" : "关"

/** 去掉末尾的 `（×n）` / `(×n)`（没有则原样返回，并去掉尾随空白）。 */
export const stripTitleMergeCount = (text: unknown): string =>
  String(text ?? "")
    .replace(COUNT_RE, "")
    .replace(/\s+$/, "")

/** 解析末尾累计次数；没有/非法 = 1（首条）。 */
export const titleMergeCount = (text: unknown): number => {
  const m = COUNT_RE.exec(String(text ?? ""))
  const n = Number(m?.[1] ?? m?.[2] ?? 0)
  return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1
}

/** 给标题追加 `（×n）`；n<=1 时不加（首条保持原样）。 */
export const withTitleMergeCount = (title: unknown, n: number): string => {
  const base = stripTitleMergeCount(title)
  const c = Math.floor(Number(n) || 0)
  return c > 1 ? `${base}（×${c}）` : base
}

/**
 * 仅标题卡片的「种类」= 标题第一段（第一个 ` · ` 之前）。
 *   `🧠 思考 · 12:00:00 · 会话` → `🧠 思考`
 *   `🔧 Bash 执行 · 开始 12:00:00` → `🔧 Bash 执行`
 * 非仅标题（有正文）返回 null：正文卡永不参与合并。
 */
export const titleOnlyKind = (text: unknown): string | null => {
  const m = TITLE_ONLY_RE.exec(String(text ?? ""))
  if (!m) return null
  const title = stripTitleMergeCount(m[1] ?? "").trim()
  if (!title) return null
  return title.split(" · ")[0]?.trim() || null
}
