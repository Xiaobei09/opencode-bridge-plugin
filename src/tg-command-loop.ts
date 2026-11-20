// R2722：循环命令（/loop）从桥内上收 —— 启停、逐会话开关与状态卡。
// 注入文案子命令（custom/full/simple/mode）仍由 tg-command-loop-inject 处理，
// 本模块只负责“循环跑不跑”；状态卡需要的实时数据（会话表/最近轮次/活动时间/
// 粘性名单）全部用 getter 注入，模块本身不读桥内状态。
export type LoopDeps = {
  botLabel: () => string
  /** 当前目标会话（钉选优先，否则前台）。 */
  target: () => Promise<string | undefined>
  sessionTag: (sid: string) => string
  writeLoopScope: (sid: string, on: boolean) => string
  log: (level: "info" | "warn" | "error", msg: string) => Promise<unknown> | unknown
  sanitizeLog: (s: unknown) => string
  persistLoopStop: (reason: string, scopeAll?: boolean) => void
  clearLoopStop: () => void
  writeLoopCtl: (mutate: (j: any) => void) => void
  readLoopCtl: () => any
  doStop: (sid: string) => Promise<string>
  /** 本 Bot 前台（钉选优先，取不到才用上次落盘值）——仅用于状态行的“（本 Bot）”标注。 */
  selfFront: () => string | undefined
  /** 解除 /stop 的会话 halt 并落盘（haltedSet + halt-release + state）。 */
  releaseHalt: (sid: string) => void
  /** 显式 start 后恢复停止期间挂起的注入队列。 */
  resumePumps: () => void
  botDisplayName: (id: string) => string
  injectCmd: { run: (args: { chatID: string; arg: string }) => Promise<boolean> }
  readInjectMode: () => any
  readInjectCustom: () => string
  injectModeLabel: (mode: any) => string
  refreshSessionTitles: () => Promise<boolean>
  stateFiles: () => string[]
  readJson: (path: string) => any
  stickyLoopSessions: () => Set<string>
  lastRoundOf: (sid: string) => string | undefined
  lastActivityOf: (sid: string) => number | undefined
  cachedSession: (sid: string) => { id?: string; outcome?: string; idle?: number } | undefined
  outcomeLabel: (raw: unknown) => string
  now: () => number
  commandArg: (text: string) => string
  reply: (chatID: string, text: string) => Promise<void>
}

export type LoopRunArgs = {
  chatID: string
  text: string
  /** 已归一（小写、去 @suffix）的命令名。 */
  cmd: string
}

