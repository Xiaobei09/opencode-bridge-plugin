// R2704：菜单各页说明文案从 tg-bridge 上收（原 menuText 闭包）。
// 纯文案：静态读者直接 import；时间格式/日志脱敏/运行期状态由桥注入 getter，
// 保持“每次渲染现读”的语义 —— 不能在工厂创建时固化，否则点完按钮再开菜单会看到旧状态。
import { readBg, BG_ENV_VAR, bgEnvOn } from "./bg-mode"
import { readGuardForBot } from "./loop-guard"
import { readQuotaRecover, readQuotaRecoverLast } from "./quota-recover"
import {
  readLoopInjectMode,
  readLoopInjectCustom,
  loopInjectModeLabel,
  loopInjectModeShortLabel,
  loopInjectCustomPreview,
  LOOP_INJECT_CUSTOM_MAX,
  LOOP_INJECT_PLACEHOLDERS,
} from "./loop-inject-mode"
import { isExitProxyActive, exitProxyBrief } from "./exit-proxy"
import { htmlEsc } from "./tg-html"

export type MenuFilterKey = "reply" | "think" | "tool" | "status"

export type MenuTextDeps = {
  /** 日志脱敏：桥持有本进程 token，必须注入。 */
  sanitizeLog: (s: unknown) => string
  /** 时间格式：桥解析 TG_TZ 后注入（单一真源）。 */
  fmtTime: (ms: number) => string
  botID: () => string
  botLabel: () => string
  version: () => string
  statePath: () => string
  selfMute: () => boolean
  paused: () => boolean
  /** 当前目标会话（fixedTarget → frontSessionID → persistedFront）。 */
  target: () => string | undefined
  sessionTag: (sid: string) => string
  sessionStateLabel: (sid: string) => string
  rolloverOn429: () => boolean
  /** R2728/R2729/R2732/R2733：全局通知 + 置顶自愈共用开关（本 Bot）。 */
  cardOps: () => boolean
  filt: (k: MenuFilterKey) => 0 | 1 | 2
  compactPrefs: { auto: boolean; threshold: number; notice: boolean; ctxNotice: boolean }
  watchedSessions: ReadonlySet<string>
  pinLen: () => number
  outLen: () => number
  /** 本 Bot 的投递时机（模块级 injectMode：now/idle）。 */
  deliveryMode: () => "now" | "idle"
  filterMenu: () => { text: string; kb: unknown[][] }
  loopGateInfo: () => { stopped: boolean; by: string; reason: string }
  /**
   * R2796：当前目标会话的真实循环状态（Bot 闸之外，还看 /loop off 与 ⏹ halted）。
   * 菜单只读 Bot 闸会把「本 Bot 运行中」显示成会话在跑；必须单独播报。
   */
  loopSessionScope: () => "on" | "off" | "halt" | "none"
  /** 后台 RPC 能力标签（桥用 client 计算）。 */
  bgShape: () => string
  watchMax: number
}

