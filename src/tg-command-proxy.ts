// R2717：出口代理命令（/proxy）从桥内上收。
// 状态/详情/换出口三种结果都由 exit-proxy 的只读视图拼装，桥只注入当前 Bot 标签、
// 时间格式与“结束本轮”动作。文案只阐述事件本身：
//   · 状态尾行保留“额度耗尽/代理失效 → 自动换出口（结束本轮）”这一条因果；
//   · 换出口回执不再重复“新 run 会重新挑出口”的解释。
// R2884：热切换模式下 /proxy next 先写 hot-switch.request（由 run-opencode.sh
// 轮换并只重启 OpenCode 进程），写失败仍回落到原来的“结束本轮”。
export type ProxyDeps = {
  botLabel: () => string
  readExitProxy: () => any
  exitProxyBrief: () => string[]
  exitProxyPanel: () => string[]
  exitProxySummary: () => string
  isExitProxyActive: () => boolean
  /** R2884: true when CI runs in hot-switch mode (restart process, not CI). */
  hotSwitchEnabled: () => boolean
  /** R2884: write the request consumed by run-opencode.sh; false = fall back. */
  requestHotSwitch: () => boolean
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
    hotSwitchEnabled,
    requestHotSwitch,
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
      const lines: string[] = [`🌐 出口代理 · bot=${sanitizeLog(botLabel())}`]
      // R2520：与菜单页/CI 通知同一组字段（出口方式/本地代理/出口 IP/直连 IP）。
      lines.push(...exitProxyBrief())
      lines.push(`生效中：${isExitProxyActive() ? "是" : "否（状态与进程环境不一致）"}`)
      if (st?.latency_s) lines.push(`探测时延：${st.latency_s}s`)
      if (st?.picked_at) lines.push(`挑选时间：${fmtIsoTime(st.picked_at)}`)
      lines.push("")
      if (hotSwitchEnabled()) {
        lines.push("额度耗尽/代理失效 → 热切换出口（只重启本 run 的 OpenCode，不重启 CI）")
        lines.push("/proxy next 热切换出口 · /proxy list 详情")
      } else {
        lines.push("额度耗尽/代理失效 → 自动换出口（结束本轮）")
        lines.push("/proxy next 换出口 · /proxy list 详情")
      }
      await reply(chatID, lines.join("\n"))
      return true
    }
    if (lower === "list") {
      await reply(chatID, `🌐 出口详情\n${exitProxyPanel().join("\n")}`)
      return true
    }
    if (lower === "next" || lower === "rotate" || lower === "switch") {
      // R2884: hot mode writes a request for run-opencode.sh (the only owner
      // that rotates) and kills this process; the supervisor restarts OpenCode
      // in the same CI run. If the request cannot be written (mode off, no
      // state dir, old CI script), keep the original end-round behavior.
      if (requestHotSwitch()) {
        await reply(chatID, `♻️ 正在热切换出口（不重启 CI）：\n${exitProxySummary()}`)
        endRunForNewExit()
        return true
      }
      await reply(chatID, `♻️ 正在结束本轮换出口：\n${exitProxySummary()}`)
      endRunForNewExit()
      return true
    }
    await reply(
      chatID,
      hotSwitchEnabled()
        ? "ℹ️ 用法：/proxy（状态） · /proxy list（详情） · /proxy next（热切换出口，不重启 CI）"
        : "ℹ️ 用法：/proxy（状态） · /proxy list（详情） · /proxy next（换出口，重启本轮）",
    )
    return true
  }

  return { run }
}
