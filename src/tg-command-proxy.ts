// R2717：出口代理命令（/proxy）从桥内上收。
// 状态/详情/换出口三种结果都由 exit-proxy 的只读视图拼装，桥只注入当前 Bot 标签、
// 时间格式与“结束本轮”动作。文案只阐述事件本身：
//   · 状态尾行保留“额度耗尽/代理失效 → 自动换出口（结束本轮）”这一条因果；
//   · 换出口回执不再重复“新 run 会重新挑出口”的解释。
export type ProxyDeps = {
  botLabel: () => string
  readExitProxy: () => any
  exitProxyBrief: () => string[]
  exitProxyPanel: () => string[]
  exitProxySummary: () => string
  isExitProxyActive: () => boolean
  endRunForNewExit: () => void
  fmtIsoTime: (iso: unknown) => string
  sanitizeLog: (s: unknown) => string
  commandArg: (text: string) => string
  reply: (chatID: string, text: string) => Promise<void>
}

export type ProxyRunArgs = {
  chatID: string
  text: string
  /** 已归一（小写、去 @suffix）的命令名。 */
  cmd: string
}

export const createProxyCommands = (deps: ProxyDeps) => {
  const {
    botLabel,
    readExitProxy,
    exitProxyBrief,
    exitProxyPanel,
    exitProxySummary,
    isExitProxyActive,
    endRunForNewExit,
    fmtIsoTime,
    sanitizeLog,
    commandArg,
    reply,
  } = deps

  const run = async ({ chatID, text, cmd }: ProxyRunArgs): Promise<boolean> => {
    if (!(text === "/proxy" || text.startsWith("/proxy ") || cmd === "proxy")) return false

    const arg = commandArg(text)
    const lower = arg.toLowerCase()
    if (!arg || lower === "status") {
      const st = readExitProxy()
      const lines: string[] = [`[tg-bridge] 🌐 出口代理 · bot=${sanitizeLog(botLabel())}`]
      // R2520：与菜单页/CI 通知同一组字段（出口方式/本地代理/出口 IP/直连 IP）。
      lines.push(...exitProxyBrief())
      lines.push(`生效中：${isExitProxyActive() ? "是" : "否（状态与进程环境不一致）"}`)
      if (st?.latency_s) lines.push(`探测时延：${st.latency_s}s`)
      if (st?.picked_at) lines.push(`挑选时间：${fmtIsoTime(st.picked_at)}`)
      lines.push("")
      lines.push("额度耗尽/代理失效 → 自动换出口（结束本轮）")
      lines.push("/proxy next 换出口 · /proxy list 详情")
      await reply(chatID, lines.join("\n"))
      return true
    }
    if (lower === "list") {
      await reply(chatID, `[tg-bridge] 🌐 出口详情\n${exitProxyPanel().join("\n")}`)
      return true
    }
    if (lower === "next" || lower === "rotate" || lower === "switch") {
      await reply(chatID, `[tg-bridge] ♻️ 正在结束本轮换出口：\n${exitProxySummary()}`)
      endRunForNewExit()
      return true
    }
    await reply(
      chatID,
      "[tg-bridge] ℹ️ 用法：/proxy（状态） · /proxy list（详情） · /proxy next（换出口，重启本轮）",
    )
    return true
  }

  return { run }
}