export const createMenuText = (deps: MenuTextDeps) => {
  const {
    sanitizeLog,
    fmtTime,
    botID,
    botLabel,
    version,
    statePath,
    selfMute,
    paused,
    target,
    sessionTag,
    sessionStateLabel,
    rolloverOn429,
    cardOps,
    filt,
    compactPrefs,
    watchedSessions,
    pinLen,
    outLen,
    deliveryMode,
    filterMenu,
    loopGateInfo,
    loopSessionScope,
    bgShape,
    watchMax,
  } = deps
  return (view: string): string => {
    const t = target()
    const nm = t ? sessionTag(t) : "(未确定)"
    const head = `<b>🎛 控制台</b> · ${sanitizeLog(botLabel())}`
    if (view === "sess") {
      return [
        head,
        `当前目标：<b>${htmlEsc(nm)}</b>${t ? ` (${t.slice(0, 12)})` : ""}`,
        "点会话切换；➕ 新建，🧬 Fork，↩️ 回退。",
      ].join("\n")
    }
    if (view === "sessall") {
      return [
        head,
        `全部会话（≤20）· 当前：<b>${htmlEsc(nm)}</b>`,
        "点名称切换；找不到用 /sessions。",
      ].join("\n")
    }
    if (view === "sessops") {
      return [
        head,
        `当前：<b>${htmlEsc(nm)}</b>${t ? ` (${t.slice(0, 12)})` : ""}`,
        "迁移 / 取消钉选 / 重发最近 5 条 / 压缩摘要。",
      ].join("\n")
    }
    if (view === "push") {
      return [
        head,
        paused() ? "⏸ 推送已暂停" : "▶️ 推送中",
        `过滤：回复 ${filt("reply")} · 思考 ${filt("think")} · 工具 ${filt("tool")} · 完成 ${filt("status")}`,
        `压缩：自动${compactPrefs.auto ? `开（${Math.round(compactPrefs.threshold * 100)}%）` : "关"} · 通知${compactPrefs.notice ? "发" : "不发"}`,
        `注入：${deliveryMode() === "idle" ? "回合后" : "立即"} · 附加镜像：${watchedSessions.size} 个`,
      ].join("\n")
    }
    if (view === "pushfilt") {
      return [head, filterMenu().text].join("\n")
    }
    if (view === "pushcompact") {
      return [
        head,
        `压缩通知：<b>${compactPrefs.notice ? "发" : "不发"}</b>（通知卡带摘要正文） · 自动压缩：<b>${compactPrefs.auto ? "开" : "关"}</b>`,
        `ctx 提醒：<b>${compactPrefs.ctxNotice === false ? "关" : "开"}</b>（40%/60% 各主动提醒一次；/ctxnotice 或下方按钮切换）`,
        `阈值：<b>${Math.round(compactPrefs.threshold * 100)}%</b> · 到达阈值后自动压缩上下文；通知关闭时不发「🗜 已压缩」卡（/cnotice、/compaction 仍可用）。`,
      ].join("\n")
    }
    if (view === "pushinject") {
      return [
        head,
        `注入：<b>${deliveryMode() === "idle" ? "回合后" : "立即"}</b> · 队列 注入 ${pinLen()} / 外发 ${outLen()}`,
        "立即=马上插入；回合后=等当前回合完成。",
      ].join("\n")
    }
    if (view === "pushwatch") {
      const list = [...watchedSessions]
      return [
        head,
        `附加镜像 ${list.length}/${watchMax}（只发最终正文）`,
        list.length ? "已镜像会话在下方，点 ✅ 取消。" : "（空：只推送目标会话）",
      ].join("\n")
    }
    if (view === "pushwatchadd") {
      return [
        head,
        `选择镜像会话（${watchedSessions.size}/${watchMax}）`,
        "📎 加入 / ✅ 取消；只发最终正文。",
      ].join("\n")
    }
    if (view === "loop") {
      const gate = loopGateInfo()
      const gateText = gate.stopped
        ? `⏹ 自动循环：本 Bot 已停止${gate.by ? `（by:${htmlEsc(gate.by)}）` : ""}${gate.reason ? ` · ${htmlEsc(gate.reason.slice(0, 48))}` : ""}`
        : "🔁 自动循环：本 Bot 运行中"
      // R2796：Bot 闸与「本会话」不是一个状态。用户按过 ⏹ 的会话即使 Bot 闸开着，
      // auto-continue 也会跳过；旧文案只说「本 Bot 运行中」→ 用户看到开、实际不动。
      const scope = loopSessionScope()
      const scopeText =
        scope === "none"
          ? "本会话：未选"
          : scope === "halt"
            ? "本会话：⏹ 已停止（点「循环开关」→「本会话循环」恢复）"
            : scope === "off"
              ? "本会话：⏸ 已关（/loop off）"
              : "本会话：✅ 循环开"
      const injectMode = readLoopInjectMode()
      const injectCustom = readLoopInjectCustom()
      return [
        head,
        gateText,
        scopeText,
        `💉 每轮注入：<b>${loopInjectModeLabel(injectMode)}</b> · 全局` +
          (injectMode === "custom" && injectCustom ? ` · 文案「${htmlEsc(loopInjectCustomPreview(injectCustom, 40))}」` : ""),
        `会话：<b>${htmlEsc(nm)}</b>${t ? ` · ${htmlEsc(sessionStateLabel(t))}` : ""} · ${paused() ? "推送暂停" : "推送中"}`,
        `429 换会话：<b>${rolloverOn429() ? "开" : "关"}</b> · 每 Bot`,
        `📣 全局通知＋卡片自愈：<b>${cardOps() ? "开" : "关"}</b> · 本 Bot（CI 结束/接力·选代理·429·TG 限流·热重载/队列恢复 / 置顶丢失重钉）`,
      ].join("\n")
    }
    if (view === "loopinject") {
      const mode = readLoopInjectMode()
      const custom = readLoopInjectCustom()
      return [
        head,
        `当前：<b>${loopInjectModeLabel(mode)}</b> · 全局`,
        custom
          ? `${mode === "custom" ? "自定义文案" : "已保存（未启用）"}：<code>${htmlEsc(loopInjectCustomPreview(custom, 120))}</code>`
          : "自定义文案：未设置",
        `完整=默认模板；简单=只发「继续」；自定义=保存文案（最长 ${LOOP_INJECT_CUSTOM_MAX} 字）。`,
        `占位符：${LOOP_INJECT_PLACEHOLDERS.map(([k, v]) => `${k}=${v}`).join("；")}`,
        "设置：/loop custom 文案 · /loop custom on · /loop custom 查看；full|simple 切换；mode 轮切。",
      ].join("\n")
    }
    if (view === "loopturn") {
      return [
        head,
        `会话：<b>${htmlEsc(nm)}</b>${t ? ` · ${htmlEsc(sessionStateLabel(t))}` : ""}`,
        `队列 注入 ${pinLen()} / 外发 ${outLen()}`,
        "停止回合 / 重试 / 压缩 / AI 改标题。",
      ].join("\n")
    }
    if (view === "loopctl") {
      const gate = loopGateInfo()
      const scope = loopSessionScope()
      const scopeText =
        scope === "none"
          ? "本会话：未选会话"
          : scope === "halt"
            ? "本会话：⏹ 已停止（auto-continue 会跳过；点下方「本会话循环」恢复）"
            : scope === "off"
              ? "本会话：⏸ 已关（/loop off；点下方「本会话循环」打开）"
              : "本会话：✅ 循环开"
      return [
        head,
        gate.stopped
          ? `⏹ 本 Bot 循环已停止${gate.by ? `（by:${htmlEsc(gate.by)}）` : ""}${gate.reason ? ` · ${htmlEsc(gate.reason.slice(0, 48))}` : ""}`
          : "🔁 本 Bot 循环运行中",
        scopeText,
        "本页开关只影响本 Bot；本会话开关只影响当前目标。",
        "「立即停止」同时停循环并中断回合（等同 /stop）。",
      ].join("\n")
    }
    if (view === "guard") {
      const g = readGuardForBot(botID())
      return [
        head,
        `🛑 问题即停：${g.problem !== false ? "开" : "关"} · 🌐 搜索即停：${g.websearch !== false ? "开" : "关"} · 本 Bot`,
        "问题即停：宣告 PROBLEM/STOP 时停循环；搜索即停：请求网页搜索时停。",
        "触发后只停本 Bot，恢复用 /loop start。",
      ].join("\n")
    }
    if (view === "quota") {
      const q = readQuotaRecover()
      const last = readQuotaRecoverLast()
      const lastLine = last
        ? `最近恢复：${fmtTime(last.at)} · ${last.reason || "?"}/${last.prompt || "?"}${last.sid ? ` · ${last.sid.slice(0, 12)}` : ""}`
        : "最近恢复：无"
      return [
        head,
        `🧯 额度尾恢复：<b>${q.mode === "off" ? "关闭" : "自动"}</b> · 全局`,
        "自动：仅当本轮出口与上一轮不同，才续一次 quota/429 尾条；同出口跳过。",
        "每会话每 run 最多一次；不要求 /loop start，也不受 /loop off 限制。",
        "按过 ⏹ 的会话不续。",
        lastLine,
      ].join("\n")
    }
    if (view === "bg") {
      const bg = readBg()
      return [
        head,
        `RPC：${bgShape()} · 实验开关 ${BG_ENV_VAR}：${bgEnvOn() ? "开" : "未开"}`,
        `自动转后台：${bg.enabled ? "开" : "关"} · shell 自动后台：${bg.shellPromo !== false ? "开" : "关"} · 全局`,
        `阈值 ${Math.round(bg.promoteMs / 1000)}s · 冷却 ${Math.round(bg.cooldownMs / 1000)}s`,
      ].join("\n")
    }
    if (view === "bgactions") {
      return [
        head,
        `RPC：${bgShape()} · 实验开关 ${BG_ENV_VAR}：${bgEnvOn() ? "开" : "未开"}`,
        "立即转后台：提升当前阻塞子代理；能力诊断另发一条。",
      ].join("\n")
    }
    if (view === "bgauto") {
      const bg = readBg()
      return [
        head,
        `⚡ 自动转后台：${bg.enabled ? "开" : "关"} · 🖥 shell 自动后台：${bg.shellPromo !== false ? "开" : "关"}`,
        `冷却 ${Math.round(bg.cooldownMs / 1000)}s。自动转后台改变响应时序；shell 只影响 shell 工具。`,
      ].join("\n")
    }
    if (view === "bgth") {
      const bg = readBg()
      return [
        head,
        `当前阈值：<b>${Math.round(bg.promoteMs / 1000)}s</b>`,
        "点按钮轮换；跑超阈值自动转后台。",
      ].join("\n")
    }
    if (view === "sys") {
      return [
        head,
        `版本 ${version()} · bot=${sanitizeLog(botLabel())}`,
        `状态文件 ${sanitizeLog(statePath())}`,
        `本 Bot 应答：${selfMute() ? "只答命令" : "开启"}`,
      ].join("\n")
    }
    if (view === "diag") {
      return [
        head,
        `版本 ${version()} · bot=${sanitizeLog(botLabel())}`,
        `状态文件 ${sanitizeLog(statePath())}`,
        "只读诊断入口。",
      ].join("\n")
    }
    if (view === "queue") {
      return [
        head,
        `外发 ${outLen()} · 注入 ${pinLen()}`,
        "查看 / 立即补发 / 置顶 / 丢弃（🗑 不可撤销）。",
      ].join("\n")
    }
    if (view === "maint") {
      return [head, "清理旧按钮、纠正卡住的工具卡；不改聊天内容。"].join("\n")
    }
    if (view === "identity") {
      return [
        head,
        `本 Bot 应答：<b>${selfMute() ? "只答命令" : "开启"}</b> · 版本 ${version()} · bot=${sanitizeLog(botLabel())}`,
        "我是谁 / 应答开关 / 名称 / 简介。",
      ].join("\n")
    }
    if (view === "proxy") {
      const env = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? ""
      return [
        head,
        ...exitProxyBrief().map((l) => htmlEsc(l)),
        `生效中：${isExitProxyActive() ? "是" : "否"}${env ? "" : "（进程无代理变量）"}`,
        "出口按轮换：♻️ 换出口=结束本轮，新 run 重挑代理。",
        "额度尾恢复在「循环 › 额度尾恢复」设置。",
      ].join("\n")
    }
    // R2661（运营者：「优化用户使用体验，优化菜单」）：根页先给一张状态摘要，
    // 日常最常确认的四件事（目标/推送/循环/队列）不用再逐页点开；入口本身保持不变。
    const rootGate = loopGateInfo()
    const rootScope = loopSessionScope()
    const rootLoop = rootGate.stopped
      ? "循环已停止（本 Bot）"
      : rootScope === "halt"
        ? "循环已停止（本会话 ⏹）"
        : rootScope === "off"
          ? "本会话循环已关"
          : rootScope === "none"
            ? "未选会话"
            : "循环运行中"
    const rootInject = readLoopInjectMode()
    return [
      head,
      `目标：<b>${htmlEsc(nm)}</b>${t ? ` (${t.slice(0, 12)})` : ""}`,
      `📣 ${paused() ? "推送已暂停" : "推送中"} · 🔁 ${rootLoop} · 💉 注入${loopInjectModeShortLabel(rootInject)}`,
      `队列：注入 ${pinLen()} · 外发 ${outLen()}`,
      "按主题分页，同一条消息内切换。",
    ].join("\n")
  }
}
