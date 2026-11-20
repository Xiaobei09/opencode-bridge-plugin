// R2719：后台策略命令（/background）从桥内上收。
// 能力探测、策略读写、参数解析都在 bg-mode；桥只注入宿主 client、HTTP 直连兜底、
// 目标解析与“最近一次提升尝试”记账。状态回执按**刚写入的配置**渲染，不再复用
// 命令开头读到的旧值（此前 `auto on` 会回显“自动转后台=关”）。
export type BackgroundDeps = {
  botEnvVar: string
  client: any
  readBg: () => any
  writeBg: (cfg: any) => void
  bgApiShape: (client: any) => any
  bgApiLabel: (shape: any) => string
  bgEnvOn: () => boolean
  bgHttpAvail: () => boolean
  bgHttpPromote: (sid: string) => Promise<{ ok: boolean; text: string }>
  renderKvList: (rows: Array<[string, string]>, opts: { title: string; tabAlign: boolean }) => string
  parseBgArg: (arg: string, cur: any) => any
  /** 当前目标会话（钉选优先，否则前台）。 */
  target: () => Promise<string | undefined>
  noteAttempt: (sid: string) => void
  sanitizeLog: (s: unknown) => string
  commandArg: (text: string) => string
  reply: (chatID: string, text: string) => Promise<void>
}

export type BackgroundRunArgs = {
  chatID: string
  text: string
  /** 已归一（小写、去 @suffix）的命令名。 */
  cmd: string
}

