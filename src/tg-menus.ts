// R2703：菜单静态表（动作映射/父子关系/视图）与键盘构造器从 tg-bridge 上收。
// 纯逻辑：会话列表直接读共享 compat，标题清洗由桥注入（与日志同一份实现）；
// 运行期状态（paused/stopped/守卫/后台/注入模式等）仍由调用方逐次传入。
import { readSessionListSync } from "./_v2compat"
import { bgThNext } from "./bg-mode"
import { DEFAULT_GUARD, type GuardCfg } from "./loop-guard"
import { loopInjectModeShortLabel, type LoopInjectMode } from "./loop-inject-mode"
import { titleMergeModeShortLabel } from "./title-merge"

export type MenuKeyboardOpts = {
  paused?: boolean
  stopped?: boolean
  selfmute?: boolean
  guard?: GuardCfg
  bgAuto?: boolean
  bgShellAuto?: boolean
  bgPromoteMs?: number
  quotaRecover?: string
  rollover429?: boolean
  /** R2728/R2729/R2732/R2733：全局通知 + 置顶自愈共用开关（本 Bot）。 */
  cardOps?: boolean
  injectMode?: LoopInjectMode
  injectCustom?: string
  /**
   * R2796：会话级循环的真实状态。
   * `halt` = 用户按过 ⏹（haltedSet），Bot 闸即使开着，auto-continue 也会 skip。
   * 菜单必须如实显示，否则「本 Bot 运行中 / 本会话开」会把已停会话说成在跑。
   */
  loopScope?: "on" | "off" | "halt" | "none"
  primaryID?: string
  titleMerge?: boolean
}

export type MenuKeyboardDeps = {
  /** 标题/文本清洗（桥注入 log-safe 版 clean，避免菜单另长一份）。 */
  clean: (s: unknown, n: number) => string
  /** 推送过滤档位（桥的 filt：0 隐去 / 1 仅标题 / 2 全部）。 */
  filt: (k: "reply" | "think" | "tool" | "status") => 0 | 1 | 2
  /** 压缩偏好对象（桥持有同一个可变对象，按钮文案随最新值）。 */
  compactPrefs: { auto: boolean; threshold: number; notice: boolean; ctxNotice: boolean }
  /** 已附加镜像的会话集合（桥持有同一个 Set）。 */
  watchedSessions: ReadonlySet<string>
}

/**
 * 菜单键盘（**模块作用域、可被测试直接调用**）。
 *
 * 提到模块作用域的原因：以前测试只能抄一份字面量，于是"测试全绿但真菜单坏了"
 * 这类问题可以溜过去（/menu 打不开就是这么漏的）。现在测试调的是这一份真定义。
 * paused/stopped 由调用方传入 —— 这两个是运行期状态，不该藏在闭包里。
 */
/**
 * 菜单动作 → 文本命令的映射（模块级、可测）。
 *
 * 提到模块级是为了让测试能对着**真表**检查"每个按钮都有映射"，
 * 而不是抄一份会漂移的字面量。缺映射 = 按钮点了只回"未知动作"。
 */
