// R2713：会话列表命令（/sessions /recents）从桥内上收。
// 原实现是 handleUpdateInner 里的 listSessions 闭包：刷新标题、判断前台/钉选/活跃、
// 生成序号按钮、记录待选序号全混在一起。现在把纯渲染与选择登记集中到本模块，
// 桥只注入实时缓存/活动表/当前目标；列表文案按“只阐述事件/消息本身”收敛。
export type SessionRow = { id: string; title?: string; outcome?: string; idle?: number; model?: string }
export type SessionPendingSelection = { gen: number; ids: string[]; ts: number }

export type SessionListDeps = {
  /** 刷新宿主会话列表（返回是否成功；失败时保留上一份好列表）。 */
  refreshTitles: () => Promise<boolean>
  /** 清空“最近一次前台覆盖”，与桥的 activeFront 语义保持一致。 */
  resetFrontOverride: () => void
  /** 实时会话缓存（桥的 cachedSessionList）。 */
  sessions: () => readonly SessionRow[]
  /** 当前钉选目标。 */
  fixedTarget: () => string | undefined
  /** 当前前台会话（无则空串）。 */
  activeFront: () => Promise<string>
  /** 递增序号代际，防止旧列表的直选串到新列表。 */
  nextSelectGen: () => number
  /** 会话最近活动时间（桥的 lastActivity）。 */
  lastActivity: Map<string, number>
  activeWindowMs: number
  setPendingSelect: (chatID: string, value: SessionPendingSelection) => void
  clean: (s: unknown, n: number) => string
  now: () => number
}

export type SessionListRunArgs = {
  chatID: string
  text: string
  /** 已归一（小写、去 @suffix）的命令名。 */
  cmd: string
  reply: (chatID: string, text: string, kb?: unknown) => Promise<void>
}

export const createSessionListCommands = (deps: SessionListDeps) => {
  const { refreshTitles, resetFrontOverride, sessions, fixedTarget, activeFront, nextSelectGen, lastActivity, activeWindowMs, setPendingSelect, clean, now } = deps

  const build = async (chatID: string, limit: number): Promise<{ text: string; kb?: unknown }> => {
    await refreshTitles()
    resetFrontOverride()
    const all = sessions()
    const shown = all.slice(0, Math.max(1, limit))
    const lines: string[] = ["📚 会话列表"]
    if (shown.length === 0) {
      lines.push("（暂无会话）")
      return { text: lines.join("\n") }
    }
    lines.push(`── 共 ${all.length} 个${shown.length < all.length ? `（列前 ${shown.length}）` : ""} ──`)
    const pinnedID = fixedTarget()
    const shownFront = pinnedID ?? (await activeFront())
    const kb: unknown[][] = []
    const myGen = nextSelectGen()
    const flatBtns: unknown[][] = []
    shown.forEach((s, i) => {
      const isActive = now() - (lastActivity.get(s.id) ?? 0) < activeWindowMs
      const mark = s.id === shownFront ? " ⭐前台" : isActive ? " ◎活跃" : ""
      const pin = s.id === pinnedID ? " 📌固定" : ""
      const nm = clean(String(s.title ?? ""), 40) || "(无标题)"
      lines.push(`${i + 1}. ${nm} (${s.id.slice(0, 12)})${mark}${pin}`)
      if (flatBtns.length < 20) flatBtns.push([{ text: `切换 ${i + 1}`, callback_data: `use:${s.id}` }])
    })
    for (let r = 0; r < flatBtns.length; r += 5) kb.push(flatBtns.slice(r, r + 5).flat())
    setPendingSelect(chatID, { gen: myGen, ids: shown.map((s) => s.id), ts: now() })
    return { text: lines.join("\n"), kb: kb.length > 0 ? kb : undefined }
  }

  const run = async ({ chatID, text, cmd, reply }: SessionListRunArgs): Promise<boolean> => {
    if (text === "/sessions" || cmd === "sessions") {
      const r = await build(chatID, 50)
      await reply(chatID, r.text, r.kb)
      return true
    }
    if (text === "/recents" || cmd === "recents") {
      const r = await build(chatID, 5)
      await reply(chatID, r.text, r.kb)
      return true
    }
    return false
  }

  return { run, build }
}