export const createBackgroundCommands = (deps: BackgroundDeps) => {
  const {
    botEnvVar,
    client,
    readBg,
    writeBg,
    bgApiShape,
    bgApiLabel,
    bgEnvOn,
    bgHttpAvail,
    bgHttpPromote,
    renderKvList,
    parseBgArg,
    target,
    noteAttempt,
    sanitizeLog,
    commandArg,
    reply,
  } = deps

  const run = async ({ chatID, text, cmd }: BackgroundRunArgs): Promise<boolean> => {
    if (!(text === "/background" || text.startsWith("/background ") || cmd === "background")) return false

    // 转后台（用户 2026-09-28 新增；菜单「🔁 循环」里也有按钮）。
    // 能力按**运行时探测**（不按版本号猜）：v2.0.10 OpenAPI=顶层 session.background，
    // v1.18.32=experimental.session.background（双路兼容）；session.subagent（创建）不在 API 面。
    const curBg = readBg()
    const shape = bgApiShape(client)
    const envOn = bgEnvOn()
    const capLabel = bgApiLabel(shape) === "无（不支持）" ? "无（不支持）·HTTP直连可用" : bgApiLabel(shape)
    // HTTP 直连可用性=与 bgHttpAvail 同判据（env 凭据优先，退回 service.json）。
    const bgHttpReady = bgHttpAvail()
    // R1505：状态用等宽表格回显（代码块恒定等宽 + box-drawing 边框对齐全靠等宽）。
    // R1509/R1510：配置清单按用户设计反馈用「键值列表」——标题+━分隔线、无竖线边框；
    // R1510 起用 tab 对齐（tabAlign:true，键补到 8 的倍数-1 + 单个 \t，值落 8 的倍数列）。
    const rpcSupport = (() => {
      const s: any = shape
      return Boolean(s?.promote || s?.subagent)
    })()
    const bgTable = (cfg: any = curBg): string =>
      renderKvList(
        [
          ["进程内后台 RPC", rpcSupport ? "✅ 支持" : "❌ 不支持"],
          ["HTTP 直连兜底", bgHttpReady ? "✅ 可用（RPC 缺失时自动降级）" : "❌ 服务注册不可读"],
          ["实验开关", envOn ? "✅ 开" : "⭕ 未开"],
          ["自动转后台", cfg.enabled ? "✅ 开" : "❌ 关"],
          ["冷却时间", `${Math.round(cfg.cooldownMs / 1000)}s`],
          ["Shell 自动后台", cfg.shellPromo !== false ? "✅ 开" : "❌ 关"],
          ["Shell 提升熔断", cfg.shellPromo !== false ? "✅ 开（强制）" : "❌ 关"],
          ["插件层超时阈值", `${Math.round(cfg.promoteMs / 1000)}s`],
        ],
        { title: "⚙️ 后台策略", tabAlign: true },
      ) +
      `\n· ${botEnvVar}=${envOn ? "开" : "未开"}（列表里列窄，完整变量名放这里）`
    const bgStatus = (cfg: any = curBg, extra = ""): string =>
      `后台：${capLabel} · 自动转后台=${cfg.enabled ? "开" : "关"}（冷却 ${Math.round(cfg.cooldownMs / 1000)}s）· shell 自动后台=${cfg.shellPromo !== false ? "开" : "关"} · 阈值=${Math.round(cfg.promoteMs / 1000)}s${extra}\n` +
      `· 实验开关 ${botEnvVar}=${envOn ? "开" : "未开"} · 无端点时走宿主 HTTP 直连\n` +
      "· 用法：/background status | auto on|off | shell on|off | th &lt;秒&gt;"
    const bgPromote = async (sid: string, why: string): Promise<string> => {
      const sessAny = (client as any)?.session
      const expSess = (client as any)?.experimental?.session
      const fn = sessAny?.background ?? expSess?.background
      if (typeof fn !== "function") {
        const viaHttp = await bgHttpPromote(sid)
        return viaHttp.ok ? viaHttp.text : `${viaHttp.text}（client 亦无该方法）`
      }
      try {
        const r = await fn.call(sessAny?.background ? sessAny : expSess, { sessionID: sid })
        const errTxt = String((r as any)?.data?.message ?? (r as any)?.data?.error ?? "").slice(0, 120)
        if (errTxt) return `✗ 提升被拒：${errTxt}`
        return `✓ 已请求转后台（${why}）会话 ${sid.slice(0, 12)}${envOn ? "" : `；⚠ 实验开关未开（${botEnvVar}），失败多半与此有关`}`
      } catch (err) {
        return `✗ 提升失败：${sanitizeLog(String(err)).slice(0, 120)}`
      }
    }
    const bgArg = commandArg(text)
    // R1822：shell 开关的 toggle 基准改用**真正生效**的 shellPromo（菜单「🖥 shell 自动后台」据此显示）。
    // 此前 toggle 基准是未被任何机制消费的 shellAuto → 按钮显示的"开/关"与实际强制提升状态不一致，
    // 用户反馈「菜单里的转后台按钮不能实际控制是否自动转后台」。
    const bgAct = parseBgArg(bgArg, { ...curBg, shellAuto: curBg.shellPromo !== false })
    if (bgAct.kind === "help") {
      await reply(chatID, `用法：/background（立刻转后台）| auto|shell on|off|toggle | th &lt;秒&gt; | status\n${bgStatus()}`)
      return true
    }
    if (bgAct.kind === "status") {
      await reply(chatID, bgTable())
      return true
    }
    // R2757（运营者「继续缩短」）：开关回执原来把整套策略表再打印一遍
    // （auto/shell 各 3 行，th 8+ 行），和刚写入的那一项无关的信息占了大半。
    // 开关只回一行变更 + 关键参数；完整表格仍由 /background status 提供。
    if (bgAct.kind === "set") {
      const next = { ...curBg, enabled: bgAct.enabled }
      writeBg(next)
      await reply(
        chatID,
        `🖥 自动转后台 → ${bgAct.enabled ? "开" : "关"}（冷却 ${Math.round(next.cooldownMs / 1000)}s · 阈值 ${Math.round(next.promoteMs / 1000)}s）`,
      )
      return true
    }
    if (bgAct.kind === "setshell") {
      const next = { ...curBg, shellAuto: bgAct.enabled, shellPromo: bgAct.enabled }
      writeBg(next)
      await reply(
        chatID,
        `🖥 Shell 自动后台 → ${bgAct.enabled ? "开" : "关"}（强制提升；阈值 ${Math.round(next.promoteMs / 1000)}s）`,
      )
      return true
    }
    if (bgAct.kind === "setth") {
      const next = { ...curBg, promoteMs: bgAct.ms }
      writeBg(next)
      await reply(chatID, `🖥 插件层超时阈值 → ${Math.round(bgAct.ms / 1000)}s（跑超自动转后台）`)
      return true
    }
    const bgTarget = await target()
    if (!bgTarget) {
      await reply(chatID, "⚠️ 无法解析目标会话（没有任何已知会话）")
      return true
    }
    noteAttempt(bgTarget)
    await reply(chatID, await bgPromote(bgTarget, "手动按钮/命令"))
    return true
  }

  return { run }
}
