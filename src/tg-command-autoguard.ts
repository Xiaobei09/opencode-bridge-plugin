// R2720：自动停止守卫命令（/autoguard）从桥内上收。
// 开关语义与解析都在 loop-guard（parseGuardArg 同时服务菜单按钮）；桥只注入
// 本 Bot 的读写视图、最近触发记录与时间格式。
export type AutoguardDeps = {
  botId: string
  botLabel: () => string
  readGuard: () => { problem?: boolean; websearch?: boolean }
  readLastTrip: () => { at?: unknown; kind?: unknown; reason?: unknown; sid?: unknown } | null
  writeGuard: (cfg: { problem?: boolean; websearch?: boolean }) => void
  parseGuardArg: (arg: string, cur: any) => any
  fmtTime: (ms: number) => string
  sanitizeLog: (s: unknown) => string
  commandArg: (text: string) => string
  reply: (chatID: string, text: string) => Promise<void>
}

export type AutoguardRunArgs = {
  chatID: string
  text: string
  /** 已归一（小写、去 @suffix）的命令名。 */
  cmd: string
}

export const createAutoguardCommands = (deps: AutoguardDeps) => {
  const { botId, botLabel, readGuard, readLastTrip, writeGuard, parseGuardArg, fmtTime, sanitizeLog, commandArg, reply } = deps

  const run = async ({ chatID, text, cmd }: AutoguardRunArgs): Promise<boolean> => {
    if (!(text === "/autoguard" || text.startsWith("/autoguard ") || cmd === "autoguard")) return false

    // 自动停止守卫的开关/状态（用户 2026-09-28 新增，菜单「🔁 循环」里也有两枚按钮）。
    // 语义：problem = 助手宣告 [SIGNAL:PROBLEM] 或本轮 [STATUS: STOP] 时停循环；
    //       websearch = 助手请求网页搜索或真调了搜索工具时停循环（等用户授权）。
    const arg = commandArg(text).toLowerCase()
    const cur = readGuard()
    const onoff = (w: unknown): string => (w ? "开" : "关")
    const show = (): string => {
      const c = readGuard()
      const trip = readLastTrip()
      const t = trip?.at
        ? `\n· 最近触发：${String(trip.kind ?? "?")}｜${String(trip.reason ?? "").slice(0, 100)}（${fmtTime(Number(trip.at)) || "?"} 会话 ${String(trip.sid ?? "?").slice(0, 12)}）`
        : "\n· 最近触发：无"
      return `自动停止守卫（本 Bot=${sanitizeLog(botLabel())} 独立）：问题即停=${onoff(c.problem)}｜搜索即停=${onoff(c.websearch)}${t}\n` +
        "· 触发后只停本 Bot 的循环，等你处理；恢复用 /loop start（菜单「继续循环」）\n" +
        "· 开关只影响本 Bot；其它 Bot 保持各自设置\n" +
        "· 改开关：/autoguard on|off（全部）、/autoguard problem on|off、/autoguard web on|off"
    }
    // 解析交给共享纯函数（loop-guard.ts）：菜单按钮投送的正是「头 + 值」三段式，
    // 这条路径必须能被单测覆盖，不能只靠"看着对"。
    const act = parseGuardArg(arg, cur)
    if (act.kind === "status") {
      await reply(chatID, show())
      return true
    }
    if (act.kind === "help") {
      await reply(chatID, `用法：/autoguard [on|off|status] | problem on|off | web on|off\n${show()}`)
      return true
    }
    writeGuard(act.cfg)
    const changed = act.cfg.problem !== cur.problem || act.cfg.websearch !== cur.websearch
    const head = act.what === "all" ? "守卫" : act.what === "problem" ? "问题即停" : "搜索即停"
    // R2760（运营者「继续缩短」）：开关原来把 5 行状态+用法整段重印一遍；
    // 开关只需一行结果，完整状态仍由 /autoguard status（或菜单）提供。
    await reply(
      chatID,
      `🛑 ${head} → 问题=${onoff(act.cfg.problem)}｜搜索=${onoff(act.cfg.websearch)}${changed ? "" : "（无变化）"} · 本 Bot 独立`,
    )
    return true
  }

  return { run }
}