export const MENU_ACTION_TEXT: Record<string, string> = {
  stop: "/stop",
  undo: "/undo",
  loopstop: "/loop stop",
  loopstart: "/loop start",
  // R2662：会话级循环开关（只影响当前目标；Bot 级开关见上面两个）。
  loopon: "/loop on",
  loopoff: "/loop off",
  retry: "/retry",
  pause: "/pause",
  resume: "/resume",
  flush: "/flush",
  drop: "/drop",
  dropq: "/dropq",
  stripall: "/stripall",
  sessions: "/sessions",
  clear: "/clear",
  info: "/info",
  queue: "/queue",
  digest: "/digest",
  // R2662：补齐只有文本命令、菜单点不到的历史/诊断动作。
  replay: "/replay 5",
  compaction: "/compaction",
  // R2852：默认导出“模拟 TG”（30 分钟、按当前过滤、不截断）；完整记录用 /export full。
  export: "/export",
  status: "/status",
  tgping: "/tgping",
  tgpingall: "/tgpingall",
  drops: "/drops",
  version: "/version",
  owner: "/owner",
  whoami: "/whoami",
  errors: "/errors",
  logs: "/logs",
  inject_now: "/inject now",
  inject_idle: "/inject idle",
  watch: "/watch",
  unwatch: "/unwatch",
  new: "/new",
  compact: "/compact",
  fork: "/fork",
  revert: "/revert",
  revertundo: "/revert undo",
  revertcommit: "/revert commit",
  migrate: "/migrate",
  help: "/help",
  selfmute: "/selfmute",
  // R2662：身份/设置页补齐 Bot 名称与简介的只读入口（设置仍用文本命令带参数）。
  botname: "/botname",
  botdesc: "/botdesc",
  healcards: "/healcards",
  // R719：压缩通知发送开关（默认开）。放在推送页与 /quiet 菜单双入口。
  cnotice: "/cnotice",
  // 自动停止守卫：两个开关分列（一个只管问题、一个只管搜索），详情单独一条。
  guardprob: "/autoguard problem toggle",
  guardweb: "/autoguard web toggle",
  guardinfo: "/autoguard",
  // 转后台：裸命令=立刻提升当前阻塞子代理；auto=整体自动配置；shell=shell 自动后台；th=超时阈值；status=如实回显能力与原因。
  bg: "/background",
  bgauto: "/background auto toggle",
  bgshell: "/background shell toggle",
  bgth: "/background th",
  bgstatus: "/background status",
  // R2231 模型选择：菜单按钮等价 /model（选择器独立消息，mdl: 回调驱动）。
  model: "/model",
  // R201（用户 2026-10-18）：思考深度选择（等价 /think，thk: 回调驱动）。
  think: "/think",
  // R942 出口代理：面板 + 换出口（结束本轮，下一轮换新代理）。
  proxy: "/proxy",
  proxynext: "/proxy next",
  proxylist: "/proxy list",
  // R2626：额度尾条恢复（Option C 跨 CI 一次性续跑）的设置/记录。
  qtailauto: "/quotatail auto",
  qtailoff: "/quotatail off",
  qtailrecent: "/quotarecent",
  // R2650：每 Bot 独立的「429 换会话」开关（菜单按钮）。
  rollover429: "/rollover429 toggle",
  // R2728/R2729/R2732/R2733：全局通知 + 置顶自愈共用开关（一个菜单选项，本 Bot）。
  cardops: "/cardops toggle",
  // R2656：人工立即换会话（先停旧回合，再新建会话并注入续跑提示）。
  rollovernow: "/rollover429 now",
  // R2659/R2663：每轮注入文案模式。injectmode 只为旧菜单卡保留（在已启用模式间轮切）；
  // 新菜单进入「循环 › 每轮注入」子页，三个模式各一个按钮，再加查看/设置自定义文案。
  injectmode: "/loop mode",
  injectfull: "/loop full",
  injectsimple: "/loop simple",
  injectcustom: "/loop custom on",
  injectcustomtext: "/loop custom",
  config: "/config",
  loud: "/loud",
  quiet: "/quiet",
}

/**
 * R2825/R2829（运营者：「部分状态切换按钮的反馈可以改成tg自带的弹出式提醒,
 * 不是弹出窗口，是类似ai改标题时显示的进行中的上方弹出式」）：
 * 菜单里的**状态开关/档位**按钮。点击后不再往聊天里补一条回执（或把回执追加
 * 到菜单正文），而是用 answerCallbackQuery 的顶部 toast 回报新状态；
 * 菜单本身仍原地刷新，按钮文案就是最终状态。
 *
 * 只列开关/档位：停止、迁移、重放、删除等一次性动作仍走原有回执，避免每个
 * 按钮都弹提示。新增开关按钮时在这里登记，`menu-layout` 回归会检查动作映射。
 */
