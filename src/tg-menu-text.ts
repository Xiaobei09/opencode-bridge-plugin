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
  filt: (k: MenuFilterKey) => 0 | 1 | 2
  compactPrefs: { auto: boolean; threshold: number; notice: boolean }
  watchedSessions: ReadonlySet<string>
  pinLen: () => number
  outLen: () => number
  /** 本 Bot 的投递时机（模块级 injectMode：now/idle）。 */
  deliveryMode: () => "now" | "idle"
  filterMenu: () => { text: string; kb: unknown[][] }
  loopGateInfo: () => { stopped: boolean; by: string; reason: string }
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
    filt,
    compactPrefs,
    watchedSessions,
    pinLen,
    outLen,
    deliveryMode,
    filterMenu,
    loopGateInfo,
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
        "",
        "点下面切换最近会话；「全部会话」在同一张菜单里翻更多。",
        "➕ 新建会话 = 开一个空会话（/new）；创建后点它或 /use 切换。",
        "🧬 Fork = 复制当前会话完整历史到新会话并切换（/fork）。",
      ].join("\n")
    }
    if (view === "sessall") {
      return [
        head,
        `全部会话（最多显示 20 个）· 当前目标：<b>${htmlEsc(nm)}</b>`,
        "点名称切换；若目标不在列表里，用 /sessions 查看后 /use。",
      ].join("\n")
    }
    if (view === "sessops") {
      return [
        head,
        `当前目标：<b>${htmlEsc(nm)}</b>${t ? ` (${t.slice(0, 12)})` : ""}`,
        "",
        "会话级操作集中在这里：迁移到新会话、取消钉选、重发最近 5 条、最近压缩摘要。Fork/回退在上一页。",
      ].join("\n")
    }
    if (view === "push") {
      return [
        head,
        paused() ? "⏸ 实时推送已暂停" : "▶️ 实时推送中",
        `过滤：回复 ${filt("reply")} · 思考 ${filt("think")} · 工具 ${filt("tool")} · 完成 ${filt("status")}`,
        `压缩通知：${compactPrefs.notice ? "发" : "不发"} · 注入时机：${deliveryMode() === "idle" ? "回合结束后" : "立即"}`,
        `附加镜像：${watchedSessions.size} 个`,
        "",
        "推送、过滤/压缩、注入、镜像分页设置。",
      ].join("\n")
    }
    if (view === "pushfilt") {
      return [head, filterMenu().text, "", "「⬅️ 返回」回到推送页；这里只改过滤与压缩。"].join("\n")
    }
    if (view === "pushinject") {
      return [
        head,
        `当前注入时机：<b>${deliveryMode() === "idle" ? "回合结束后" : "立即"}</b>`,
        `注入队列 ${pinLen()} · 外发队列 ${outLen()}`,
        "",
        "立即 = 收到消息马上插入；回合后 = 等当前回合完成再插入，避免打断生成。",
      ].join("\n")
    }
    if (view === "pushwatch") {
      const list = [...watchedSessions]
      return [
        head,
        `附加镜像 ${list.length}/${watchMax}（只发最终正文，标题带 📌）`,
        list.length ? "已镜像的会话在下面按钮里，点 ✅ 可取消。" : "（空：只推送目标会话）",
        "",
        "「➕ 添加镜像会话」从会话列表里选；目标会话本身已全量推送，不在此列。",
      ].join("\n")
    }
    if (view === "pushwatchadd") {
      return [
        head,
        `选择要附加镜像的会话（${watchedSessions.size}/${watchMax}）`,
        "📎 = 点一下加入镜像；✅ = 已在镜像，点一下取消。",
        "附加镜像只发最终回复正文（不带思考/状态/工具流），用于多会话并行时降 429。",
        "列表为空时，先回「会话」页刷新（或发 /sessions）再进来。",
      ].join("\n")
    }
    if (view === "loop") {
      // R2561（D7）：菜单与状态卡口径一致——停止时把触发方/原因也显示出来。
      const gate = loopGateInfo()
      const gateText = gate.stopped
        ? `⏹ 自动循环：本 Bot 已停止${gate.by ? `（by:${htmlEsc(gate.by)}）` : ""}${gate.reason ? ` · ${htmlEsc(gate.reason.slice(0, 48))}` : ""}`
        : "🔁 自动循环：本 Bot 运行中"
      // R2659/R2663：注入模式是全局共享（auto-continue 单实例驱动所有 Bot），如实标注。
      const injectMode = readLoopInjectMode()
      const injectCustom = readLoopInjectCustom()
      return [
        head,
        gateText,
        `💉 每轮注入模式：<b>${loopInjectModeLabel(injectMode)}</b> · 全局` +
          (injectMode === "custom" && injectCustom ? ` · 文案「${htmlEsc(loopInjectCustomPreview(injectCustom, 40))}」` : ""),
        `会话：<b>${htmlEsc(nm)}</b>${t ? ` · 状态 ${htmlEsc(sessionStateLabel(t))}` : ""} · ${paused() ? "推送暂停" : "推送中"}`,
        `🔄 连续 2 次 429 自动换会话：<b>${rolloverOn429() ? "开" : "关"}</b>（每 Bot 独立）`,
        "回合、循环开关、每轮注入、守卫、额度尾恢复各自成页。",
      ].join("\n")
    }
    if (view === "loopinject") {
      // R2663：模式选择 + 自定义文案查看/设置入口。文案预览只显示一行，
      // 设置仍用文本命令（按钮不能收文本）；回执里给完整用法与占位符。
      const mode = readLoopInjectMode()
      const custom = readLoopInjectCustom()
      return [
        head,
        `当前模式：<b>${loopInjectModeLabel(mode)}</b> · 全局（三个 Bot 共用，下一轮立即生效）`,
        custom
          ? `${mode === "custom" ? "自定义文案" : "已保存自定义文案（未启用）"}：<code>${htmlEsc(loopInjectCustomPreview(custom, 120))}</code>`
          : "自定义文案：未设置",
        "",
        "完整模板 = 默认提示词 + 上次真实用户内容 + 自动注入提示。",
        "简单 = 每轮只发「继续」。",
        `自定义 = 你保存的文案，支持占位符：${LOOP_INJECT_PLACEHOLDERS.map(([k, v]) => `${k}=${v}`).join("；")}。`,
        `设置：/loop custom 你的文案（保存并启用，最长 ${LOOP_INJECT_CUSTOM_MAX} 字）；/loop custom on 启用已保存文案；/loop custom 只查看。`,
        "/loop full|simple 切换并保留已保存文案；/loop mode 在已启用模式间轮切。",
      ].join("\n")
    }
    if (view === "loopturn") {
      return [
        head,
        `会话：<b>${htmlEsc(nm)}</b>${t ? ` · 状态 ${htmlEsc(sessionStateLabel(t))}` : ""}`,
        `注入队列 ${pinLen()} · 外发队列 ${outLen()}`,
        "",
        "⏹ 只中断当前回合；🔁 重试上一条；🗜 压缩上下文；✍️ 用 AI 改会话标题。",
      ].join("\n")
    }
    if (view === "loopctl") {
      const gate = loopGateInfo()
      return [
        head,
        gate.stopped
          ? `⏹ 本 Bot 循环已停止${gate.by ? `（by:${htmlEsc(gate.by)}）` : ""}${gate.reason ? ` · ${htmlEsc(gate.reason.slice(0, 48))}` : ""}`
          : "🔁 本 Bot 循环运行中（ESC 或按钮只停本 Bot）",
        "",
        "「继续/停止循环」只影响本 Bot 的全局闸，不中断当前回合。",
        "「本会话循环」只影响当前目标：关掉后其它会话仍继续。",
        "「立即停止」会同时停循环并中断当前回合（等同 /stop）。",
        "额度尾恢复在「🔁 循环」主页设置。",
      ].join("\n")
    }
    if (view === "guard") {
      const g = readGuardForBot(botID())
      return [
        head,
        `🛑 问题即停：${g.problem !== false ? "开" : "关"} · 🌐 搜索即停：${g.websearch !== false ? "开" : "关"}（本 Bot 独立）`,
        "",
        "问题即停 = 助手宣告 PROBLEM / STOP 时停循环；搜索即停 = 请求或调用网页搜索时停循环等授权。",
        "开关只影响本 Bot 的自动循环；触发后只停本 Bot，恢复用 /loop start。",
        "「守卫详情」会另发一条诊断结果。",
      ].join("\n")
    }
    if (view === "quota") {
      const q = readQuotaRecover()
      const last = readQuotaRecoverLast()
      const lastLine = last
        ? `最近恢复：${fmtTime(last.at)} · ${last.reason || "?"} · prompt=${last.prompt || "?"}${last.sid ? ` · ${last.sid.slice(0, 12)}` : ""}`
        : "最近恢复：无（等下一次“换出口 + quota 尾条”）"
      return [
        head,
        `🧯 额度尾恢复：<b>${q.mode === "off" ? "关闭" : "自动"}</b> · 全局（跨 CI，三个 Bot 共用）`,
        "",
        "自动 = 只有新一轮选到的出口（upstream/egress IP）与上一轮不同时，才把 CI 重启前的 quota/429 尾条用 recover 文案续一次；同出口仍跳过，避免立刻再撞 429。",
        "· 每个会话每个 CI run 最多一次",
        "· 不要求 /loop start，也不改变自动循环开关",
        "· 不受 /loop off、循环活跃限制；但按过 ⏹（halted）的会话仍不续",
        "· 等待中的 429 换会话不会挡住恢复；只有可执行的那个会话让路",
        "· force 也不能替代“出口已变化”",
        lastLine,
      ].join("\n")
    }
    if (view === "bg") {
      const bg = readBg()
      return [
        head,
        `进程内后台 RPC：${bgShape()}`,
        `实验开关 ${BG_ENV_VAR}：${bgEnvOn() ? "开" : "未开"}`,
        `自动转后台：${bg.enabled ? "开" : "关"} · shell 自动后台：${bg.shellPromo !== false ? "开" : "关"} · 全局（宿主级，三个 Bot 共用）`,
        `插件层超时阈值：${Math.round(bg.promoteMs / 1000)}s（跑超自动转后台） · 冷却 ${Math.round(bg.cooldownMs / 1000)}s`,
        "",
        "后台能力是进程/宿主级设置，不按 Bot 或会话区分。",
        "「后台操作」「自动开关」「超时阈值」各自成页。",
      ].join("\n")
    }
    if (view === "bgactions") {
      const bg = readBg()
      return [
        head,
        `进程内后台 RPC：${bgShape()}`,
        `实验开关 ${BG_ENV_VAR}：${bgEnvOn() ? "开" : "未开"}`,
        "",
        "立即转后台 = 把当前阻塞子代理提升为后台；能力状态会另发一条诊断。",
      ].join("\n")
    }
    if (view === "bgauto") {
      const bg = readBg()
      return [
        head,
        `⚡ 自动转后台：${bg.enabled ? "开" : "关"} · 🖥 shell 自动后台：${bg.shellPromo !== false ? "开" : "关"}`,
        `冷却 ${Math.round(bg.cooldownMs / 1000)}s`,
        "",
        "自动转后台会改变响应时序；shell 自动后台只影响 shell 类工具。",
      ].join("\n")
    }
    if (view === "bgth") {
      const bg = readBg()
      return [
        head,
        `当前插件层超时阈值：<b>${Math.round(bg.promoteMs / 1000)}s</b>`,
        "点按钮轮换到下一档；跑超阈值才自动转后台。",
      ].join("\n")
    }
    if (view === "sys") {
      return [
        head,
        `版本 ${version()}`,
        `bot=${sanitizeLog(botLabel())}`,
        `状态文件 ${sanitizeLog(statePath())}`,
        `本 Bot 应答：${selfMute() ? "只答命令" : "开启"}`,
        "",
        "诊断、队列、维护、身份/设置各自成页。",
      ].join("\n")
    }
    if (view === "diag") {
      return [
        head,
        `版本 ${version()} · bot=${sanitizeLog(botLabel())}`,
        `状态文件 ${sanitizeLog(statePath())}`,
        "",
        "只读诊断入口：目标、动态、错误、日志、版本、配置、连通性、发送失败。",
      ].join("\n")
    }
    if (view === "queue") {
      return [
        head,
        `外发队列 ${outLen()} · 注入队列 ${pinLen()}`,
        "",
        "查看、立即补发、队列置顶、丢弃外发/注入。🗑 为不可撤销动作。",
      ].join("\n")
    }
    if (view === "maint") {
      return [
        head,
        "维护入口：清理旧停止按钮、纠正卡住的工具卡。迁移到新会话在「会话 › 更多会话操作」里。",
        "这些动作只改 TG 卡片或会话绑定，不会重放聊天内容。",
      ].join("\n")
    }
    if (view === "identity") {
      return [
        head,
        `本 Bot 应答：<b>${selfMute() ? "只答命令" : "开启"}</b>`,
        `版本 ${version()} · bot=${sanitizeLog(botLabel())}`,
        "",
        "🪪 我是谁 = 当前 Bot/会话绑定；🤫/🔊 切换普通文本是否自动注入。",
        "🤖/📝 查看 Bot 名称/简介；设置用 /botname 名称、/botdesc 文字。",
      ].join("\n")
    }
    if (view === "proxy") {
      const env = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? ""
      return [
        head,
        ...exitProxyBrief().map((l) => htmlEsc(l)),
        `生效中：${isExitProxyActive() ? "是" : "否"}${env ? "" : "（进程无代理变量）"}`,
        "",
        "出口代理**按轮换**：额度耗尽或代理失效 → 本轮结束 → 新一轮重新挑代理（新出口 IP）。",
        "♻️ 换出口 = 立刻结束本轮并由 workflow relay 起新 run。",
        "🧯 额度尾恢复在「🔁 循环 › 额度尾恢复」里设置（本页不重复入口）。",
      ].join("\n")
    }
    // R2661（运营者：「优化用户使用体验，优化菜单」）：根页先给一张状态摘要，
    // 日常最常确认的四件事（目标/推送/循环/队列）不用再逐页点开；入口本身保持不变。
    const rootGate = loopGateInfo()
    const rootInject = readLoopInjectMode()
    return [
      head,
      `目标：<b>${htmlEsc(nm)}</b>${t ? ` (${t.slice(0, 12)})` : ""}`,
      `📣 ${paused() ? "推送已暂停" : "推送中"} · 🔁 ${rootGate.stopped ? "循环已停止" : "循环运行中"} · 💉 注入${loopInjectModeShortLabel(rootInject)}`,
      `队列：注入 ${pinLen()} · 外发 ${outLen()}`,
      "",
      "按主题分页：会话 / 推送 / 循环 / 后台 / 模型 / 思考深度 / 出口代理 / 系统。",
      "所有页面都在同一条菜单消息里就地切换。",
    ].join("\n")
  }
}
