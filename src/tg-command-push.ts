// R2712：推送/队列命令（/queue /pause /resume /flush /drop /dropq /inject）从桥内上收。
// 这组命令此前散在 tg-bridge 的巨型命令分支里：暂停标志、注入模式、外发/注入队列
// 与占位条删除各写一遍，只能靠源码字符串断言。现在集中为一个可注入队列与保存动作的
// 模块：桥只注入实时数组/函数，命令文案与顺序保持原样。
export type PushPinItem = { sid: string; text: string; ts: number }
export type PushOutItem = { chat: string; text: string; ts: number }

/**
 * R2882（运营者：「立即（now）：马上注入」）：队列回执的等待说明。
 *
 * R2871 曾把 `now` 也改成“等回合正常结束”，于是“立即”名不副实；R2882 恢复：
 *   · now  = 马上注入（宿主 steer，不等回合结束）；
 *   · idle = 等本轮正常结束，再等上一轮正文/卡片投递完。
 * 回执必须按真实时机回答，不能再把 now 写成“回合后”。
 *
 * @param mode now=立即注入；idle=回合后注入
 * @param idle 会话当前是否已经空闲
 */
export const pinWaitNote = (mode: "now" | "idle", idle: boolean): string => {
  if (mode === "now") return idle ? "" : " · 立即注入（不等回合结束）"
  if (idle) return ""
  return " · 回合正常结束后注入（等正文发完）"
}

/**
 * R2815（运营者：「注入提示似乎出错，显示的队列数量有问题」）：显示计数必须与泵
 * 实际会注入的条目一致，否则「剩余 N 条」永远不归零。
 *
 * R2819（运营者：「不要搞什么停前挂起，停止循环又不是停止消息注入」）：
 * `/loop stop` 只停自动续跑，不再挂起用户消息。桥里的 `pinQueueCutoff()` 恒为 0，
 * 生产路径上所有条目都可注入；`stoppedAt` 参数仅为兼容旧调用/单测保留。
 */
export const pinEligibleAt = (ts: number, stoppedAt: number): boolean =>
  !(stoppedAt > 0) || ts > stoppedAt

export type PinQueueCounts = { pending: number; held: number }

/**
 * R2815：按 sid 过滤（省略 sid = 全部会话）统计「可注入 / 停前挂起」。
 * R2819 起生产环境的 stoppedAt 恒为 0，因此 held 恒为 0；保留形状兼容旧调用。
 */
export const pinQueueCounts = (
  items: ReadonlyArray<{ sid: string; ts: number }>,
  stoppedAt: number,
  sid?: string,
): PinQueueCounts => {
  let pending = 0
  let held = 0
  for (const item of items) {
    if (sid !== undefined && item.sid !== sid) continue
    if (pinEligibleAt(item.ts, stoppedAt)) pending += 1
    else held += 1
  }
  return { pending, held }
}

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
  /**
   * R2883：`/inject diag` 的现场自检文本（队列/栅栏/最近决策/运行态）。
   * 可选：旧调用/单测不接线时给出一条明确提示，而不是误报“注入模式”。
   */
  injectDiag?: () => Promise<string> | string
  /**
   * R2815：当前停止时刻（未停 = 0）。用于把「停前挂起」从待注入计数中分开。
   * 不传时按未停处理（旧调用/纯单测保持原行为）。
   */
  pinStoppedAt?: () => number
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
  const pinCutoff = (): number => (deps.pinStoppedAt ? deps.pinStoppedAt() : 0)
  const countsNow = (): PinQueueCounts => pinQueueCounts(pinQueue, pinCutoff())

  /** 处理本域命令；返回 false 表示不属于本域，交给桥的其余命令分支。 */
  const run = async ({ chatID, text, cmd, reply }: PushRunArgs): Promise<boolean> => {
    if (text === "/queue" || cmd === "queue") {
      // R2815：待注入只数「泵真的会注入」的条目；停前挂起单列，避免数字永远不归零。
      const cutoff = pinCutoff()
      const pending = pinQueue.filter((item) => pinEligibleAt(item.ts, cutoff))
      const held = pinQueue.length - pending.length
      const lines: string[] = [
        `📌 注入队列 ${pending.length} 条${held > 0 ? `（另停前挂起 ${held} 条，/loop start 后恢复）` : ""}`,
      ]
      if (pending.length === 0 && held === 0) {
        lines.push("（空）")
      } else if (pending.length > 0) {
        pending.slice(0, 10).forEach((item, i) => {
          const snippet = clean(item.text, 60).replace(/\n/g, " ")
          lines.push(`  ${i + 1}. → ${item.sid.slice(0, 12)} len=${item.text.length}（${fmtTime(item.ts) || "?"}）${snippet}`)
        })
        if (pending.length > 10) lines.push(`  … 及另外 ${pending.length - 10} 条`)
      }
      if (held > 0) {
        const heldItems = pinQueue.filter((item) => !pinEligibleAt(item.ts, cutoff))
        lines.push(`⏸ 停前挂起 ${held} 条（/loop start 后恢复）`)
        heldItems.slice(0, 10).forEach((item, i) => {
          const snippet = clean(item.text, 60).replace(/\n/g, " ")
          lines.push(`  ${i + 1}. → ${item.sid.slice(0, 12)} len=${item.text.length}（${fmtTime(item.ts) || "?"}）${snippet}`)
        })
        if (heldItems.length > 10) lines.push(`  … 及另外 ${heldItems.length - 10} 条`)
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
      // R2815：只泵真正可注入的条目；停前挂起不会被 /flush 绕过（需要 /loop start）。
      const cutoff = pinCutoff()
      const pending = pinQueue.filter((item) => pinEligibleAt(item.ts, cutoff))
      const held = pinQueue.length - pending.length
      const pinSids = [...new Set(pending.map((qq) => qq.sid))]
      for (const sid of pinSids) pumpInject(sid)
      await reply(
        chatID,
        `✅ 已补发：外发 ${n} → ${outQueue.length}；注入 ${pending.length} 条继续${held > 0 ? `（停前挂起 ${held} 条，/loop start 后恢复）` : ""}`,
      )
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
      const held = countsNow().held
      pinQueue.length = 0
      saveState()
      await reply(chatID, `🗑 已丢弃 ${n} 条待注入${held > 0 ? `（含停前挂起 ${held} 条）` : ""}`)
      return true
    }
    if (text === "/inject" || cmd === "inject" || text.startsWith("/inject ")) {
      const want = commandArg(text).toLowerCase()
      if (want === "diag" || want === "log" || want === "selfcheck" || want === "诊断") {
        if (!deps.injectDiag) {
          await reply(chatID, "注入自检未接线（仅 /inject now|idle 可用）")
          return true
        }
        await reply(chatID, await deps.injectDiag())
        return true
      }
      if (want === "now" || want === "idle") {
        setInjectMode(want)
        saveState()
        // R2882：now 是真正立即注入（可插进正在跑的回合），不再谎称“回合后”。
        await reply(
          chatID,
          want === "idle" ? "注入：回合后（等本轮正常结束、正文发完）" : "注入：立即（马上注入，不等回合结束）",
        )
        return true
      }
      await reply(
        chatID,
        injectMode() === "idle" ? "注入：回合后（等本轮正常结束、正文发完）" : "注入：立即（马上注入，不等回合结束）",
      )
      return true
    }
    return false
  }

  return { run }
}
