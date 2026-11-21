// R2718：配置清单命令（/config）从桥内上收。
// 只读视图：本 Bot 状态、循环/守卫、出口代理、Bot 注册表。桥注入实时 getter，
// 状态文件读取统一走 state-io.readLoopCtl（主路径 + /tmp 旧路径回落），
// 不再在命令分支里复制一份 JSON 读取。
export type ConfigDeps = {
  botId: string
  botLabel: () => string
  version: string
  statePath: string
  target: () => string | undefined
  sessionTag: (sid: string) => string
  selfMute: () => boolean
  pausedMode: () => boolean
  titleMergeOn: () => boolean
  pinQueueLen: () => number
  /** R2815：停前挂起条数（/loop stop 前入队、/loop start 后恢复）；不传按 0。 */
  pinHeldLen?: () => number
  outQueueLen: () => number
  readGuard: () => { problem?: boolean; websearch?: boolean }
  readBg: () => { enabled?: boolean; shellPromo?: boolean; promoteMs: number }
  readLoopCtl: () => any
  /** null = 读取失败；空数组 = 文件里没有 bots。 */
  readBots: () => Array<{ id?: unknown }> | null
  readInvalidBots: () => Array<{ id: string; desc: string }>
  invalidBotReasonLabel: (desc: string) => string
  botDisplayName: (id: string) => string
  readLoopInjectMode: () => any
  loopInjectModeShortLabel: (m: any) => string
  readQuotaRecover: () => { mode?: string }
  exitProxyBrief: () => string[]
  isExitProxyActive: () => boolean
  readExitProxy: () => any
  exitProxyStatePath: string
  fmtIsoTime: (iso: unknown) => string
  sanitizeLog: (s: unknown) => string
  reply: (chatID: string, text: string) => Promise<void>
}

export type ConfigRunArgs = {
  chatID: string
  text: string
  /** 已归一（小写、去 @suffix）的命令名。 */
  cmd: string
}

export const createConfigCommands = (deps: ConfigDeps) => {
  const {
    botId,
    botLabel,
    version,
    statePath,
    target,
    sessionTag,
    selfMute,
    pausedMode,
    titleMergeOn,
    pinQueueLen,
    pinHeldLen,
    outQueueLen,
    readGuard,
    readBg,
    readLoopCtl,
    readBots,
    readInvalidBots,
    invalidBotReasonLabel,
    botDisplayName,
    readLoopInjectMode,
    loopInjectModeShortLabel,
    readQuotaRecover,
    exitProxyBrief,
    isExitProxyActive,
    readExitProxy,
    exitProxyStatePath,
    fmtIsoTime,
    sanitizeLog,
    reply,
  } = deps

  const run = async ({ chatID, text, cmd }: ConfigRunArgs): Promise<boolean> => {
    if (!(text === "/config" || text.startsWith("/config ") || cmd === "config")) return false

    const t = target()
    const guard = readGuard()
    const bg = readBg()
    // 全局闸 + 各 Bot 闸（读共享 loop-ctl.json）
    const ctl = readLoopCtl()
    const globalStopped = ctl?.stopped === true
    const myGate = (ctl?.bots ?? {})[botId]?.stopped === true
    // Bot 注册表
    const invalidDetails = new Map(readInvalidBots().map((b) => [b.id, b.desc]))
    const invalidBots = new Set(invalidDetails.keys())
    const bots = readBots()
    const botRows: string[] = !bots
      ? ["· （读取 tg-bots.json 失败）"]
      : bots.map((b) => {
          const id = String(b?.id ?? "?")
          const gate = (ctl?.bots ?? {})[id]?.stopped === true ? "停" : "运行"
          const me = id === botId ? "（本 Bot）" : ""
          const bad = invalidBots.has(id) ? ` · ⛔离线（${invalidBotReasonLabel(invalidDetails.get(id) ?? "")}）` : ""
          // R921：label 本身已带 @；旧代码再拼一个 @ 会显示成 @@username。
          return `· ${botDisplayName(id)}${me} 循环=${gate}${bad}`
        })
    const lines: string[] = [`🧾 配置 · bot=${sanitizeLog(botLabel())} · v${version}`]
    lines.push("")
    lines.push("【本 Bot】")
    lines.push(`· 目标会话：${t ? `${sessionTag(t)} (${t.slice(0, 12)})` : "（未确定）"}`)
    lines.push(`· 状态文件：${statePath}`)
    lines.push(`· 应答模式：${selfMute() ? "只答命令" : "正常应答"} · 推送暂停：${pausedMode() ? "是" : "否"}`)
    lines.push(`· 标题合并：${titleMergeOn() ? "开" : "关"}（本 Bot 独立）`)
    lines.push("")
    lines.push("【循环 / 守卫】")
    lines.push(`· 全局闸：${globalStopped ? `已停${ctl?.by ? `（by=${String(ctl.by)}）` : ""}` : "运行"}`)
    // R2815：注入队列只报可注入条数；停前挂起单独标注，避免把永不注入的条目算进去。
    const pinHeld = pinHeldLen ? pinHeldLen() : 0
    lines.push(
      `· 本 Bot 闸：${myGate ? "已停" : "运行"} · 注入队列：${pinQueueLen()}${pinHeld > 0 ? `（停前挂起 ${pinHeld}）` : ""} · 外发队列：${outQueueLen()}`,
    )
    lines.push(`· 守卫：问题=${guard.problem !== false ? "开" : "关"} · 联网搜索=${guard.websearch !== false ? "开" : "关"}（本 Bot 独立）`)
    lines.push(`· 续跑文案：${loopInjectModeShortLabel(readLoopInjectMode())}（全局，三个 Bot 共用）`)
    lines.push(`· 额度续跑：${readQuotaRecover().mode === "off" ? "关闭" : "自动"}（全局，跨 CI）`)
    lines.push(`· 后台：自动转后台=${bg.enabled ? "开" : "关"} · shell 自动后台=${bg.shellPromo !== false ? "开" : "关"} · 阈值=${Math.round(bg.promoteMs / 1000)}s（全局，宿主级）`)
    lines.push("")
    lines.push("【代理】")
    // R2520：统一字段，避免 /config 与 /proxy、CI 通知各用一套说法。
    for (const l of exitProxyBrief()) lines.push(`· ${l}`)
    lines.push(`· 生效中：${isExitProxyActive() ? "是" : "否"}`)
    const ep = readExitProxy()
    if (ep?.latency_s) lines.push(`· 时延：${ep.latency_s}s · 挑选：${fmtIsoTime(ep.picked_at) || "?"}`)
    lines.push(`· 状态文件：${exitProxyStatePath}`)
    lines.push("")
    lines.push("【Bot 注册表】")
    lines.push(...botRows)
    if (invalidBots.size > 0) {
      lines.push(`· 离线：${[...invalidBots].join(", ")}（token 被拒可用 /addbots 换新 token；标「同号」的 Bot 与在线 Bot 是同一个 Telegram 账号，只能保留一个）`)
    }
    await reply(chatID, lines.join("\n"))
    return true
  }

  return { run }
}