export const MENU_TOGGLE_ACTIONS: ReadonlySet<string> = new Set([
  // 推送 / 过滤
  "pause",
  "resume",
  "loud",
  "selfmute",
  "cnotice",
  "inject_now",
  "inject_idle",
  // 循环
  "loopstop",
  "loopstart",
  "loopon",
  "loopoff",
  "injectmode",
  "injectfull",
  "injectsimple",
  "injectcustom",
  "qtailauto",
  "qtailoff",
  // 守卫 / 后台 / 429 / 卡片
  "guardprob",
  "guardweb",
  "bgauto",
  "bgshell",
  "bgth",
  "rollover429",
  "cardops",
])

/** 菜单页父子关系（R2637）：子页的「⬅️ 返回」指向它的上级；root 没有返回键。 */
export const MENU_PARENT: Record<string, string> = {
  sess: "root",
  sessops: "sess",
  sessall: "sess",
  push: "root",
  pushfilt: "push",
  pushcompact: "push",
  pushinject: "push",
  pushwatch: "push",
  pushwatchadd: "pushwatch",
  loop: "root",
  loopinject: "loop",
  loopturn: "loop",
  loopctl: "loop",
  guard: "loop",
  quota: "loop",
  bg: "root",
  bgactions: "bg",
  bgauto: "bg",
  bgth: "bg",
  model: "root",
  think: "root",
  proxy: "root",
  sys: "root",
  diag: "sys",
  queue: "sys",
  maint: "sys",
  identity: "sys",
}
/** 可由纯键盘构造器直接渲染的视图。model/think 需要异步拉宿主清单，由 showMenuView 单独渲染。 */
export const MENU_VIEWS: readonly string[] = ["root", ...Object.keys(MENU_PARENT)]

