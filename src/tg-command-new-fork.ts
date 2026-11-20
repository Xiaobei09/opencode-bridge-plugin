// R2724：/new 与 /fork 从桥内上收 —— 建会话、继承模型、切换目标、继承循环范围。
// 宿主创建/fork 通路、前台切换、循环名单读写与回执全部注入，
// 模块只保留命令参数与文案规则，不直接读桥内状态。
export type NewForkDeps = {
  /** 当前目标会话（钉选优先，否则前台）。 */
  target: () => Promise<string | undefined>
  /** /new 继承模型时的来源：钉选 → 持久前台 → 内存前台 → 活跃会话。 */
  inheritFrom: () => Promise<string | undefined>
  /** 宿主 createSession；null = 兼容层过旧。 */
  createSession: ((opts: { title?: string }) => Promise<any>) | null
  inheritModel: (nid: string, src: string) => Promise<unknown>
  forkSessionByID: (sid: string, before?: string) => Promise<{ nid: string; failure: string }>
  /** 与 /use 同一切换语义：钉选 + 持久前台 + 内存前台 + 落盘。 */
  switchTarget: (sid: string) => void
  loopLists: () => { list: string[]; off: string[] }
  appendLoopSession: (sid: string) => string
  clean: (s: unknown, n: number) => string
  sanitizeLog: (s: unknown) => string
  log: (level: "info" | "warn" | "error", msg: string) => Promise<unknown> | unknown
  commandArg: (text: string) => string
  reply: (chatID: string, text: string, kb?: unknown) => Promise<void>
}

export type NewForkRunArgs = {
  chatID: string
  text: string
  /** 已归一（小写、去 @suffix、别名已展开）的命令名。 */
  cmd: string
}

const MSG_ID_RE = /^msg_[A-Za-z0-9]+$/

export const createNewForkCommands = (deps: NewForkDeps) => {
  const {
    target: currentTarget,
    inheritFrom,
    createSession,
    inheritModel,
    forkSessionByID,
    switchTarget,
    loopLists,
    appendLoopSession,
    clean,
    sanitizeLog,
    log,
    commandArg,
    reply,
  } = deps

  const runNew = async (chatID: string, text: string): Promise<void> => {
    const title = commandArg(text)
    if (!createSession) {
      await reply(chatID, "➕ 兼容层过旧，无法新建会话")
      return
    }
    try {
      const r = await createSession(title ? { title } : {})
      const nid = String(r?.id ?? r?.sessionID ?? r?.data?.id ?? "")
      if (!nid) {
        await reply(chatID, "❌ 新建失败：宿主未返回会话 ID")
        return
      }
      // R2658：新会话沿用当前会话的模型/思考档位（而不是让宿主回落全局默认）。
      const src = await inheritFrom()
      if (src) await inheritModel(nid, src)
      // R2645：创建后给一个一键切换按钮（菜单按钮点完也能直接进新会话），
      // 不再要求用户自己记住 id 再敲 /use。
      await reply(
        chatID,
        `➕ 已新建 ${nid.slice(0, 12)}${title ? `（${clean(title, 30)}）` : ""}`,
        [[{ text: `切换到 ${nid.slice(0, 12)}`, callback_data: `use:${nid}` }]],
      )
    } catch (err) {
      await reply(chatID, `➕ 新建失败：${sanitizeLog(err).slice(0, 200)}`)
    }
  }

  const runFork = async (chatID: string, text: string): Promise<void> => {
    // 复制当前会话的历史到新会话，并切过去继续。OpenCode 的 fork 边界是
    // 「before 消息」：不传 = 复制完整历史；传 msg_… = 只复制该消息之前的历史。
    // R2634：宿主通路抽到 forkSessionByID()，与 429→200 自动 fork 共用同一实现。
    const target = await currentTarget()
    if (!target) {
      await reply(chatID, "🧬 没有可 Fork 的会话")
      return
    }
    const arg = commandArg(text).trim()
    let before: string | undefined
    if (arg) {
      if (MSG_ID_RE.test(arg)) before = arg
      else {
        await reply(chatID, "用法：/fork [消息ID]（空=复制完整历史；消息ID 形如 msg_…）")
        return
      }
    }
    const { nid, failure } = await forkSessionByID(target, before)
    if (!nid) {
      await reply(chatID, `🧬 Fork 失败：${failure || "宿主未返回会话 ID"}`)
      return
    }
    // 与 /use 同一切换语义：钉选 + 写持久前台 + 同步内存前台，避免
    // 停循环推送闸门仍按旧 frontSessionID 把新会话当后台静默拦掉。
    switchTarget(nid)
    // 旧会话在循环里时，新 fork 继续被自动继续；否则只切目标，不改循环范围。
    const { list, off } = loopLists()
    if (list.includes(target) && !off.includes(nid) && !list.includes(nid)) {
      const e2 = appendLoopSession(nid)
      if (e2) await log("warn", `fork inherit loop write failed: ${e2}`)
      else await log("info", `fork inherit loop scope ${target.slice(0, 12)} -> ${nid.slice(0, 12)}`)
    }
    await reply(
      chatID,
      `🧬 已 fork：${target.slice(0, 12)} → ${nid.slice(0, 12)}${before ? `（复制 ${before.slice(0, 12)} 之前的历史）` : "（完整历史）"}\n已切换到这个新会话。`,
      [[{ text: "↩️ 回到原会话", callback_data: `use:${target}` }]],
    )
    await log("info", `fork ${target.slice(0, 12)} -> ${nid.slice(0, 12)}${before ? ` before=${before.slice(0, 12)}` : ""}`)
  }

  const run = async ({ chatID, text, cmd }: NewForkRunArgs): Promise<boolean> => {
    if (text === "/new" || text.startsWith("/new ") || cmd === "new") {
      await runNew(chatID, text)
      return true
    }
    if (text === "/fork" || text.startsWith("/fork ") || cmd === "fork") {
      await runFork(chatID, text)
      return true
    }
    return false
  }

  return { run }
}