export const createLoopCommands = (deps: LoopDeps) => {
  const {
    target: currentTarget,
    sessionTag,
    writeLoopScope,
    log,
    sanitizeLog,
    persistLoopStop,
    clearLoopStop,
    writeLoopCtl,
    readLoopCtl,
    doStop,
    selfFront,
    releaseHalt,
    resumePumps,
    botDisplayName,
    injectCmd,
    readInjectMode,
    readInjectCustom,
    injectModeLabel,
    refreshSessionTitles,
    stateFiles,
    readJson,
    stickyLoopSessions,
    lastRoundOf,
    lastActivityOf,
    cachedSession,
    outcomeLabel,
    now,
    commandArg,
    reply,
  } = deps

  /**
   * `/loop on` / `/loop off` —— **只管当前会话**。
   *
   * 为什么要单独做（2026-09-28 用户反馈“自动循环没了”）：
   *  · 循环会话的登记原本**只能靠消息里带标记词**（`筛查循环` / `[STATUS:` / 合成 prompt），
   *    所以新会话（尤其是新 Bot 的新会话）常常**不被登记** → 日志里表现为
   *    `eval begin … loop=no -> skip`，用户看到的就是“自动循环没了”。
   *  · `/loop start` 只清**全局闸**（loop-ctl.json），**不会**给会话打标记 —— 试过了，不管用。
   *  · 全局闸**刻意保留**在 `/loop stop`（任一 Bot 停全都停，跨 Bot 才有意义）。
   *  · `off` 必须写**独立否定清单**：auto-continue 的 persistLoopSessions 会把
   *    `currentLoopTargets()`（各 Bot 的 front/pinned）**重新并回**正向名单，
   *    所以“从正向名单删掉”对当前 front **无效**，下一次落盘又回来。
   */
  const setScope = async (on: boolean, chatID: string): Promise<void> => {
    const target = await currentTarget()
    if (!target || !target.startsWith("ses_")) {
      await reply(chatID, "❌ 当前没有目标会话（先 /use 选一个）")
      return
    }
    const tag = sessionTag(target)
    const err = writeLoopScope(target, on)
    if (err) {
      await reply(chatID, `❌ 写入失败：${err}`)
      return
    }
    if (on) {
      // R2796：用户点「本会话循环：开」/发 /loop on 就是明确要它继续。
      // 旧实现只写正向名单，不清 ⏹ halt → 菜单显示「开」但 auto-continue 仍
      // `eval skipped (user-halted)`（bot5 2026-11-18 实报）。这里只解除本会话
      // 的 halt，不动 Bot 级硬闸（/loop stop 仍由 /loop start 负责）。
      releaseHalt(target)
      await reply(
        chatID,
        `✅ 本会话循环已开：${tag}
（只影响这一个会话；如曾被 ⏹ 停止，已一并解除；全局闸用 /loop stop）`,
      )
      await log("info", `loop scope on sid=${sanitizeLog(target).slice(0, 14)} (per-session, halt released)`)
    } else {
      await reply(
        chatID,
        `⏸ 本会话循环已关：${tag}
（其它会话不受影响；全局闸用 /loop stop）`,
      )
      await log("info", `loop scope off sid=${sanitizeLog(target).slice(0, 14)} (per-session)`)
    }
  }

  const statusLines = async (): Promise<string[]> => {
    const ctl = readLoopCtl()
    const stopped = ctl?.stopped === true
    const by = stopped && ctl?.by ? ` by=${ctl.by}` : ""
    // R1724：逐 Bot 闸状态（用户要求「不同机器人的循环设置要求单独」）。
    const botGates: string[] = (() => {
      try {
        const bots = (ctl?.bots ?? {}) as Record<string, { stopped?: unknown; sids?: unknown }>
        const names = Object.keys(bots).sort()
        if (names.length === 0) return []
        return names.map((k) => {
          const e = bots[k] ?? {}
          const st = e.stopped === true ? "停" : "运行"
          const sid0 = Array.isArray(e.sids) && typeof e.sids[0] === "string" ? (e.sids[0] as string).slice(0, 12) : "-"
          // R921：界面只用 @username，不显示 primary/bot3/bot4 这类内部代号。
          return `${botDisplayName(k)}=${st}${sid0}`
        })
      } catch {
        return []
      }
    })()
    // 逐会话如实播报：只说全局"running"会掩盖"某个会话其实没在循环"——
    // 这正是用户报告"另一个会话总是不循环"却从状态里看不出来的原因。
    const lines: string[] = [
      `循环：${stopped ? `已停${by}（全局闸，/loop start all 恢复）` : "运行中（直到用户主动停止）"}`,
    ]
    // R2659/R2663：注入文案模式（全局）——先说明，避免用户以为循环没跑。
    const modeNow = readInjectMode()
    const modeCustom = modeNow === "custom" ? readInjectCustom() : ""
    lines.push(
      `· 每轮注入模式：${injectModeLabel(modeNow)}` +
        (modeCustom ? `（${modeCustom.length} 字）` : "") +
        `（全局；/loop full|simple|custom 切换）`,
    )
    if (botGates.length > 0) lines.push(`· 逐 Bot 闸：${botGates.join("  ")}`)
    // R921：状态卡要求显示会话状态；复用存在性列表的 HTTP 结果（含 outcome/time.idle），
    // 失败时 refreshSessionTitles 保留上一份好缓存，状态行退化为「未知」而不是整卡报错。
    await refreshSessionTitles()
    try {
      const sticky = stickyLoopSessions()
      const seen = new Set<string>()
      for (const f of stateFiles()) {
        try {
          const j = readJson(f)
          const sid = typeof j?.front === "string" ? j.front : typeof j?.pinned === "string" ? j.pinned : ""
          if (!sid.startsWith("ses_") || seen.has(sid)) continue
          seen.add(sid)
          const tag = sessionTag(sid)
          const rnd = lastRoundOf(sid)
          const act = lastActivityOf(sid)
          const mins = act ? Math.max(0, Math.round((now() - act) / 60000)) : -1
          const mine = sid === selfFront() ? "（本 Bot）" : ""
          const info = cachedSession(sid)
          const idleMin = info?.idle ? Math.max(0, Math.round((now() - info.idle) / 60000)) : -1
          const running = mins >= 0 && mins <= 2
          const state = running ? "运行中" : `${outcomeLabel(info?.outcome)}${idleMin >= 0 ? `（空闲 ${idleMin}m）` : ""}`
          lines.push(
            `· ${tag} ${sid.slice(0, 12)}${mine} 状态=${state} 循环=${sticky.has(sid) ? "是" : "未登记"}` +
              ` 最近轮次=${rnd ?? "?"} 活动=${mins >= 0 ? `${mins} 分钟前` : "未知"}`,
          )
        } catch {
          /* 单个状态文件读失败不影响其它 */
        }
      }
      if (lines.length === 1) lines.push("· （未读到任何目标会话）")
    } catch (err) {
      lines.push(`· 逐会话状态读取失败：${sanitizeLog(err).slice(0, 80)}`)
    }
    return lines
  }

  const run = async ({ chatID, text, cmd }: LoopRunArgs): Promise<boolean> => {
    const rawArg = commandArg(text)
    const arg = rawArg.toLowerCase()
    if (text === "/loop on" || cmd === "loopon" || (cmd === "loop" && arg === "on")) {
      await setScope(true, chatID)
      return true
    }
    if (text === "/loop off" || cmd === "loopoff" || (cmd === "loop" && arg === "off")) {
      await setScope(false, chatID)
      return true
    }
    if (!(text === "/loop" || text.startsWith("/loop ") || cmd === "loop")) return false

    // R2686：/loop 状态读取与 auto-continue/resume-once 共用 state-io 的
    // 主路径 + /tmp 旧路径回落，不再在命令闭包里复制一份。
    const scopeAll = arg === "stop all"
    if (arg === "stop" || scopeAll) {
      // R1061：/loop stop 必须**总是**写共享总闸。旧实现 target 存在时只 doStop
      // （doStop 刻意不写总闸，避免卡上 ⏹ 误停两会话），总闸停在 stopped=false，
      // auto-continue 每分钟继续评估 → "命令暂停后循环仍然跑"。
      persistLoopStop(scopeAll ? "user /loop stop all" : "user /loop stop", scopeAll)
      const t = await currentTarget()
      if (t) await doStop(t)
      await reply(
        chatID,
        scopeAll
          ? "⏹ 全部 Bot 循环已停（全局闸；仅 /loop start all 恢复）"
          : "⏹ 本 Bot 循环已停（其它 Bot 不变；/loop start 恢复，/loop stop all 停全部）",
      )
      return true
    }
    if (arg === "start" || arg === "start all") {
      const all = arg === "start all"
      if (all) {
        writeLoopCtl((j) => {
          j.stopped = false
          for (const k of Object.keys(j.bots ?? {})) (j.bots[k] as any).stopped = false
        })
      } else {
        clearLoopStop()
      }
      const t = await currentTarget()
      if (t) {
        // R2500：/loop start 同样**跨 Bot**解除 —— 停机可能记在别的 Bot 状态文件里。
        releaseHalt(t)
      }
      // R2776：单 Bot 停止不再清顶层 /loop stop all 硬闸，所以 /loop start 后
      // 全局闸可能仍然停着。此时如实提示，不能回一句“已恢复”让用户以为在跑。
      const gate = readLoopCtl()
      const hardGlobal = !all && gate?.stopped === true && gate?.by === "user"
      await reply(
        chatID,
        all
          ? "▶️ 全部 Bot 循环已恢复"
          : hardGlobal
            ? "⚠️ 本 Bot 已恢复，但全局循环闸仍停着（需 /loop start all）"
            : "▶️ 本 Bot 循环已恢复（其它 Bot 不变；/loop start all 恢复全部）",
      )
      // 显式 start 后才恢复停止期间挂起的注入队列。
      resumePumps()
      return true
    }
    // R2721：注入文案子命令（custom/full/simple/mode）上收到 tg-command-loop-inject。
    if (await injectCmd.run({ chatID, arg: rawArg })) return true
    await reply(chatID, (await statusLines()).join("\n"))
    return true
  }

  return { run }
}
