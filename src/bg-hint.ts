/**
 * bg-hint：shell 提升到后台时在「原来消息」（执行中卡片）末尾追加的一行提示（R1607）。
 *
 * 用户指令（真实 TG）：「在shell提升到后台时，在原来消息末尾增加一行提示」。
 * bg-watch（_v2compat）对跑超阈值的 shell 调宿主 /background 转后台成功后，桥侧
 * 找到该会话当前仍在显示的 `:input` 卡片（runningAt>0），把这行提示追加到卡片末尾。
 *
 * 纯函数只负责「文案 + 追加 + 去重判定」，可单测；实际 TG 编辑在 tg-bridge.ts 的
 * noteShellPromoted（全局钩子 __oc_bg_promoted_hooks__ 收到通知后触发）。
 */

/** 追加的提示行（blockquote 与既有「⏳ 执行中…」样式一致）。 */
export const SHELL_BG_HINT_BLOCK = `<blockquote>⏫ 已转入后台执行（shell 超时自动转后台；完成后自动带回结果）</blockquote>`

/** 去重判定：正文已带 ⏫ 或「已转入后台」视为已提示，不再追加（promote 可能多次触发）。 */
export const hasShellBgHint = (text: string): boolean => {
  const t = String(text ?? "")
  return t.includes("⏫") || t.includes("已转入后台")
}

/**
 * 在卡片末尾追加提示行。
 * - base 为空 → 返回空（无可追加的卡片文本，不应凭空造一行）。
 * - 已含提示 → 原样返回（去重）。
 * - 否则在末尾接一行（base 结尾无换行时补两个换行隔开），不触碰正文内容。
 */
export const appendShellBgHint = (base: string): string => {
  const b = String(base ?? "")
  if (b.trim() === "") return ""
  if (hasShellBgHint(b)) return b
  // 换行归一化：保证提示块前有一个空行（blockquote 不与上一行正文粘连）。
  // "" / "abc" → 补 "\n\n"；"卡\n" → 补 "\n"；"…\n\n" → 不补。
  const sep = b.endsWith("\n\n") ? "" : b.endsWith("\n") ? "\n" : "\n\n"
  return `${b}${sep}${SHELL_BG_HINT_BLOCK}`
}

/** 提示只发给"正在被 promote 的那张卡"：被 bg-watch 盯上的 shell 一定是本进程最近几分钟内推的卡。
 *   R1609 实证：跨重载恢复出的历史卡（runningAt 为几天前）runningAt>0 会误命中 —— bot3 曾把提示
 *   追加到 3 天前的一条 Write 卡（msg=14）。runningAt 只在首次 running 事件置 Date.now()、看门狗只清 0
 *   不刷新，故按 runningAt 判新鲜度安全（bg-watch 计时仅注册于当前进程，跨重载的在途 shell 不会 promote）。 */
export const HINT_FRESH_MS_DEFAULT = 5 * 60_000

export const isFreshRunningCard = (
  rec: { runningAt?: number } | null | undefined,
  now: number = Date.now(),
  freshMs: number = HINT_FRESH_MS_DEFAULT,
): boolean => {
  const at = Number(rec?.runningAt ?? 0)
  if (!(at > 0)) return false
  const age = now - at
  return age >= 0 && age <= freshMs
}