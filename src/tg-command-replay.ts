// R2723：会话回放命令（/replay /reload）从桥内上收。
// 只负责“取最近 N 条 + 按协议重发”；目标解析、取尾、推送与回执全部注入，
// 模块不读桥内状态，也不关心压缩摘要那类专用卡片。
export type ReplayDeps = {
  /** 当前目标会话（钉选优先，否则前台）。 */
  target: () => Promise<string | undefined>
  fetchTail: (sid: string, n: number) => Promise<any[] | null>
  pushMessage: (sid: string, chatID: string, m: any) => Promise<void>
  commandArg: (text: string) => string
  reply: (chatID: string, text: string) => Promise<void>
}

export type ReplayRunArgs = {
  chatID: string
  text: string
  /** 已归一（小写、去 @suffix、别名已展开）的命令名。 */
  cmd: string
}

const N_MAX = 200

export const createReplayCommands = (deps: ReplayDeps) => {
  const { target: currentTarget, fetchTail, pushMessage, commandArg, reply } = deps

  const run = async ({ chatID, text, cmd }: ReplayRunArgs): Promise<boolean> => {
    if (
      !(
        text === "/replay" ||
        text.startsWith("/replay ") ||
        text === "/reload" ||
        text.startsWith("/reload ") ||
        cmd === "replay" ||
        cmd === "reload"
      )
    ) {
      return false
    }
    const target = await currentTarget()
    if (!target) {
      await reply(chatID, "🔁 没有可重发的会话")
      return true
    }
    const argText = commandArg(text)
    // 明说 all 才取上限；纯数字按用户要求但封顶 200，避免一次刷屏。
    const nMax = (t: string): number => (/^\d+$/.test(t) ? Math.min(Number(t), N_MAX) : 0)
    const all = argText === "all" || argText === "everything"
    const n = all ? N_MAX : nMax(argText) || 5
    const msgs = await fetchTail(target, n)
    if (!msgs) {
      await reply(chatID, `📋 会话 ${target.slice(0, 12)} 没有消息`)
      return true
    }
    for (const m of msgs) await pushMessage(target, String(chatID), m)
    const note = `加载最近 ${all ? "全部" : n} 条消息`
    await reply(chatID, `${note} → ${target.slice(0, 12)}（协议分条，未推进标记）`)
    return true
  }

  return { run }
}
