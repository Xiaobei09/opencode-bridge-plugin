// R2712：推送/队列命令（/queue /pause /resume /flush /drop /dropq /inject）从桥内上收。
// 这组命令此前散在 tg-bridge 的巨型命令分支里：暂停标志、注入模式、外发/注入队列
// 与占位条删除各写一遍，只能靠源码字符串断言。现在集中为一个可注入队列与保存动作的
// 模块：桥只注入实时数组/函数，命令文案与顺序保持原样。
export type PushPinItem = { sid: string; text: string; ts: number }
export type PushOutItem = { chat: string; text: string; ts: number }

export type PushCommandDeps = {
  /** 推送暂停开关（桥持有模块级变量，必须现写）。 */
  setPaused: (v: boolean) => void
  /** 当前注入模式（now=立即 / idle=回合后）。 */
  injectMode: () => "now" | "idle"
  setInjectMode: (v: "now" | "idle") => void
  /** 持久化（桥的 savePersistedState）。 */
  saveState: () => void
  /** 实时队列数组：命令会读取长度并在 /drop、/dropq 就地清空。 */
  pinQueue: PushPinItem[]
  outQueue: PushOutItem[]
  /** 强发外发队列（桥的 flushQueue）。 */
  flushQueue: () => Promise<void>
  /** 继续注入指定会话（桥的 pumpInject；调用方约定不等待）。 */
  pumpInject: (sid: string) => void
  /** 外发占位条（chat -> message id）；/drop 会逐条删除并清空。 */
  listPlaceholder: Map<string, number>
  /** 尽力删除一条 Telegram 消息（桥注入，内部已兜错）。 */
  deleteMessage: (chat: string, messageID: number) => Promise<void>
  fmtTime: (ms: number) => string
  clean: (s: unknown, n: number) => string
  sanitizeLog: (s: unknown) => string
  commandArg: (text: string) => string
}

export type PushRunArgs = {
  chatID: string
  text: string
  /** 已归一（小写、去 @suffix）的命令名；桥在入口统一计算。 */
  cmd: string
  reply: (chatID: string, text: string) => Promise<void>
}

export const createPushCommands = (deps: PushCommandDeps) => {
  const { setPaused, injectMode, setInjectMode, saveState, pinQueue, outQueue, flushQueue, pumpInject, listPlaceholder, deleteMessage, fmtTime, clean, sanitizeLog, commandArg } = deps

  /** 处理本域命令；返回 false 表示不属于本域，交给桥的其余命令分支。 */
  const run = async ({ chatID, text, cmd, reply }: PushRunArgs): Promise<boolean> => {
    if (text === "/queue" || cmd === "queue") {
      const lines: string[] = [`📌 注入队列 ${pinQueue.length} 条`]
      if (pinQueue.length === 0) {
        lines.push("（空）")
      } else {
        pinQueue.slice(0, 10).forEach((item, i) => {
          const snippet = clean(item.text, 60).replace(/\n/g, " ")
          lines.push(`  ${i + 1}. → ${item.sid.slice(0, 12)} len=${item.text.length}（${fmtTime(item.ts) || "?"}）${snippet}`)
        })
        if (pinQueue.length > 10) lines.push(`  … 及另外 ${pinQueue.length - 10} 条`)
      }
      lines.push(`📤 外发队列 ${outQueue.length} 条`)
      if (outQueue.length === 0) {
        lines.push("（空）")
      } else {
        outQueue.slice(0, 10).forEach((item, i) => {
          const snippet = clean(item.text, 60).replace(/\n/g, " ")
          lines.push(`  ${i + 1}. → ${sanitizeLog(item.chat)} len=${item.text.length}（${fmtTime(item.ts) || "?"}）${snippet}`)
        })
        if (outQueue.length > 10) lines.push(`  … 及另外 ${outQueue.length - 10} 条`)
      }
      await reply(chatID, lines.join("\n"))
      return true
    }
    if (text === "/pause" || cmd === "pause") {
      setPaused(true)
      saveState()
      await reply(chatID, "⏸ 推送已暂停")
      return true
    }
    if (text === "/resume" || cmd === "resume") {
      setPaused(false)
      saveState()
      await reply(chatID, "▶️ 推送已恢复")
      return true
    }
    if (text === "/flush" || cmd === "flush") {
      const n = outQueue.length
      await flushQueue()
      const pinSids = [...new Set(pinQueue.map((qq) => qq.sid))]
      for (const sid of pinSids) pumpInject(sid)
      await reply(chatID, `✅ 已补发：外发 ${n} → ${outQueue.length}；注入 ${pinQueue.length} 条继续`)
      return true
    }
    if (text === "/drop" || cmd === "drop") {
      const n = outQueue.length
      outQueue.length = 0
      for (const [c, mid] of [...listPlaceholder.entries()]) {
        listPlaceholder.delete(c)
        await deleteMessage(c, mid)
      }
      saveState()
      await reply(chatID, `🗑 已丢弃 ${n} 条外发消息及占位条`)
      return true
    }
    if (text === "/dropq" || cmd === "dropq") {
      const n = pinQueue.length
      pinQueue.length = 0
      saveState()
      await reply(chatID, `🗑 已丢弃 ${n} 条待注入`)
      return true
    }
    if (text === "/inject" || cmd === "inject" || text.startsWith("/inject ")) {
      const want = commandArg(text).toLowerCase()
      if (want === "now" || want === "idle") {
        setInjectMode(want)
        saveState()
        await reply(chatID, `注入：${want === "idle" ? "回合后" : "立即"}`)
        return true
      }
      await reply(chatID, `注入：${injectMode() === "idle" ? "回合后" : "立即"}`)
      return true
    }
    return false
  }

  return { run }
}
