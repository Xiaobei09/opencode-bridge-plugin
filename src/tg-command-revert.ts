// R2709：`/revert` 会话回退命令从 tg-bridge 上收。
// 宿主提供三段式 API：POST /revert/stage（暂存边界）、DELETE /revert（撤销）、
// POST /revert/commit（定稿删除）。此前这套语义、错误映射、序号/前缀解析与
// 文案都埋在桥的巨型命令分支里，只能靠字符串断言。
// 现在集中为一个可注入 HTTP 的模块：桥只解析目标会话并转发回复，回归可用假实现覆盖。
export type RevertHttpResult = { ok: boolean; status: number; body: any }
export type RevertHttp = (path: string, init?: RequestInit) => Promise<RevertHttpResult>

export type RevertDeps = {
  /** 宿主 HttpApi 往返（桥注入带 15s 超时的实现）。 */
  modelHttp: RevertHttp
  /** 时间格式（桥解析 TG_TZ 后注入，单一真源）。 */
  fmtTime: (ms: number) => string
  /** 单行截断（stripLogControls + 压缩空白 + safeCut）。 */
  clean: (s: unknown, n: number) => string
  /** UTF-16 安全截断。 */
  safeCut: (s: string, n: number) => string
  sanitizeLog: (s: unknown) => string
  log: (level: string, msg: string) => Promise<void>
  /** 全局/本 Bot 循环闸是否停着（决定暂存提示是否警告会立即定稿）。 */
  loopStopped: () => boolean
  readIdList: (path: string) => string[]
  loopSessionsFile: string
  /** 命令参数切片（tg-commands 的单一实现）。 */
  commandArg: (text: string) => string
}

export type RevertRunArgs = {
  chatID: string
  text: string
  /** 目标会话：钉选优先，否则前台；空值表示没有可回退会话。 */
  resolveTarget: () => Promise<string | null | undefined>
  /** 桥的回复出口（支持内联键盘）。 */
  reply: (chatID: string, text: string, kb?: unknown) => Promise<void>
}