export const createMenuKeyboard = (deps: MenuKeyboardDeps) => {
  const { clean, filt, compactPrefs, watchedSessions } = deps
  return (
    view: string,
    opts: MenuKeyboardOpts = {},
  ): unknown[][] => {
  const paused = Boolean(opts.paused)
  const stopped = Boolean(opts.stopped)
  const selfmute = Boolean(opts.selfmute)
  // 守卫开关是运行期状态（同 paused/stopped 由调用方传入）。**缺省按开**显示：
  // 装守卫的目的是停下来问人，默认显示成「关」会让人以为功能没装。
  const gProblem = opts.guard ? opts.guard.problem !== false : DEFAULT_GUARD.problem
  const gWeb = opts.guard ? opts.guard.websearch !== false : DEFAULT_GUARD.websearch
  // 整体自动转后台开关（默认关：它是行为改变，且实验开关没开时调用注定失败）。
  const bgAutoOn = Boolean(opts.bgAuto)
  // shell 自动后台开关（默认关：后台化改变响应时序，必须用户显式开）。
  const bgShellAuto = Boolean(opts.bgShellAuto)
  // 插件层 shell>N 秒转后台阈值（R1505 起可调；缺省 60s）。
  const bgMs = Number.isFinite(Number(opts.bgPromoteMs)) ? Number(opts.bgPromoteMs) : 60_000
  // R2626：额度尾恢复缺省 auto（只有换出口才续）；只有显式 off 才显示关闭。
  const quotaRecoverOn = opts.quotaRecover !== "off"
  // R2650：per-Bot 的 429 自动换会话开关（缺省按开显示）。
  const rollover429On = opts.rollover429 !== false
  // R2728/R2729/R2732/R2733：全局通知 + 置顶自愈共用一个本 Bot 开关（缺省开）。
  const cardOpsOn = opts.cardOps !== false
  // R2659：每轮注入文案模式（全局共享；缺省完整模板）。R2663：三种模式进子页选择。
  const injectMode = opts.injectMode ?? "full"
  // R2673：仅标题卡片合并模式（缺省关，保持既有部署行为）。
  const titleMergeOn = Boolean(opts.titleMerge)
  // 菜单阈值按钮：轮切到下一档，按钮文案带目标档，回调把目标秒数带给命令。
  // R2380：定义收敛到 bg-mode.bgThNext（单一真源）——此前本地一份、parseBgArg 一份，
  // 离档分支不一致（本地 30s vs 命令 60s）→ 按钮文案与按下结果不符。现与命令同源。

  // 注意：inline_keyboard 的一"行"必须是**扁平的按钮数组**。
  // R2637：每一页只放本组动作；「返回」统一按 MENU_PARENT 指向父页，
  // 不再所有子页都回 root（细分后必须能逐级返回）。
  const b = (label: string, data: string): unknown => ({ text: label, callback_data: data })
  const withBack = (v: string, rows: unknown[][]): unknown[][] => {
    const p = MENU_PARENT[v]
    if (p) rows.push([b("⬅️ 返回", `m:${p}`)])
    return rows
  }
  const sessRows = (limit: number): unknown[][] =>
    [...readSessionListSync()].slice(0, limit).map((s: any) => [
      { text: clean(s?.title || s?.id?.slice(0, 12) || "?", 22), callback_data: `use:${s.id}` },
    ])
  if (view === "sess") {
    // R2645：把「新建会话」放在会话页最上面——它是会话页最常用的动作，
    // 此前只有 /new 文本命令，菜单里找不到。
    const rows: unknown[][] = [[b("➕ 新建会话", "ma:new")]]
    rows.push(...sessRows(8))
    rows.push([b("🧬 Fork 当前会话", "ma:fork"), b("↩️ 回退输入", "ma:revert")])
    rows.push([b("🧰 更多会话操作", "m:sessops"), b("📋 全部会话", "m:sessall")])
    return withBack(view, rows)
  }
  if (view === "sessall") {
    return withBack(view, sessRows(20))
  }
  if (view === "sessops") {
    // R2662：Fork/回退只留在会话主页，身份归「系统 › 身份」；这里只放真正的“更多”动作。
    return withBack(view, [
      [b("🧬 迁移到新会话", "ma:migrate"), b("📌 跟随前台（取消钉选）", "ma:clear")],
      [b("📤 重发最近 5 条", "ma:replay"), b("🗜 最近压缩摘要", "ma:compaction")],
    ])
  }
  if (view === "push") {
    // R2768（运营者：「设置中有一些选项位置不合理，比如说自动压缩和压缩通知」）：
    // 推送页只留总开关与四个细分入口；过滤/压缩/注入/镜像各自成页。
    // 压缩通知不再与暂停/全部推送混排，而是和自动压缩/阈值放进同一个「压缩设置」页。
    return withBack(view, [
      [b(paused ? "▶️ 恢复推送" : "⏸ 暂停推送", paused ? "ma:resume" : "ma:pause"), b("🔊 全部推送", "ma:loud")],
      [b("🔇 过滤设置", "m:pushfilt"), b("🗜 压缩设置", "m:pushcompact")],
      [b("💉 注入时机", "m:pushinject"), b("📎 附加镜像", "m:pushwatch")],
    ])
  }
  if (view === "pushfilt") {
    // R2768：本页只放推送过滤 + 仅标题合并；压缩相关设置全部移到 m:pushcompact，
    // 不再让「自动压缩/压缩阈值」藏在过滤页里。
    const keys = ["reply", "think", "tool", "status"] as const
    const name: Record<string, string> = { reply: "💬 回复", think: "🧠 思考", tool: "🔧 工具", status: "✅ 完成" }
    const state = ["隐去", "仅标题", "全部"] as const
    const rows: unknown[][] = keys.map((k) => [b(`${name[k]}：${state[filt(k)]} ›`, `flt:${k}`)])
    rows.push([b(`🧠 仅标题合并：${titleMergeOn ? "开" : "关"} ›`, "flt:merge")])
    rows.push([b("全开", "flt:all:2"), b("全隐", "flt:all:0")])
    return withBack(view, rows)
  }
  if (view === "pushcompact") {
    // R2768：压缩设置集中一页 —— 通知（含摘要正文）、自动压缩、阈值。
    // 通知/自动压缩是独立开关：关通知不会关自动压缩，反之亦然。
    return withBack(view, [
      [b(compactPrefs.notice ? "🗜 压缩通知：发" : "🗜 压缩通知：不发", "flt:compact:notice")],
      [b(compactPrefs.ctxNotice === false ? "⚠️ ctx 提醒：关" : "⚠️ ctx 提醒：开", "flt:compact:ctxnotice")],
      [b(`🗜 自动压缩：${compactPrefs.auto ? "开" : "关"}`, "flt:compact:auto")],
      [b(`📐 压缩阈值：${Math.round(compactPrefs.threshold * 100)}%`, "flt:compact:th")],
    ])
  }
  if (view === "pushinject") {
    return withBack(view, [
      [b("⚡ 立即注入（不等回合）", "ma:inject_now"), b("🕒 回合正常结束后注入", "ma:inject_idle")],
    ])
  }
  if (view === "pushwatch") {
    // R2662：旧页只写“用 /watch <会话>”，手机上等于没有入口。现在直接列出已镜像
    // 会话（点 ✅ 取消），并给一个会话选择页；/watch 文本命令仍然保留。
    const list = [...watchedSessions]
    const titles = new Map(
      readSessionListSync().map((s: any) => [
        String(s?.id ?? ""),
        clean(s?.title || String(s?.id ?? "").slice(0, 12), 22),
      ]),
    )
    const rows: unknown[][] = list.map((id) => [
      b(`✅ ${titles.get(id) ?? clean(id.slice(0, 12), 22)}（点取消）`, `wch:${id}`),
    ])
    rows.push([b("➕ 添加镜像会话", "m:pushwatchadd")])
    rows.push([b("🗑 清空附加镜像", "ma:unwatch")])
    return withBack(view, rows)
  }
  if (view === "pushwatchadd") {
    // 目标会话本身已是全量推送，不列进“附加镜像”避免误点后的重复观感。
    const primary = String(opts.primaryID ?? "")
    const rows = sessRows(12).filter(
      (row) => String((row[0] as any)?.callback_data ?? "") !== `use:${primary}`,
    )
    return withBack(
      view,
      rows.map((row) =>
        row.map((x: any) => {
          const id = String(x?.callback_data ?? "").slice(4)
          const on = watchedSessions.has(id)
          return b(
            `${on ? "✅" : "📎"} ${String(x?.text ?? id.slice(0, 12))}（${on ? "点取消" : "点加入"}）`,
            `wch:${id}`,
          )
        }),
      ),
    )
  }
  if (view === "loop") {
    // R2885：按「回合 → 循环 → 注入 → 429 → 全局通知」重排，429 开关与人工立即
    // 换会话相邻；按钮只留动作名，行为说明放在本页正文，避免长括注挤占手机屏。
    return withBack(view, [
      [b("⚡ 回合操作", "m:loopturn"), b("🛡 守卫", "m:guard")],
      [b("🔁 循环开关", "m:loopctl"), b("🧯 额度尾恢复", "m:quota")],
      // R2663（运营者：「增加一个自动循环注入信息自定义模式」）：模式选择收进子页
      // （完整/简单/自定义 + 文案设置），循环主页只留入口，按钮显示当前模式。
      [b(`💉 每轮注入：${loopInjectModeShortLabel(injectMode)}`, "m:loopinject")],
      // R2650：每 Bot 独立的一键开关（菜单标题里带 Bot 名，不会串台）。
      [b(rollover429On ? "🔄 429 换会话：开" : "🔄 429 换会话：关", "ma:rollover429")],
      // R2656（运营者：“为429换回合添加一个人工触发按钮，并且触发后保证旧回合为停止状态”）：
      // 人工立即触发：先停旧回合，再新建会话并注入续跑提示；与额度尾恢复互斥，
      // 429 换会话优先（见 select-egress-step.sh 的 rollover-pending 闸门）。
      [b("⚡ 立即 429 换会话", "ma:rollovernow")],
      // R2728/R2729/R2732/R2733（运营者：「1，2改成一个菜单选项」「不是全局，是 bot
      // 单独设置」「我说的是 ci 结束/开始/tg 限流这些全局信息的开关」）：
      // 全局通知与置顶自愈合并为一个开关，但只控制**本 Bot**：在哪个 Bot 的聊天里
      // 切换就只改哪个 Bot，其它 Bot 不受影响。按钮只显示开/关。
      [b(cardOpsOn ? "📣 全局通知＋卡片自愈：开" : "📣 全局通知＋卡片自愈：关", "ma:cardops")],
    ])
  }
  if (view === "loopinject") {
    // R2663：三种模式互斥显示 ✅；自定义文案未保存时按钮如实写「未设置」。
    // 「查看/设置」走文本命令回执（Telegram 按钮不能收文本），回执里给出完整用法。
    const custom = String(opts.injectCustom ?? "").trim()
    return withBack(view, [
      [b(injectMode === "full" ? "✅ 完整模板" : "完整模板（提示词＋上次内容＋提示）", "ma:injectfull")],
      [b(injectMode === "simple" ? "✅ 简单：只发“继续”" : "简单：只发“继续”", "ma:injectsimple")],
      [b(injectMode === "custom" ? "✅ 自定义文案" : custom ? "自定义文案（已保存）" : "自定义文案（未设置）", "ma:injectcustom")],
      [b("✏️ 查看/设置自定义文案", "ma:injectcustomtext")],
    ])
  }
  if (view === "loopturn") {
    return withBack(view, [
      [b("⏹ 停止当前回合", "ma:undo"), b("🔁 重试上一条", "ma:retry")],
      [b("🗜 压缩上下文", "ma:compact"), b("✍️ AI 改标题", "title:ai")],
    ])
  }
  if (view === "loopctl") {
    // R2662：额度尾恢复只在循环主页有一个入口（此前这里和代理页各重复一次）。
    // 同时补齐会话级开关与“停止循环并中断回合”的完整停止。
    const scope = opts.loopScope ?? "on"
    return withBack(view, [
      [b(stopped ? "▶️ 继续循环" : "⏹ 停止循环（不中断回合）", stopped ? "ma:loopstart" : "ma:loopstop")],
      [
        scope === "none"
          ? b("🎯 本会话循环：未选会话", "ma:loopon")
          : scope === "halt"
            ? b("⏹ 本会话循环：关（已按停止，点恢复）", "ma:loopon")
            : scope === "off"
              ? b("⏸ 本会话循环：关（点开）", "ma:loopon")
              : b("✅ 本会话循环：开（点关）", "ma:loopoff"),
      ],
      [b("🛑 立即停止（循环+当前回合）", "ma:stop")],
    ])
  }
  if (view === "guard") {
    return withBack(view, [
      [b("🛡 守卫详情/最近触发", "ma:guardinfo")],
      [b(gProblem ? "🛑 问题即停：开" : "🛑 问题即停：关", "ma:guardprob"), b(gWeb ? "🌐 搜索即停：开" : "🌐 搜索即停：关", "ma:guardweb")],
    ])
  }
  // R2626 额度尾恢复页：两个模式互斥显示 ✅，再给最近一次恢复的记录入口。
  if (view === "quota") {
    return withBack(view, [
      [b(quotaRecoverOn ? "✅ 自动（仅换出口后）" : "自动（仅换出口后）", "ma:qtailauto"), b(quotaRecoverOn ? "关闭" : "✅ 关闭", "ma:qtailoff")],
      [b("📄 最近一次恢复", "ma:qtailrecent")],
    ])
  }
  if (view === "bg") {
    return withBack(view, [
      [b("🧵 后台操作", "m:bgactions"), b("⚡ 自动开关", "m:bgauto")],
      [b("⏱ 超时阈值", "m:bgth")],
    ])
  }
  if (view === "bgactions") {
    return withBack(view, [
      [b("🧵 立即转后台", "ma:bg"), b("ℹ️ 后台能力/直连状态", "ma:bgstatus")],
    ])
  }
  if (view === "bgauto") {
    return withBack(view, [
      [b(bgAutoOn ? "⚡ 自动转后台：开" : "⚡ 自动转后台：关", "ma:bgauto"), b(bgShellAuto ? "🖥 shell 自动后台：开" : "🖥 shell 自动后台：关", "ma:bgshell")],
    ])
  }
  if (view === "bgth") {
    const nextSec = Math.round(bgThNext(bgMs) / 1000)
    return withBack(view, [
      [b("⏱ 阈值：" + Math.round(bgMs / 1000) + "s › " + nextSec + "s", "ma:bgth")],
    ])
  }
  if (view === "proxy") {
    // R2662：额度尾恢复只保留循环页唯一入口；本页正文提示去哪设置。
    return withBack(view, [
      [b("🔄 刷新状态", "ma:proxy"), b("📄 出口详情", "ma:proxylist")],
      [b("♻️ 换出口（重启本轮）", "ma:proxynext")],
    ])
  }
  if (view === "sys") {
    return withBack(view, [
      [b("🩺 诊断", "m:diag"), b("📋 队列", "m:queue")],
      [b("🧰 维护", "m:maint"), b("🪪 身份/设置", "m:identity")],
    ])
  }
  if (view === "diag") {
    // R2885：成对排列，消除「运行日志」「全部 Bot 可发性」两条落单行。
    return withBack(view, [
      [b("🩺 Bot 状态总览", "ma:status")],
      [b("ℹ️ 目标详情", "ma:info"), b("🕒 最近动态", "ma:digest")],
      [b("📄 导出模拟 TG", "ma:export"), b("❌ 错误日志", "ma:errors")],
      [b("📜 运行日志", "ma:logs"), b("📉 发送失败记录", "ma:drops")],
      [b("🔢 桥版本", "ma:version"), b("🧾 配置清单", "ma:config")],
      [b("🔌 连通性测试", "ma:tgping"), b("📡 全部 Bot 可发性", "ma:tgpingall")],
    ])
  }
  if (view === "queue") {
    // R2885：R2876 已停用队列置顶提示，删除遗留的「📡 队列置顶」死按钮；
    // 队列操作两两成行。旧菜单卡仍可能回调 qpin，桥侧改为如实回执并清理旧卡。
    return withBack(view, [
      [b("📋 查看队列", "ma:queue"), b("🚀 立即补发", "ma:flush")],
      [b("🗑 丢弃外发队列", "ma:drop"), b("🗑 丢弃注入队列", "ma:dropq")],
    ])
  }
  if (view === "maint") {
    // R2662：迁移只留在会话操作页，避免同一动作两处入口。
    return withBack(view, [
      [b("🧽 清理旧按钮", "ma:stripall"), b("🩹 纠正卡住的工具卡", "ma:healcards")],
    ])
  }
  if (view === "identity") {
    return withBack(view, [
      [b("🪪 我是谁", "ma:whoami"), b(selfmute ? "🔊 本 Bot 应答：静默中" : "🤫 本 Bot 应答：开启", "ma:selfmute")],
      [b("🤖 Bot 名称", "ma:botname"), b("📝 Bot 简介", "ma:botdesc")],
    ])
  }
  // model/think 的实际内容由 showMenuView 异步渲染；这里只给纯函数调用方一个安全占位。
  if (view === "model" || view === "think") return withBack(view, [])
  // 根菜单：四个主题入口成对排列，模型/思考各有一个独立页。
  return [
    [b("🗂 会话", "m:sess"), b("📣 推送", "m:push")],
    [b("🔁 循环", "m:loop"), b("⚙️ 后台", "m:bg")],
    [b("🤖 模型", "m:model"), b("🧠 思考深度", "m:think")],
    [b("🌐 出口代理", "m:proxy"), b("🛠 系统", "m:sys")],
    // R2662：帮助留在根页；诊断归「系统 › 诊断」，不再在根页重复同一入口。
    [b("❓ 帮助", "ma:help")],
  ]
  }
}

