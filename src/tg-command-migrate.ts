// R2725：/migrate 从桥内上收 —— 新会话 + 最近动态摘要，全程手机可走。
// 宿主创建、取尾、模型继承、摘要注入与自动化记账全部注入；
// 模块只负责摘要拼装、空内容/失败分支与回执文案。
export type MigrateDeps = {
  /** 当前目标会话（钉选优先，否则前台）。 */
  target: () => Promise<string | undefined>
  /** 宿主 createSession；null = 兼容层过旧。 */
  createSession: ((opts: { title?: string }) => Promise<any>) | null
  fetchTail: (sid: string, n: number) => Promise<any[] | null>
  partsOf: (m: any) => any[]
  inheritModel: (nid: string, src: string) => Promise<unknown>
  doPrompt: (sid: string, text: string, ctx: string) => Promise<string>
  automationStart: (kind: string, detail?: string) => Promise<void>
  automationEnd: (kind: string, ok: boolean, detail?: string) => Promise<void>
  sanitizeLog: (s: unknown) => string
  log: (level: "info" | "warn" | "error", msg: string) => Promise<unknown> | unknown
  reply: (chatID: string, text: string, kb?: unknown) => Promise<void>
}

export type MigrateRunArgs = {
  chatID: string
  text: string
  /** 已归一（小写、去 @suffix、别名已展开）的命令名。 */
  cmd: string
}

const TAIL_N = 40
const SUMMARY_BUDGET = 6000
const LINE_MAX = 200

export const createMigrateCommands = (deps: MigrateDeps) => {
  const {
    target: currentTarget,
    createSession,
    fetchTail,
    partsOf,
    inheritModel,
    doPrompt,
    automationStart,
    automationEnd,
    sanitizeLog,
    log,
    reply,
  } = deps

  const run = async ({ chatID, text, cmd }: MigrateRunArgs): Promise<boolean> => {
    if (!(text === "/migrate" || cmd === "migrate")) return false
    // /compact 之外的保底迁移：新会话 + 最近动态摘要，全程手机可走
    const target = await currentTarget()
    if (!target) {
      await reply(chatID, "📦 没有可迁移的会话")
      return true
    }
    if (!createSession) {
      await reply(chatID, "📦 兼容层过旧，无法迁移")
      return true
    }
    await automationStart("migrate", `旧会话：${target.slice(0, 12)}`)
    let tail: any[] | null = null
    try {
      tail = await fetchTail(target, TAIL_N)
    } catch {
      tail = null
    }
    const lines: string[] = []
    for (const m of tail ?? []) {
      const info = (m as any)?.info ?? {}
      const role = info?.role === "user" ? "用户" : info?.role === "assistant" ? "助手" : "系统"
      const txt = partsOf(m)
        .filter((p: any) => p?.type === "text")
        .map((p: any) => String(p?.text ?? ""))
        .join("")
        .trim()
        .replace(/\s+/g, " ")
      if (!txt) continue
      lines.push(`【${role}】${txt.slice(0, LINE_MAX)}`)
      if (lines.join("\n").length > SUMMARY_BUDGET) break
    }
    if (lines.length === 0) {
      await automationEnd("migrate", false, "无可迁移内容（最近消息为空）")
      await reply(chatID, "📦 无可迁移内容（最近消息为空）")
      return true
    }
    try {
      const r = await createSession({ title: `迁移-${target.slice(0, 8)}` })
      const nid = String(r?.id ?? r?.sessionID ?? r?.data?.id ?? "")
      if (!nid) {
        await automationEnd("migrate", false, "宿主未返回新会话 ID")
        await reply(chatID, "❌ 新建失败：宿主未返回会话 ID")
        return true
      }
      // R2658：迁移后沿用旧会话的模型/思考档位。
      await inheritModel(nid, target)
      const perr = await doPrompt(nid, `【会话迁移】以下为旧会话 ${target.slice(0, 12)} 最近动态摘要，新会话延续工作：\n${lines.join("\n")}`, "")
      if (perr) {
        await automationEnd("migrate", false, `摘要注入失败：${perr}`)
        await reply(chatID, `📦 新会话已建，但摘要注入失败：${perr}`)
        return true
      }
      await automationEnd("migrate", true, `${lines.length} 条摘要 → ${nid.slice(0, 12)}`)
      await reply(
        chatID,
        `✅ 已迁移到新会话 ${nid.slice(0, 12)}（${lines.length} 条摘要），点按钮切换：`,
        [[{ text: `切换 ${nid.slice(0, 12)}`, callback_data: `use:${nid}` }]],
      )
      await log("info", `migrate ${target.slice(0, 12)} -> ${nid.slice(0, 12)} (${lines.length} lines)`)
    } catch (err) {
      await automationEnd("migrate", false, sanitizeLog(err).slice(0, 160))
      await reply(chatID, `📦 迁移失败：${sanitizeLog(err).slice(0, 200)}`)
    }
    return true
  }

  return { run }
}