export const createRevertCommand = (deps: RevertDeps) => {
  const { modelHttp, fmtTime, clean, safeCut, sanitizeLog, log, loopStopped, readIdList, loopSessionsFile, commandArg } = deps

  const run = async ({ chatID, text, resolveTarget, reply }: RevertRunArgs): Promise<void> => {
    // R2633（运营者："有没有办法在会话中回退到某次输入"）：把会话回退到某条输入之前。
    // 宿主在收到下一条 prompt 时会自动 commit；所以暂存后不反悔就发新消息 = 正式回退。
    const target = await resolveTarget()
    if (!target) {
      await reply(chatID, "↩️ 没有可回退的会话")
      return
    }
    const base = `/api/session/${encodeURIComponent(target)}`
    const rest = commandArg(text).trim()
    const parts = rest ? rest.split(/\s+/) : []
    const sel = String(parts[0] ?? "").toLowerCase()
    const opt = String(parts[1] ?? "").toLowerCase()
    const errText = (r: { status: number; body: any }, fallback: string): string => {
      const b = (r.body && typeof r.body === "object" ? (r.body as any) : null) ?? {}
      const msg = String(b.message ?? b.detail ?? b._tag ?? "").trim()
      if (r.status === 409 || /SessionBusy/i.test(String(b._tag ?? ""))) return "会话正在运行：先 /stop（或等本轮结束）再回退"
      if (r.status === 404) return "没找到该消息（可能已被删除，或已经回退过）"
      return `${fallback}（HTTP ${r.status}${msg ? `: ${safeCut(msg, 160)}` : ""}）`
    }
    const listUsers = async (): Promise<{ ok: boolean; items: any[]; status: number; body: any }> => {
      const r = await modelHttp(`${base}/message?limit=50&order=desc&type=user`)
      const items = Array.isArray((r.body as any)?.data) ? ((r.body as any).data as any[]) : []
      return { ok: r.ok, items, status: r.status, body: r.body }
    }
    const snippetOf = (m: any): string =>
      clean(String(m?.text ?? "").replace(/^\s*\[TG user message\]\s*/i, "").replace(/\s+/g, " "), 60) || "(无文本)"
    // 无参数 / list：列出最近输入；带上当前暂存状态。
    if (!rest || sel === "list" || sel === "ls") {
      const lr = await listUsers()
      if (!lr.ok) {
        await reply(chatID, `读取会话输入失败：${errText({ status: lr.status, body: lr.body }, "读取列表")}`)
        return
      }
      const staged = ((await modelHttp(base)).body as any)?.data?.revert?.messageID as string | undefined
      const lines = [`↩️ 可回退的最近输入（1 = 最新，会话 ${target.slice(0, 12)}）`]
      if (lr.items.length === 0) lines.push("（没有可回退的用户输入）")
      lr.items.slice(0, 10).forEach((m: any, i: number) => {
        lines.push(`${i + 1}. ${fmtTime(m?.time?.created) || "?"} ${snippetOf(m)} (${String(m?.id ?? "").slice(0, 12)})`)
      })
      if (staged) lines.push(`\n⏳ 当前已暂存回退：${String(staged).slice(0, 12)}（/revert undo 撤销，/revert commit 定稿）`)
      lines.push(
        "\n用法：/revert <序号|msg_…> [nofiles]",
        "· 默认同时把该输入之后的文件改动还原到当时快照；加 nofiles 只回退对话",
        "· 暂存后：/revert undo 反悔；/revert commit 立即永久删除；发下一条消息也会自动定稿",
        "· 会话在自动循环中时，下一轮自动继续会立即定稿；想先改输入请先 /loop stop",
      )
      await reply(chatID, lines.join("\n"))
      return
    }
    if (sel === "undo" || sel === "clear" || sel === "redo") {
      const curRes = await modelHttp(base)
      const cur = (curRes.body as any)?.data?.revert?.messageID
      if (curRes.ok && !cur) {
        await reply(chatID, "当前没有暂存中的回退。")
        return
      }
      const r = await modelHttp(`${base}/revert`, { method: "DELETE" })
      await reply(
        chatID,
        r.ok
          ? "↩️ 已撤销暂存回退；之前还原过的文件也已恢复到回退前状态。"
          : `撤销回退失败：${errText(r, "撤销")}`,
      )
      if (r.ok) await log("info", `revert cleared sid=${sanitizeLog(target).slice(0, 12)}`)
      return
    }
    if (sel === "commit") {
      const curRes = await modelHttp(base)
      const cur = (curRes.body as any)?.data?.revert?.messageID
      if (curRes.ok && !cur) {
        await reply(chatID, "当前没有暂存中的回退；不需要定稿。")
        return
      }
      const r = await modelHttp(`${base}/revert/commit`, { method: "POST" })
      await reply(
        chatID,
        r.ok
          ? "🧹 已定稿：回退边界及其后的消息已永久删除。"
          : `定稿回退失败：${errText(r, "定稿")}`,
      )
      if (r.ok) await log("info", `revert committed sid=${sanitizeLog(target).slice(0, 12)}`)
      return
    }
    // 解析目标消息：序号（1=最新）或 msg_ ID / 唯一前缀。
    const lr = await listUsers()
    let chosen: any = null
    if (/^\d+$/.test(sel)) {
      const idx = Number(sel)
      if (!lr.ok || idx < 1 || idx > lr.items.length) {
        await reply(chatID, `序号超出范围：当前只列出最近 ${lr.items.length} 条用户输入（/revert 查看）`)
        return
      }
      chosen = lr.items[idx - 1]
    } else if (/^msg_[A-Za-z0-9]+$/.test(sel)) {
      chosen = lr.items.find((m: any) => String(m?.id) === sel) ?? lr.items.find((m: any) => String(m?.id).startsWith(sel)) ?? null
      // 列表只取最近 50 条输入；完整 msg_ ID 可能更老。找不到也交给宿主校验（404 会给出明确回复）。
    } else {
      await reply(chatID, "用法：/revert <序号|msg_…> [nofiles]；或 /revert undo | commit | list")
      return
    }
    const messageID = String(chosen?.id ?? sel)
    const nofiles = /^(nofiles|nofile|nof|conv|chat|text)$/.test(opt)
    const body: Record<string, unknown> = { messageID }
    if (nofiles) body.files = false
    const r = await modelHttp(`${base}/revert/stage`, { method: "POST", body: JSON.stringify(body) })
    if (!r.ok) {
      await reply(chatID, `回退失败：${errText(r, "暂存")}`)
      await log("warn", `revert stage failed sid=${sanitizeLog(target).slice(0, 12)} msg=${sanitizeLog(messageID).slice(0, 14)} status=${r.status}`)
      return
    }
    const rev = ((r.body as any)?.data ?? r.body) as any
    const fl: any[] = Array.isArray(rev?.files) ? rev.files : []
    const names = fl.map((f: any) => clean(String(f?.path ?? f?.file ?? ""), 40)).filter(Boolean)
    const fileLine = nofiles
      ? "文件：未改动（nofiles）"
      : names.length > 0
        ? `文件：已还原 ${names.length} 个（${names.slice(0, 5).join("、")}${names.length > 5 ? " …" : ""}）`
        : "文件：无改动需要还原"
    const inLoop = !loopStopped() && readIdList(loopSessionsFile).includes(target)
    await reply(
      chatID,
      `↩️ 已暂存回退 → ${chosen ? snippetOf(chosen) : messageID.slice(0, 12)} (${messageID.slice(0, 12)})\n` +
        `${fileLine}\n` +
        "⚠️ 下一条消息会定稿并永久删除该输入及其后内容；反悔点「撤销回退」或 /revert undo。" +
        (inLoop ? "\n（会话在自动循环中：下一轮会立即定稿；想先改输入请 /loop stop）" : ""),
      [[{ text: "↩️ 撤销回退", callback_data: "ma:revertundo" }, { text: "🧹 定稿删除", callback_data: "ma:revertcommit" }]],
    )
    await log("info", `revert staged sid=${sanitizeLog(target).slice(0, 12)} boundary=${sanitizeLog(messageID).slice(0, 14)} files=${nofiles ? "keep" : String(names.length)}`)
  }

  return { run }
}