// R2706：过滤/压缩页的正文与按钮同属一个视图，随键盘一起上收。
// 运行期偏好（filt/压缩/注入/合并）由调用方以 getter/共享对象注入，保持现读。
export type FilterKey = "reply" | "think" | "tool" | "status"

export const FILT_NAME: Record<string, string> = {
  reply: "💬 回复",
  think: "🧠 思考",
  tool: "🔧 工具",
  status: "✅ 完成",
}
export const FILT_STATE = ["隐去", "仅标题", "全部"] as const

export type FilterViewDeps = {
  filt: (k: FilterKey) => 0 | 1 | 2
  /** 桥持有的同一个可变对象（压缩开关/阈值/通知）。 */
  compactPrefs: { auto: boolean; threshold: number; notice: boolean; ctxNotice: boolean }
  /** 本 Bot 投递时机（模块级 injectMode）。 */
  deliveryMode: () => "now" | "idle"
  /** 本 Bot 仅标题合并开关。 */
  titleMerge: () => boolean
}

export const createFilterViews = (deps: FilterViewDeps) => {
  const { filt, compactPrefs, deliveryMode, titleMerge } = deps
  const filtLine = (): string => {
    const short: Record<FilterKey, string> = { reply: "回", think: "思", tool: "具", status: "态" }
    return "flt=" + (Object.keys(short) as FilterKey[]).map((k) => `${short[k]}${filt(k)}`).join("") +
      (compactPrefs.auto ? ` 压开${Math.round(compactPrefs.threshold * 100)}` : " 压关") +
      (deliveryMode() === "idle" ? " 注等" : " 注直")
  }
  const filterMenu = (): { text: string; kb: unknown[][] } => {
    // R2768：本页只讲过滤。压缩通知/自动压缩/阈值在「📣 推送 › 🗜 压缩设置」，
    // 注入时机在「📣 推送 › 💉 注入时机」；这里不再重复列只读状态和入口。
    const lines = ["🔇 推送过滤（点按钮切换）"]
    const kb: unknown[][] = []
    for (const k of ["reply", "think", "tool", "status"] as const) {
      lines.push(`· ${FILT_NAME[k]}：${FILT_STATE[filt(k)]}`)
      kb.push([{ text: `${FILT_NAME[k]}：${FILT_STATE[filt(k)]} ›`, callback_data: `flt:${k}` }])
    }
    // R2673/R2674：仅标题合并模式（连续同种仅标题卡 → 一条，时间取最后，末尾（×n））。
    // 与 filters 一样是**本 Bot** 的设置；菜单里显式标出作用范围，避免误以为跨 Bot 共享。
    const mergeNow: "on" | "off" = titleMerge() ? "on" : "off"
    lines.push(`· 🧠 仅标题合并：${titleMergeModeShortLabel(mergeNow)}（本 Bot；连续同种卡合并，标 ×n）`)
    kb.push([{ text: `🧠 仅标题合并：${titleMergeModeShortLabel(mergeNow)} ›`, callback_data: "flt:merge" }])
    kb.push([
      { text: "全开", callback_data: "flt:all:2" },
      { text: "全隐", callback_data: "flt:all:0" },
    ])
    return { text: lines.join("\n"), kb }
  }
  return { filtLine, filterMenu }
}
