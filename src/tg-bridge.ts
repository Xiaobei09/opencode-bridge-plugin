import { spawn } from "node:child_process"
import type { Plugin } from "@opencode-ai/plugin"
import { chmodSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync, globSync, statfsSync, existsSync, readdirSync, mkdirSync } from "node:fs"
import { readSessionUsage, takeCompacted, readSessionListSync, offsetRewindTarget, registerInjectNotifier, idleVerdict, hostServiceReg, isCompactionMessage, sortRowsByCreatedTime } from "./_v2compat"
// R2696：日志安全纯函数（控制字符/凭据/会话 ID）的唯一实现；保留旧导出路径。
import { stripLogControls, redactSecrets, shrinkLogIds } from "./log-safe"
export { stripLogControls, redactSecrets }
// 上下文用量的唯一口径（与宿主 v2.3.0 的 HZ/jr 完全一致）：
// 分子 = 最近一条 assistant 的五字段之和；cache 字段缺失才是下界，存在且为 0 是精确值。
import { parseTokenUsage, isLifetimeUsage, type ParsedTokenUsage } from "./ctx-usage"
// 自动停止守卫的判据与配置（auto-continue 侧用同一份，避免两侧判据漂移）。
import {
  readGuardForBot,
  writeGuardForBot,
  readGuardLastTripForBot,
  parseGuardArg,
  DEFAULT_GUARD,
  type GuardCfg,
} from "./loop-guard"
import { inboundSilenceVerdict } from "./inbound-silence"
// 停机解除表（R2572 抽出）：tg-bridge 与 auto-continue 共用同一读/写实现。
import { readHaltRelease, noteHaltRelease, noteHaltArm, loadHaltedInto } from "./halt-release"
export { readHaltRelease, noteHaltRelease, noteHaltArm, loadHaltedInto } from "./halt-release"
// R2739：识别「服务重启打断的 aborted」，错误卡不再报成生成失败。
import { restartNoticeNear } from "./abort-classify"
// 「转后台」：原生后台子代理的能力探测 + 整体自动配置（bg-mode 里有纯函数判据与单测）。
import { readBg, writeBg, parseBgArg, bgApiShape, bgApiLabel, bgEnvOn, shouldAutoPromote, BG_ENV_VAR, bgThNext } from "./bg-mode"
// R2626：跨 CI 额度尾条恢复的持久偏好与最近一次恢复记录（workflow 读同一个 JSON）。
import { readQuotaRecover, readQuotaRecoverLast, writeQuotaRecoverMode } from "./quota-recover"
// TG 等宽表格绘制（纯函数 + 单测）：状态/诊断类消息用表格对齐（代码块强制等宽）。
import { renderTgTable, renderKvList } from "./tabular"
// 压缩通知的文案判据（纯函数 + 单测）：核心是「未知 ≠ 0」，见 compact-notice.ts 头注。
import {
  compactLogDelta,
  compactNoticeBody,
  compactNoticeVerdict,
  compactTitle,
  type CompactHow,
  type CompactNoticeMark,
} from "./compact-notice"
// 压缩卡片（纯函数 + 单测）：压缩是独立事件，不与 assistant 消息共用「💬 回复」标题。
import { compactionCards } from "./compaction-card"
// R201（用户 2026-10-18「TG桥增加选择思考深度选项」）：思考深度 = 宿主模型 variant（reasoningEffort）。
// 纯函数抽在 think-depth.ts（可单测），桥里只做 I/O 与命令/按钮分发。
import {
  buildThinkKeyboard,
  resolveThinkLevel,
  thinkLabel,
  thinkMenuText,
  variantListOf,
  THINK_DEFAULT,
  type ThinkVariant,
} from "./think-depth"
// R1565：「AI 主动结束输出」短提示文案（纯函数 + 单测），见 turn-end-note.ts 头注。
import { turnEndLine, extractRound, noteSkipped, SYNTHETIC_LOOP_MARKERS, noteOwnerOnlySkipped, pendingBackgroundShells, hasDeliverableContent, turnEndContentDelivered, turnEndLoopActive, turnEndKeyboard } from "./turn-end-note"
// R2672：turn-end note 的「继续循环」按钮 → 同进程 auto-continue 立即评估。
import { nudgeAutoContinue } from "./loop-nudge"
// R2659（运营者：「添加简单模式，只注入“继续”」）/ R2663（自定义文案）：注入模式读写 + 合成标记识别。
import { readLoopInjectMode, readLoopInjectCustom, writeLoopInjectMode, writeLoopInjectCustom, loopInjectModeLabel, loopInjectModeShortLabel, loopInjectCustomPreview, LOOP_INJECT_CUSTOM_MAX, LOOP_INJECT_PLACEHOLDERS, rowHasLoopInjectMeta } from "./loop-inject-mode"
// R2673（运营者：「仅标题的同种信息…连续的合并为一个…（×n）」）：仅标题卡片合并模式。
import {
  titleMergeModeShortLabel,
  titleOnlyKind,
  titleMergeCount,
  withTitleMergeCount,
  titleMergeAnchorAction,
  titleMergeRestackCount,
} from "./title-merge"
import { appendShellBgHint, hasShellBgHint, isFreshRunningCard, HINT_FRESH_MS_DEFAULT } from "./bg-hint"
// R942：出口代理（每轮 CI 一个正向代理 → provider 流量走另一个出口 IP）。
// 旧的「切 mihomo 节点」方案已下线：节点/DNS 级切换不改变源站看到的客户端 IP，
// 额度照样被卡；且 Bun 启动时解析一次代理，运行期换不了隧道 ⇒ 出口只能**按轮换**。
// 本模块只读状态（exit-proxy.json + 进程代理环境），供 /proxy 面板与状态页展示。
import { readExitProxy, exitProxySummary, exitProxyPanel, exitProxyBrief, isExitProxyActive, EXIT_PROXY_STATE_PATH } from "./exit-proxy"
// R2686：时间格式化与状态 IO 的唯一实现（桥/auto-continue/resume-once 共用）。
import { createTimeFormats, DEFAULT_TZ } from "./time-format"
import { PRIVATE_FILE_MODE, LOOP_CTL_PATH, readLoopCtl } from "./state-io"
// R2688：跨 Bot 429 共享标记（bot-flood.json）的读写/合并已上收到 tg-flood.ts。
import { FLOOD_FLAG_PATH, mergeFloodFlag, activeFloods, readFloodFlagDisk, markSelfFlooded, clearSelfFlooded, type FloodFlagDisk, type FloodFlagEntry } from "./tg-flood"
// R2689：实例级 flood gate / 429 streak 的状态机（纯进程内，不碰共享文件）。
import { createFloodGate, floodWaitSeconds, notePrimaryFlood, noteFallbackFlood, markPrimaryHealthy, markFallbackHealthy, FLOOD_WAIT_CAP_S } from "./tg-flood-gate"
// R2690：Bot API 的 HTTP 客户端（POST/超时/2xx/失败体解析）已上收到 tg-api.ts。
import { callTelegramApi } from "./tg-api"
// R2691：主/备通道编排（闸门、429 记账、日志节流）已上收到 tg-send.createTgFetch。
import { createTgFetch } from "./tg-send"
// R2692：HTML 转义/配平/安全切点/校验/截断/分段 的唯一实现（纯函数，可直测）。
import { htmlEsc, balanceHtmlTags, safeHtmlCut, validateHtmlText, truncateAt, splitHtmlChunks } from "./tg-html"
// R2693：执行中/终态标记的唯一纯函数实现（发送边界与看门狗共用）。
import { dropStaleRunning, stillNoteMsg, patchStillNote } from "./tg-still"
export { dropStaleRunning, stillNoteMsg, patchStillNote }
// R2694：发送正文编排（原 sendTextRaw）已上收到 tg-send-text；PUSH_MAX/结果类型随之上移。
import { PUSH_MAX, createSendText, createEditText, type SendResult } from "./tg-send-text"
export { PUSH_MAX }
// R2697：同 chat 新消息最小间隔削峰（原 paceSend 闭包）已上收到 tg-pace。
import { createPaceSend } from "./tg-pace"
// R2698/R2699：外发队列的纯策略与引擎（过期提示/丢最旧/直发闸门/回执优先/队列流程）。
import { createOutQueueEngine } from "./tg-out-queue"
// R2703：菜单静态表与键盘构造器已上收到 tg-menus（buildMenuKeyboard 保留同名导出）。
import { MENU_ACTION_TEXT, MENU_PARENT, MENU_VIEWS, createMenuKeyboard, createFilterViews, FILT_NAME } from "./tg-menus"
// R2704：菜单各页说明文案上收到 tg-menu-text（menuText 仍保留同名局部名）。
import { createMenuText } from "./tg-menu-text"
// R2707：诊断命令文案/读取上收到 tg-diagnostics（只读；桥只负责发送）。
import { createDiagnostics } from "./tg-diagnostics"
// R2708：热重载检测与提示（globalThis 跨重载；按 chat 去重，避免多 Bot 刷屏）。
import { registerBridgeLoad, reloadBots, claimReloadNotice, reloadNoticeText } from "./tg-reload-notice"
// R2709：/revert 会话回退命令上收到 tg-command-revert（宿主 HTTP 可注入，便于回归）。
import { createRevertCommand } from "./tg-command-revert"
// R2712：推送/队列命令（/queue /pause /resume /flush /drop /dropq /inject）上收。
import { createPushCommands } from "./tg-command-push"
// R2713：会话列表命令（/sessions /recents）上收。
import { createSessionListCommands } from "./tg-command-sessions"
// R2714：会话别名命令（/alias）上收。
import { createAliasCommands } from "./tg-command-alias"
// R2715：模型/思考深度命令（/model /think）上收。
import { createModelCommands } from "./tg-command-model"
// R2717：出口代理命令（/proxy）上收。
import { createProxyCommands } from "./tg-command-proxy"
// R2718：配置清单命令（/config）上收。
import { createConfigCommands } from "./tg-command-config"
// R2719：后台策略命令（/background）上收。
import { createBackgroundCommands } from "./tg-command-background"
// R2720：自动停止守卫命令（/autoguard）上收。
import { createAutoguardCommands } from "./tg-command-autoguard"
// R2721：/loop 注入文案子命令上收。
import { createLoopInjectCommands } from "./tg-command-loop-inject"
// R2722：/loop 启停、逐会话开关与状态卡上收。
import { createLoopCommands } from "./tg-command-loop"
// R2723：/replay /reload 会话回放上收。
import { createReplayCommands } from "./tg-command-replay"
// R2724：/new /fork 会话生命周期命令上收。
import { createNewForkCommands } from "./tg-command-new-fork"
// R2725：/migrate 迁移命令上收。
import { createMigrateCommands } from "./tg-command-migrate"
// R2705：命令注册表与命令 token 纯解析上收到 tg-commands。
import { CMD_ALIAS, KNOWN_CMDS, HELP_TEXT, stripCmdBotSuffix, commandArg, normalizeCmd } from "./tg-commands"
export { stripCmdBotSuffix, commandArg, normalizeCmd }
export { MENU_ACTION_TEXT, MENU_PARENT, MENU_VIEWS }
// R2701：状态卡/注入短消息/置顶队列卡的纯渲染与编辑决策已上收到 tg-cards。
import { createCardRenderers, injectCardKeyboard, isInjectCardText, isQueuePinCardText, queuePinCardText, queuePinStatusDue, queuePinEditDecision } from "./tg-cards"
export { injectCardKeyboard, isInjectCardText, isQueuePinCardText, queuePinCardText, queuePinStatusDue, queuePinEditDecision }
// R2728/R2729/R2732/R2733：全局通知与置顶自愈共用每 Bot 一个开关（菜单只有一个入口）。
import { readCardOps, writeCardOps, cardOpsLabel, formatCardOpsOverview, CARD_OPS_HELP, CARD_OPS_PATH_BASENAME } from "./card-ops"
export type { SendResult }
// 兼容旧调用路径：此前这三个函数从 tg-bridge 导出。
export { balanceHtmlTags, safeHtmlCut, validateHtmlText }
export { FLOOD_WAIT_CAP_S }
export { FLOOD_FLAG_PATH, mergeFloodFlag, activeFloods, markSelfFlooded, clearSelfFlooded }
export type { FloodFlagDisk, FloodFlagEntry }
import { emit } from "./events"
// R2687：Telegram 传输策略的纯函数层（429/退避、键盘校验、锚点/降级规则）。
// 桥只保留编排与 I/O；这些函数可直接单测，不再依赖桥的闭包。
import {
  parseTgRetryAfter,
  renameCooling,
  rename429Seconds,
  mergeRename429Until,
  FLOOD_BACKOFF_BASE_S,
  FLOOD_BACKOFF_CAP_S,
  FLOOD_BACKOFF_FLOOR_S,
  FLOOD_BACKOFF_JITTER,
  floodBackoffSeconds,
  isTransientTgStatus,
  fallbackBody,
  replyTargetMissing,
  plainTextFromHtml,
  validateInlineKeyboard,
  type TelegramResult,
  type FloodBackoffInput,
} from "./tg-transport"
// R2687：上述纯函数原先从本模块导出；保留 re-export，避免旧调用方/测试路径失效。
export {
  parseTgRetryAfter,
  renameCooling,
  rename429Seconds,
  mergeRename429Until,
  FLOOD_BACKOFF_BASE_S,
  FLOOD_BACKOFF_CAP_S,
  FLOOD_BACKOFF_FLOOR_S,
  FLOOD_BACKOFF_JITTER,
  floodBackoffSeconds,
  validateInlineKeyboard,
}
export type { FloodBackoffInput }

// R208（D7 根因）：宿主跨进程重启后会话消息 seq 可能从 0 重计 ⇒ 行序 ≠ 时序。
// R2686：排序实现上收到 `_v2compat`（宿主数据兼容层），auto-continue 与桥共用，
// 不再各留一份（否则排序口径会在两边漂移）。time.created 缺失/非法者归 0（排最前）。

// ── R1399：插件 client 白名单无 background 端点时的直连宿主 HttpApi 兜底 ────────
// 背景：R1398 实证 v2.0.10 的插件 client 只含白名单子集（session 键无 background/），
// 「转后台」在桥内必须走 HTTP 直连。凭证=opencode2 自己的服务注册
// ~/.local/state/opencode/service.json（url+password）；鉴权=Basic base64("opencode:"+pw)
// （2026-09-28 curl 实证：POST /api/session/{sid}/background → 204，空闲会话 no-op）。
const bgHttpPromote = async (sid: string): Promise<{ ok: boolean; text: string }> => {
  try {
    const { url, password: pw } = await hostServiceReg()
    if (!url || !pw) return { ok: false, text: "✗ 宿主 HttpApi 凭证不可用（service.json 缺 url/password 且无 OPENCODE_PASSWORD）" }
    const token = Buffer.from(`opencode:${pw}`, "utf8").toString("base64")
    // R1833：必须显式超时。宿主 HttpApi 若"接受连接但不响应"（半边僵死），
    // 无 signal 的 fetch 会挂到 undici 默认头超时（约 5 分钟）才失败：手动
    // /background 会卡住命令响应，自动路径滞留一个 pending 连接。本文件其它
    // 全部网络调用均有 15s 超时（setMyName / tgFetch / getUpdates 窥视…），
    // 这里是唯一例外，补齐以保持一致。
    const r = await fetch(`${url}/api/session/${encodeURIComponent(sid)}/background`, {
      method: "POST",
      headers: { Authorization: `Basic ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) return { ok: false, text: `✗ HttpApi 提升被拒：HTTP ${r.status}` }
    return { ok: true, text: `✓ 已请求转后台（直连宿主 HttpApi，HTTP ${r.status}）` }
  } catch (err) {
    return { ok: false, text: `✗ 直连失败：${safeCut(String(err), 120)}` }
  }
}
// 直连宿主 HttpApi 是否可用（service.json 同时含 url 与 password）。手动提升与自动提升共用此判据。
const bgHttpAvail = (): boolean => {
  // 同步判据。**不能只判 service.json 读得到** —— 文件可能因 serve 重启换密码而过期，
  // 「读得到 ≠ 鉴权能过」（2026-10-18 实测：文件可读但密码已换 → 全 401）。
  // 优先看进程原始 environ（绕过被清洗的 process.env），与 hostServiceReg 同源同序。
  try {
    const raw = readFileSync("/proc/self/environ", "utf8")
    if (
      String(raw)
        .split("\0")
        .some((kv) => kv.startsWith("OPENCODE_PASSWORD=") && kv.length > "OPENCODE_PASSWORD=".length)
    ) {
      return true
    }
  } catch {
    /* 无 /proc 或不可读：继续退级 */
  }
  if (typeof process.env.OPENCODE_PASSWORD === "string" && process.env.OPENCODE_PASSWORD) return true
  try {
    const reg = JSON.parse(readFileSync(`REDACTED_ROOT/.local/state/opencode/service.json`, "utf8")) as {
      url?: string
      password?: string
    }
    return Boolean(String(reg?.url ?? "").replace(/\/+$/, "") && reg?.password)
  } catch {
    return false
  }
}

// 真实水位（参照 how-much / context-sidebar 口径）：
// 分子 = 最近一次 assistant 全量 tokens（input+output+reasoning+cache.read+cache.write，压缩后重算）；
// 分母 = 模型 limit.context（provider.list 实取，取不到回落 1M）。
type CtxUsage = { at?: number; usage: ParsedTokenUsage; modelID: string; providerID: string }
const ctxUsage = new Map<string, CtxUsage>()
const modelWindows = new Map<string, number>()
let modelWinTs = 0
const ctxTotal = (u: CtxUsage): number => u.usage.total
export const windowFor = (modelID: string, providerID: string): number =>
  modelWindows.get(`${providerID}/${modelID}`) ??
  // ROUND 31（D7）：兜底与 auto-continue 的 `CONTEXT_WINDOW` **同口径** —— 取**表内最小真值
  // 200000**，不再用 1M（详见 auto-continue 同处注释：兜底偏大 = 压缩算晚 = 先溢出后失败）。
  Number(process.env.AC_FALLBACK_WINDOW ?? 200_000)
// R1881：窗口是**实取**还是**兜底猜的** —— 必须能区分。兜底常量 1048576 曾被当真实
// 窗口显示（用户实报「默认模型的上下文是1m」），而实测默认模型 `opencode/big-pickle`
// 的真实窗口是 **200000** → 显示值错 5 倍，连带自动压缩阈值也算松 5 倍。
export const windowKnown = (modelID: string, providerID: string): boolean =>
  modelWindows.has(`${providerID}/${modelID}`)

// R2607（用户指令：纠正会话长度计算与自动压缩）：窗口表共享给 auto-continue
// （同进程不同模块实例 + 独立服务场景，不能直接 import）：globalThis + 文件双通道。
// auto-continue 的压缩阈值/口径守卫需要每模型**真实窗口**（此前硬编码 1M，200k 模型算松 5 倍）。
const MODEL_WINDOWS_PATH = `REDACTED_ROOT/.config/opencode/model-windows.json`
const publishModelWindows = (): void => {
  try {
    if (!modelWindows.size) return
    const windows: Record<string, number> = {}
    for (const [k, v] of modelWindows) windows[k] = v
    const payload = { ts: Date.now(), windows }
    ;(globalThis as Record<string, unknown>).__oc_model_windows__ = payload
    atomicWrite(MODEL_WINDOWS_PATH, JSON.stringify(payload), 0o600)
  } catch {
    /* best-effort：共享失败不阻断主链路 */
  }
}
// R1881：宿主 `GET /api/model` 响应 → 「模型键 → 真实窗口」。**纯函数**（提到模块作用域），
// 这样"默认模型到底是 200k 还是 1M"能用行为测试钉死，而不是只能靠源码断言。
// 实测真实形状：{ data: [ { providerID, id, limit: { context, output } } ] }（67 个模型）。
export const modelWindowEntries = (j: unknown): Array<{ key: string; context: number }> => {
  const out: Array<{ key: string; context: number }> = []
  const root = j as any
  const list = Array.isArray(root?.data) ? root.data : Array.isArray(root) ? root : []
  for (const m of list) {
    const pid = String(m?.providerID ?? "")
    const mid = String(m?.id ?? m?.modelID ?? "")
    const lim = Number(m?.limit?.context)
    if (pid && mid && Number.isFinite(lim) && lim > 0) out.push({ key: `${pid}/${mid}`, context: lim })
  }
  return out
}

// ── R2231 模型选择（模块级纯函数层；测试钉死解析与按钮结构）────────────────────────
// 数据源 = 宿主 HttpApi `GET /api/model`（形状见 modelWindowEntries 注释；还带
// name/status/enabled）。解析归「纯函数 → 菜单（buildMenuKeyboard 同族）→ 命令/回调复用」。
export type ModelEntry = {
  id: string
  providerID: string
  name: string
  status: string
  context: number
  key: string
  display: string
  /** R201：该模型可选的「思考深度」档位（宿主 `variants`，每模型不同）。 */
  variants: ThinkVariant[]
}
/** GET /api/model 响应 → 可选模型表。去 deprecated、禁用；按 active→名称 排序。 */
export const modelListEntries = (j: unknown): ModelEntry[] => {
  const root = j as any
  const list = Array.isArray(root?.data) ? root.data : Array.isArray(root) ? root : []
  const out: ModelEntry[] = []
  for (const m of list) {
    const id = String(m?.id ?? m?.modelID ?? "")
    const providerID = String(m?.providerID ?? "")
    if (!id || !providerID) continue
    if (String(m?.status ?? "") === "deprecated") continue
    if (m?.enabled === false) continue
    const name = String(m?.name ?? "")
    out.push({
      id,
      providerID,
      name,
      status: String(m?.status ?? ""),
      context: Number(m?.limit?.context),
      key: `${providerID}/${id}`,
      display: name || `${providerID}/${id}`,
      variants: variantListOf(m),
    })
  }
  out.sort((a, b) => {
    const sa = a.status === "active" ? 0 : 1
    const sb = b.status === "active" ? 0 : 1
    return sa - sb || a.display.localeCompare(b.display)
  })
  return out
}
/**
 * 用户输入 → Model.Ref。优先级：`providerID/id` 精确 → id 精确 → id 忽略大小写 →
 * name 忽略大小写唯一 → 名称/id 包含且唯一（≥2 字符）。provider 同名时优先当前 provider。
 */
export const resolveModelRef = (
  arg: string,
  list: ModelEntry[],
  cur?: { providerID?: string },
): { id: string; providerID: string; label: string } | null => {
  const a = String(arg ?? "").trim()
  if (!a) return null
  const core = (a.split("@")[0] ?? a).trim() // 丢弃 @variant 尾巴
  if (!core) return null
  const pick = (hits: ModelEntry[]): { id: string; providerID: string; label: string } | null => {
    if (hits.length === 0) return null
    const m = hits.find((x) => x.providerID === cur?.providerID) ?? hits[0]!
    return { id: m.id, providerID: m.providerID, label: m.display }
  }
  const byKey = list.filter((m) => m.key === core)
  if (byKey.length > 0) return pick(byKey)
  const byId = list.filter((m) => m.id === core || m.id.toLowerCase() === core.toLowerCase())
  if (byId.length > 0) return pick(byId)
  const byName = list.filter((m) => m.name.toLowerCase() === core.toLowerCase())
  if (byName.length > 0) return pick(byName)
  if (core.length >= 2) {
    const fuzzy = list.filter((m) => m.name.toLowerCase().includes(core.toLowerCase()) || m.id.toLowerCase().includes(core.toLowerCase()))
    if (fuzzy.length > 0) return pick(fuzzy)
  }
  return null
}
export const MODEL_PAGE_SIZE = 10
/**
 * 模型选择器按钮（纯函数）。每模型一行 `mdl:set:<全局下标>`；多页带翻页；
 * 底部固定「刷新/关闭」；当前模型前缀 ✅。callback_data 全为短编码（<20 字节）。
 */
export const buildModelKeyboard = (list: ModelEntry[], page: number, curKey: string): unknown[][] => {
  const total = list.length
  const pages = Math.max(1, Math.ceil(total / MODEL_PAGE_SIZE))
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1)
  const slice = list.slice(p * MODEL_PAGE_SIZE, (p + 1) * MODEL_PAGE_SIZE)
  const rows: unknown[][] = slice.map((m, i) => {
    const n = p * MODEL_PAGE_SIZE + i
    const cur = m.key === curKey
    const label = `${cur ? "✅ " : ""}${clean(m.display, 44)}`
    return [{ text: label.slice(0, 50), callback_data: `mdl:set:${n}` }]
  })
  if (pages > 1) {
    rows.push([
      { text: "⬅️", callback_data: `mdl:pg:${Math.max(0, p - 1)}` },
      { text: `${p + 1}/${pages}`, callback_data: "mdl:nop" },
      { text: "➡️", callback_data: `mdl:pg:${Math.min(pages - 1, p + 1)}` },
    ])
  }
  rows.push([
    { text: "🔄 刷新", callback_data: "mdl:refresh" },
    { text: "✖️ 关闭", callback_data: "mdl:close" },
  ])
  return rows
}

/**
 * 选择器卡片文本（纯函数，**必须 HTML 安全**）。宿主以 `parse_mode=HTML` 发送/编辑，
 * 故除白名单标签（<b> 等）外，一切字面量角括号都要转义。
 *
 * 背景（2026-10-10 用户实报「模型选择列表不能翻页」）：原文案里直接写了
 * `/model <名称或 id>`，`<名称或` 被 Telegram 当成起始标签 → 400
 * `can't parse entities: Unsupported start tag "名称或" at byte offset 119`。
 * 翻页/刷新走的都是 editMessageText（同一条消息），所以**每次编辑都 400**、
 * 页面永远停在第一页 —— 症状被误读成"不能翻页"，真因是文案里的裸角括号。
 */
export const modelMenuText = (curKey: string, list: ModelEntry[]): string => {
  const curName = list.find((m) => m.key === curKey)
  const curLine = curKey ? `当前：<b>${htmlEsc(curName?.display ?? curKey)}</b>` : "当前：未知"
  return ["<b>🤖 选择模型</b>", curLine, `共 ${list.length} 个模型。点名称切换（下次生成生效）；也可发 /model &lt;名称或 id&gt;。`].join("\n")
}

// ctx 骤降是否算"宿主自动压缩" —— 纯函数，好处是四条否决线都能用行为测试钉死
// （写成 if 链就只能靠静态断言，那玩意儿今天已经假阳性 4 次）。
// 背景：2026-09-26T15:36 实测主会话 498.1k → 42.7k（48%→4%，rea=23 条被回收）= 真压缩；
// 而那一刻 `session.latestCompaction` **没报** → 只能靠 ctx 跌落识别。
// 四条否决线，缺一条就误报：
//   no-prev     重载后第一次回填没有"回填前"值（冷启动不是压缩事件）
//   below-floor 小数字抖动 / 换模型窗口，不该打扰用户
//   no-now      **回填失败(now=0) 绝不能当成"降了 100%"** —— 否则每次回填失败都报一次压缩
//   no-drop     没跌破阈值就不算
export const compactDropVerdict = (
  prevTotal: number,
  nowTotal: number,
  minBefore: number,
  ratio: number,
): { fire: boolean; why: string } => {
  if (!(prevTotal > 0)) return { fire: false, why: "no-prev" }
  if (prevTotal < minBefore) return { fire: false, why: "below-floor" }
  if (!(nowTotal > 0)) return { fire: false, why: "no-now" }
  if (!(nowTotal < prevTotal * ratio)) return { fire: false, why: "no-drop" }
  return { fire: true, why: `drop-${Math.round((1 - nowTotal / prevTotal) * 100)}pct` }
}

const fmtK = (n: number): string => {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}m`
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`
  return `${Math.round(n)}`
}
// 被判定为"累计口径"而丢弃的次数（诊断用）：宿主偶尔把 tokens.input 报成**会话累计**
// （实测 f339 出现 in=16.8m 而 out/rea/cr/cw 全 0），拿它除窗口必然显示 100%。
let ctxLifetimeRejected = 0
/**
 * 记录一次 ctx 用量样本。**返回是否真的写入了 ctxUsage**——调用方（回填扫描）必须依赖
 * 这个返回值：旧实现不看返回值，把「被拒绝的样本」也当成功打印（打印的是旧值），
 * 日志看起来在刷新、实际显示值纹丝不动，正是本 bug 至今才被识破的原因。
 *
 * 五字段解析与 lifetime 判据统一走 ctx-usage.ts（宿主 HZ/jr 口径）。
 * `noCache` 只在 **cache 字段缺失**时为真；`cache: {read:0, write:0}` 是精确值。
 */
const noteUsage = (sid: string, info: any): boolean => {
  try {
    const usage = parseTokenUsage(info?.tokens)
    // 只看 input 是错的：宿主经常只报 cache 而把 input 报 0，缓存前缀本身就是上下文。
    if (!usage.present || usage.total <= 0) return false
    // step.ended 事件本身不带 model：不要用它把已有样本的模型信息冲成空，
    // 否则卡片会从「ctx 63%」退回「ctx ?（模型窗口未知）」直到下一次回填。
    const prev = ctxUsage.get(sid)
    const modelID = String(info?.model?.id ?? "") || prev?.modelID || ""
    const providerID = String(info?.model?.providerID ?? "") || prev?.providerID || ""
    const win = windowFor(modelID, providerID)
    // 口径守卫：一次调用的窗口占用不可能超过模型窗口；附加特征见 isLifetimeUsage。
    if (isLifetimeUsage(usage, win)) {
      ctxLifetimeRejected++
      if (ctxLifetimeRejected <= 5 || ctxLifetimeRejected % 50 === 0) {
        const others = usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
        diag(
          `ctx usage rejected (looks like session-lifetime counter, not context size): sid=${sanitizeLog(sid).slice(0, 12)} in=${fmtK(usage.input)} win=${fmtK(win)} others=${fmtK(others)} (rejected x${ctxLifetimeRejected})`,
        )
      }
      return false
    }
    if (Date.now() - (ctxProvLogAt.get(sid) ?? 0) > 5 * 60_000) {
      ctxProvLogAt.set(sid, Date.now())
      diag(
        `ctx usage recorded sid=${sanitizeLog(sid).slice(0, 14)} in=${usage.input} out=${usage.output} rea=${usage.reasoning} ` +
          `cr=${usage.cacheRead} cw=${usage.cacheWrite} win=${win} pct=${(usage.total / win * 100).toFixed(1)} ` +
          `noCache=${!usage.cacheKnown}`,
      )
    }
    ctxUsage.set(sid, { at: Date.now(), usage, modelID, providerID })
    if (ctxUsage.size > 100) {
      const fk = ctxUsage.keys().next()
      if (!fk.done) ctxUsage.delete(fk.value)
    }
    return true
  } catch {
    return false
  }
}
let ctxBackfillRequest: ((sid: string) => void) | null = null
const ctxBackfillCool = new Map<string, number>()
// ctx 口径日志的节流表（每会话 5 分钟一条）
const ctxProvLogAt = new Map<string, number>()
/**
 * ctx 主动告警钩子（模块级声明，工厂在 setup 时注入实现）。
 *
 * 为什么是"钩子"而不是直接实现：告警要**给用户发消息**，需要 `sendTextRaw` / `protoBlock` /
 * `sessionNameOf` / `pushChatResolve`，而这些都在**工厂作用域**内 —— 模块级直接写会变成
 * 作用域外引用（TS2304），与之前 `callOf` 那次完全同类。本文件已有 `ctxBackfillRequest`
 * 正是这个模式，沿用它而不是另创一套。
 *
 * 为什么需要它：自动压缩有阈值和退避，用户仍应提前知道水位，以便决定 `/compact`、
 * `/new` 或 `/migrate`。40% / 60% 两档各主动提醒一次。
 * 2026-11-16 实测：本桥**可以**主动压缩（宿主 v2.3.0 原生 compact + auto-continue
 * 已成功调用），宿主自身也会自动压缩；旧注释「调不动 compact」已作废。
 */
type CtxAdvisoryFn = (sessionID: string, pct: number, noCache: boolean, ageS: number) => void
let ctxAdvisoryFn: CtxAdvisoryFn | null = null
// 询问补推的去重集合（模块级：状态保存/读回是模块级函数，工厂内声明会被 TS2304 抓到）
const pushedAsk = new Set<string>()
const ctxAdvisorySent = new Set<string>()
// 每条已发提醒的时刻（落盘过滤 24h 过期用）
const ctxAdvisoryAt = new Map<string, number>()
// 「判定是否走到 advisory」的诊断节流（每会话 10 分钟一条）
const ctxAdvisoryProbeAt = new Map<string, number>()
const CTX_ADVISORY_STEPS = [40, 60]

const ctxSuffix = (sessionID: string): string => {
  try {
    const u = ctxUsage.get(sessionID)
    if (!u) {
      const now = Date.now()
      if (now - (ctxBackfillCool.get(sessionID) ?? 0) > 60_000) {
        ctxBackfillCool.set(sessionID, now)
        try {
          ctxBackfillRequest?.(sessionID)
        } catch {
          /* ignore */
        }
      }
      return ""
    }
    const total = ctxTotal(u)
    if (total <= 0) return ""
    const win = windowFor(u.modelID, u.providerID)
    // R1881：窗口**未知**时不得拿兜底常量当真实窗口算百分比 —— 那正是「显示 1m」的成因：
    // 用量除以 1048576 会把 200k 的模型显示成"1m 才用了 9%"。宁可显示"未知"。
    if (!windowKnown(u.modelID, u.providerID)) return " · ctx ?（模型窗口未知）"
    // 兜底：超窗值一律不显示成 100%（100% 会被当成"上下文满了"，是误导）
    if (total > win) return " · ctx ?（用量口径异常，已隐藏）"
    const pct = (total / win) * 100
    // R1511：返回**原始文本**（绝不预转义）。消费点有两种约定：
    // ① 卡片头 `htmlEsc(ctxSuffix(...))`（renderToolTerminalCard/事件路径卡片）；
    // ② `ptitle → protoBlock`，后者会对标题整体 htmlEsc 一次。
    // 曾返回已转义的 `" · ctx &lt;1%"` → protoBlock 二次转义 → 用户看到字面 `&lt;1%`（2026-09-29 实测）。
    // 只有 cache 已知时 `<1%` 才是精确值；缺缓存时它是下界，必须继续走 `≥` + 说明。
    if (pct < 1 && u.usage.cacheKnown) return " · ctx <1%"
    // 缺缓存计数 → 显示下界（≥），并说明原因。宁可写"至少 9%"，也不给人一个偏低的确定值。
    // 注意：`cacheKnown` 为真时哪怕 cache 五字段都是 0 也是精确值，不能再挂「无缓存计数」。
    const mark = u.usage.cacheKnown ? "" : "≥"
    const notes: string[] = []
    if (!u.usage.cacheKnown) notes.push("无缓存计数")
    // 采样年龄：这个值只在**新 assistant 消息**到达时刷新，消息之间的空档它一直是旧快照。
    // 标出来才不会被当成"此刻的精确水位"（用户报过"显示 9%，实际 13%"——那是滞后，不是算错）。
    const ageS = u.at ? Math.round((Date.now() - u.at) / 1000) : -1
    // 阈值 180s（不是 90s）：这个标注会出现在**每张**卡片标题上，过于敏感就变成刷屏
    // （用户反馈"消息都是（几分钟前）的"）。只在该值旧到影响判断时才标。
    // 阈值 600s（10 分钟），不是 180s：自 R659 起 ctx 有 5 分钟周期刷新，正常情况下
    // 值最多只旧 5 分钟 → 3 分钟就标注属于噪声（用户连续两次问"这些(N 分钟前)是什么意思"）。
    // 现在它只在**刷新机制真的失效**时出现，那才是值得打断用户的信息。
    // 措辞用"≥"：我们只知道下限（期间可能又刷新过），不假装是精确时刻。
    if (ageS > 600) notes.push(`≥${Math.round(ageS / 60)} 分钟前`)
    // ── 主动告警：不能只等用户撞墙 ──────────────────────────────────────
    // 自动压缩要在阈值 + 退避都满足时才触发；等到撞墙才发现就晚了，所以
    // 40% / 60% 两档各主动提醒一次，让用户有时间决定 /compact、/new 或 /migrate。
    // ⚠️ 必须放在 `const ageS` **之后**：放在前面会触发 TDZ（ReferenceError），
    // 而 ctxSuffix 外层的 catch 会把它吞成 "" → 表现为"ctx 后缀静默消失"。
    // 诊断：ctx 判定是否真的走到 advisory（每会话 10 分钟一条）。
    // 用途：区分"根本没走到"与"走到了但被去重/早退"——这两种情况从外部看完全一样。
    if (pct >= CTX_ADVISORY_STEPS[0]) {
      const nowMs = Date.now()
      if (nowMs - (ctxAdvisoryProbeAt.get(sessionID) ?? 0) > 10 * 60_000) {
        ctxAdvisoryProbeAt.set(sessionID, nowMs)
        diag(
          `ctx advisory check (session=${sanitizeLog(sessionID).slice(0, 14)}, pct=${Math.round(pct)}%, ` +
            `hook=${ctxAdvisoryFn ? "set" : "NULL"}, sent=${ctxAdvisorySent.has(`${sessionID}:${CTX_ADVISORY_STEPS[0]}`)})`,
        )
      }
    }
    ctxAdvisoryFn?.(sessionID, pct, !u.usage.cacheKnown, ageS)
    const note = notes.length > 0 ? `（${notes.join("，")}）` : ""
    const pctTxt = pct < 1 ? "<1%" : `${Math.round(pct)}%`
    return ` · ctx ${mark}${pctTxt}${note}`
  } catch {
    return ""
  }
}

// 关键约束：LOOP_CTL_PATH 必须**保持共享**（自动循环总闸是全局的，两个 Bot 共用）。
// R2686：路径常量上收到 state-io.ts，桥/auto-continue/resume-once 读同一份。
// R1724（用户指令「不同机器人的循环设置要求单独」）：本 Bot 是否处于循环停止态。
// 纯函数 —— 桥侧 20 处 loopStopped() 判定全走它，单测可直接钉行为（不必起桥）。
//   * 顶层 stopped=true = 全局闸（守卫 PROBLEM/WEBSEARCH、/loop stop all）→ 一律停；
//   * bots[botId].stopped=true = 单 Bot 闸；sids 为空视为「本 Bot 全停」，
//     非空则要求包含当前 front（front 切换后旧会话自动恢复，与 auto-continue 同判据）。
/**
 * 顶层软闸类型白名单 —— 这些 by 值表示「停机等用户确认，用户确认后即可恢复」，
 * 因此用户的 `/loop start`（= 菜单「▶️ 继续循环」）有权清掉它们。
 *   * agent      —— AI 宣告 [LOOP: PAUSE]（R2497）
 *   * auto-guard —— 自动停止守卫触发 PROBLEM / WEBSEARCH（R2498，用户实报「按钮不能切换」）
 * `by="user"`（`/loop stop all` 的显式硬闸）**有意不在**集合内：只由 `/loop start all` 恢复。
 */
export const SOFT_LOOP_GATES: ReadonlySet<string> = new Set(["agent", "auto-guard"])

export const botLoopStopped = (j: any, botId: string, curSid: string): boolean => {
  if (!j || typeof j !== "object") return false
  if (j.stopped === true) return true
  const bots = j.bots
  if (!bots || typeof bots !== "object") return false
  const e = (bots as Record<string, any>)[botId]
  if (!e || typeof e !== "object" || e.stopped !== true) return false
  const sids = Array.isArray(e.sids) ? e.sids.filter((x: unknown): x is string => typeof x === "string") : []
  if (sids.length === 0) return true
  return typeof curSid === "string" && curSid !== "" && sids.includes(curSid)
}
const loopStopped = (): boolean => {
  try {
    const j = JSON.parse(readFileSync(LOOP_CTL_PATH, "utf8")) as any
    // ⚠️ 这里只能用 persistedFront（模块级 let）：frontSessionID 声明在 TgBridgePlugin
    // 闭包内（2910 行），模块级函数引用它不在作用域 → 运行时 ReferenceError 会被
    // 本函数的 catch 吞掉并返回 false → 「单 Bot 闸」静默失效（功能死掉且无任何报错）。
    // 两者始终成对赋值（2896 / 8069），语义等价。
    return botLoopStopped(j, BOT_ID, persistedFront)
  } catch {
    return false
  }
}
// R2228 循环注入提醒：该会话是否归本 Bot。判据用 loop-ctl 的单 Bot sids
//（与 auto-continue 的注入作用域一致）。跨 Bot 共享目标由各 Bot 按此判据过滤，
// 保证一次注入只会由一个 Bot 发提醒，不重复刷屏。
const ownsLoopSession = (sessionID: string): boolean => {
  try {
    const j = JSON.parse(readFileSync(LOOP_CTL_PATH, "utf8")) as any
    const e = j?.bots?.[BOT_ID]
    if (!e || typeof e !== "object") return false
    const sids = Array.isArray(e.sids) ? e.sids.filter((x: unknown): x is string => typeof x === "string") : []
    return sids.includes(sessionID)
  } catch {
    return false
  }
}
// R2228 状态卡第三行「循环: ▶/⏸」的数据源。只读展示用：停闸的 by/reason 摘到卡上，
// 用户抬头看置顶卡就能知道循环此刻是开着还是被谁按停的，不必再敲 /loop status。
const loopGateInfo = (): { stopped: boolean; by: string; reason: string } => {
  try {
    const j = JSON.parse(readFileSync(LOOP_CTL_PATH, "utf8")) as any
    const stopped = botLoopStopped(j, BOT_ID, persistedFront)
    if (!stopped) return { stopped: false, by: "", reason: "" }
    // 判据在 botLoopStopped（含 front 过滤）；展示取**触发停止的那一层**：
    // 顶层停 → j 的 by/reason；单 Bot 停 → bots[BOT_ID] 的 by/reason。
    const ge = j?.stopped === true ? j : j?.bots?.[BOT_ID]
    return {
      stopped: true,
      by: typeof ge?.by === "string" && ge.by ? ge.by : "auto",
      reason: typeof ge?.reason === "string" ? ge.reason : "",
    }
  } catch {
    return { stopped: false, by: "", reason: "" }
  }
}

const loopStopTimestamp = (): number => {
  // R1724：per-bot 闸的时间戳要取**该 Bot 条目**的 ts；混用顶层 ts 会让
  // 「停止前后的注入分界」判错（停的明明是本 bot，拿到的却是别处的写入时间）。
  try {
    const j = JSON.parse(readFileSync(LOOP_CTL_PATH, "utf8")) as any
    const bots = j?.bots
    if (bots && typeof bots === "object") {
      const e = (bots as any)[BOT_ID]
      if (e && typeof e === "object" && e.stopped === true) {
        const t = Number(e.ts ?? 0)
        if (Number.isFinite(t) && t > 0) return t
      }
    }
    const n = Number(j?.ts ?? 0)
    return Number.isFinite(n) && n > 0 ? n : Date.now()
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// R1724：loop-ctl.json 的**唯一写入内核**（模块级）。
// 为什么必须在模块级：写闸的两处调用点跨作用域 —— `/loop stop|start` 在实例闭包内，
// 而「front 切换时同步 sids」在模块级的 savePersistedState 里。若各写一份，两边迟早漂移。
// 三态返回值：wrote（真的改了盘）/ same（已是目标态，不写）/ err（写失败，调用方保留重试）。
export const mutateLoopCtlFile = (mutate: (j: any) => void): "wrote" | "same" | "err" => {
  let raw = ""
  try {
    raw = readFileSync(LOOP_CTL_PATH, "utf8")
  } catch {
    /* 文件不存在：按新建处理 */
  }
  let j: any = {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") j = parsed
  } catch {
    /* 损坏：按空对象重建（顶层字段由本次 mutate 补齐） */
  }
  if (!j.bots || typeof j.bots !== "object") j.bots = {}
  const before = JSON.stringify(j)
  try {
    mutate(j)
  } catch {
    return "err"
  }
  // 先比内容再补 ts：否则「本次什么都没改」也会因 ts 变化被写成"有变更"，
  // savePersistedState 高频调用会变成持续无谓写盘（并污染顶层 ts 这个回落时间戳）。
  if (JSON.stringify(j) !== before) j.ts = Date.now()
  const out = JSON.stringify(j)
  if (out === raw) return "same"
  try {
    // R1849：loop-ctl.json 是**跨进程共享**的总闸（tg-bridge 三个 Bot 各自的实例 +
    // auto-continue 多条服务同时读写）。裸 writeFileSync 先 O_TRUNC 再写，读侧
    // `loopStopped()`/`readCtl()` 恰好落在窗口内会 parse 失败 → catch 返回 false/{}
    // → 把「已停」误判成「没停」（fail-open：循环该停没停）。这正是 R1841/R1847 已为
    // state/loop-sessions 修掉的同一族缺陷，唯独总闸漏了。rename 原子，读者只见旧版或新版。
    atomicWrite(LOOP_CTL_PATH, out, 0o600)
    // R2686：同进程的 auto-continue 立即重评目标，不再等 60s 兜底 tick。
    // 跨进程的 Bot 仍由各自 tick/文件兜底；本事件只做即时通知。
    emit("loop:changed", { source: BOT_ID, at: Date.now() })
    return "wrote"
  } catch {
    return "err"
  }
}

// ---------------------------------------------------------------------------
// R1895/R2688：跨 Bot 429 限流标记已上收到 tg-flood.ts（共享文件 + 纯合并）。
// 桥只保留实例内的 flood gate / 429 streak 运行态与发送编排。

// R1724 缺口补丁：front 切换后必须把 bots[BOT_ID].sids 跟着换成新 front。
// 漏了会怎样：用户停了某 Bot 的循环，随后该 Bot 切到另一个会话 → sids 仍指旧会话 →
// auto-continue 侧按 sid 判定**漏停**，那个 Bot 自己又跑起来了（正是"单独停"要保证的事）。
// 节流：只在 front 变化时动；且被 isLiveWriter 挡住（陈旧热重载实例不得写）。
let ctlSidsSynced = ""
export const syncLoopCtlSids = (): void => {
  if (!isLiveWriter()) return
  // 同上：模块级函数只能用 persistedFront（frontSessionID 在闭包内，见 loopStopped 注释）。
  const cur = persistedFront
  if (!cur.startsWith("ses_") || cur === ctlSidsSynced) return
  const r = mutateLoopCtlFile((j) => {
    const e = j.bots[BOT_ID] && typeof j.bots[BOT_ID] === "object" ? j.bots[BOT_ID] : {}
    const sids = Array.isArray(e.sids) ? e.sids : []
    if (sids.length === 1 && sids[0] === cur) return
    e.sids = [cur]
    j.bots[BOT_ID] = e
  })
  // wrote 与 same 都表示磁盘已是目标态；err 则不记快照，下次 state save 再试。
  if (r !== "err") ctlSidsSynced = cur
}

// R1728：本桥实例最后一次**成功投递**的时刻。
// 为什么需要：2026-10-01 02:37 那次热重载**半完成**（模块图重求值、快照已换，但插件没重新
// 初始化）→ 事件 handler 指向已废弃的旧闭包 → 轮询/心跳/自动注入全部照常，唯独
// 「消息事件 → 卡片」这条链路全哑，**且零日志**。结果 30 分钟无推送，只有用户能发现。
// 这里记录时间戳供 watchdog 判据使用（见下面 setInterval）。
let lastProtoSendAt = 0
let lastProtoSilentWarnAt = 0

/**
 * R1733：投递静默判据（**纯函数**，不碰任何闭包/模块状态）。
 *
 * 为什么要抽出来：R1728 加的 watchdog 只被"没误报"验证过 —— 但**没报警**和**不能报警**
 * 在日志上长得一模一样（都是 0 条 `proto silent`）。若定时器没注册、或文案/条件写错，
 * 我会得出"判据从严、0 误报"的**假绿**结论。这已是本项目第 4 次同类教训
 * （scope-guard 假绿 3 次 + reload.sh 假红 1 次），共同规律是：
 * **判据必须被单独验证"能抓到目标形态"，且好输入/坏输入双向都要测。**
 *
 * 所有输入显式传入（含 loopStopped / isCurrentGen 这两个环境态），
 * 这样测试可以在不启动插件、不碰真实系统的前提下驱动全部分支。
 */
export type ProtoSilentVerdict = { warn: boolean; minutes: number; why: string }

export function protoSilentVerdict(
  now: number,
  lastSendAt: number,
  lastWarnAt: number,
  opts: { thresholdMs: number; throttleMs: number; loopStopped: boolean; isCurrentGen: boolean; paused?: boolean }
): ProtoSilentVerdict {
  const silentMs = now - (lastSendAt || 0)
  const minutes = Math.round(silentMs / 60000)
  if (!opts.isCurrentGen) return { warn: false, minutes, why: "陈旧热重载实例" }
  if (!lastSendAt) return { warn: false, minutes, why: "尚无投递基线" }
  if (silentMs < opts.thresholdMs) return { warn: false, minutes, why: "静默未超阈值" }
  // R1905：实时推送被**主动暂停**（`/pause` 或菜单「暂停推送」→ pausedMode）时，
  // 静默同样是预期行为，不是故障。此前判据只看 loopStopped，导致一个"暂停推送"的 bot
  // 每 15 分钟刷一条"proto silent … 疑似热重载半完成致事件流断开 → 需 reload 桥"的
  // **误报**（2026-10-08 bot2 实测：paused=true，会话活跃、lastpush 冻结，告警一路
  // 升级到 61min）。误报的代价是把"主动暂停"误诊成"链路损坏"，诱使去重启/reload。
  if (opts.paused) return { warn: false, minutes, why: "实时推送已暂停，静默属预期" }
  // 循环闸已停时静默是**预期行为**（用户主动停的），不是故障
  if (opts.loopStopped) return { warn: false, minutes, why: "循环已停，静默属预期" }
  if (lastWarnAt && now - lastWarnAt < opts.throttleMs) return { warn: false, minutes, why: "告警节流中" }
  return { warn: true, minutes, why: "静默超阈值且循环未停" }
}

/**
 * R1802：一次投递的**送达判定**（**纯函数**，只吃 `SendResult`，不碰模块状态）。
 *
 * ## 要解决的缺陷（真阳性，非误报）
 * 调用点原判据是 `r.r === "sent" && r.id`。但 `id` 在 `SendResult` 里是**可选**的
 * （`{ r:"sent"|"retry"|"drop"; id?: number }`），而上游 `callTelegram` 有**两条**
 * 产出 `ok:true` 却可能没有 `id` 的路径：
 *   ① HTTP 2xx 但 `result.message_id` 缺失/非数字 → `id: Number.isFinite(id) ? id : undefined`
 *   ② HTTP 2xx 但 `res.json()` 抛异常 → `return { ok: true }`（连字段都没有）
 * 于是 `{ r:"sent", id:undefined }` 会让原判据为**假**，落入 else 分支，后果有两处：
 *   - 日志记成 `proto send ${r.r}` 即 **`proto send sent`**，而且级别是 **error**
 *     —— **措辞说成功、级别说失败**，任何按级别或按关键字的判据都会读错一边；
 *   - **`lastProtoSendAt` 不刷新** → R1728 的投递静默 watchdog 基线被污染 → 可能误报。
 *
 * 决定性证据：`editTextRaw` 的两个 sent 返回点都写了 `id: r.id ?? messageID` **兜底**
 * （L3455/L3459），唯独 `sendTextRaw` 是裸的 `id: r.id` —— 作者在编辑路径防过这个坑，
 * 发送路径没防。
 *
 * ## 为什么判据里 `id` 只影响"要不要退回"，不影响"算不算送达"
 * `id` 缺失意味着**我们不知道 TG 给这条消息分配了什么编号**，于是：
 *   - 无法 `protoMap.set(key,{id})` —— 后续改写这张卡会失去锚点；
 *   - 无法 `trackReplyButtons` —— 按钮挂不上去。
 * 这是**真实的、可观测的副作用**，不能因为"消息到了"就当没事发生。
 * 但它**不改变"用户收到了"这个事实**，所以不能因此把它记成失败/漏发。
 * → 故拆成两个正交维度：`delivered`（用户是否收到）与 `degraded`（我方状态是否完整）。
 *
 * 契约：
 *   - `r !== "sent"` → delivered=false（retry/drop 由调用方各自处理）
 *   - `r === "sent" && id 是有限正整数` → delivered=true, degraded=false（正常路径）
 *   - `r === "sent"` 但 id 缺失/非有限/非正 → delivered=true, **degraded=true**
 *     （必须仍刷新 lastProtoSendAt，否则 watchdog 基线被污染）
 */
export type ProtoDeliveryVerdict = {
  /** 用户是否**确实收到**了这条消息（TG 返回 2xx 即收到，与我方是否拿到 id 无关）。 */
  delivered: boolean
  /** 我方状态是否完整：false = 可 protoMap.set + trackReplyButtons；true = 发送成功但**不能**。 */
  degraded: boolean
  /** 为什么 degraded，供日志与排障用。 */
  why: string
}
export function protoDeliveryVerdict(r: { r: "sent" | "retry" | "drop"; id?: number }): ProtoDeliveryVerdict {
  if (r.r !== "sent") return { delivered: false, degraded: false, why: `非成功路径(r=${r.r})` }
  const id = r.id
  if (typeof id !== "number" || !Number.isFinite(id) || id <= 0)
    return {
      delivered: true,
      degraded: true,
      why: `TG 已接受但未回 message_id(id=${String(id)})：不记 protoMap/按钮，但**必须**刷新 lastProtoSendAt`,
    }
  return { delivered: true, degraded: false, why: "正常：有 message_id，可锚定与挂按钮" }
}

// R2686：PRIVATE_FILE_MODE 由 state-io.ts 统一提供（见文件顶部 import）。

// R743: env-sync/tar restore can recreate these files with the runner umask (0644).
// service.json contains the host API password, and the registry/loop files hold
// bot metadata; normalize them at bridge load so a new run is secure even when
// restore-env did not preserve modes. Idempotent and best-effort.
const PRIVATE_CONFIG_PATHS = [
  `REDACTED_ROOT/.local/state/opencode/service.json`,
  `REDACTED_ROOT/.config/opencode/service.json`,
  `REDACTED_ROOT/.config/opencode/tg-bots.json`,
  `REDACTED_ROOT/.config/opencode/loop-ctl.json`,
  `REDACTED_ROOT/.config/opencode/loop-marker.json`,
  `REDACTED_ROOT/.config/opencode/loop-guard.json`,
  `REDACTED_ROOT/.config/opencode/loop-sessions.json`,
]
function normalizePrivateConfigPerms(): void {
  for (const path of PRIVATE_CONFIG_PATHS) {
    try {
      if (existsSync(path)) chmodSync(path, PRIVATE_FILE_MODE)
    } catch {
      /* best-effort: restore/read-only filesystems must not break plugin load */
    }
  }
}
normalizePrivateConfigPerms()

const STRIP_RUN_INTERVAL_MS = 10 * 60_000
// R2636：已处理键账本上限。旧值 500（落盘仅 200）小于 protoMap 内存护栏 800，
// 于是每次热重载都会把最早的一批键重新扫一遍 —— 实测一次启动回扫 160+ 条
// `not modified` 编辑/每 Bot，既拖慢补扫又白占 Telegram 限流额度。
// 上限必须覆盖 protoMap（含 :status: 时约 800），否则“已处理”永远装不下。
const STRIP_KB_MAX = 1000
const COMMAND_CACHE_MAX_AGE_MS = 6 * 60 * 60_000
// R2666：循环注入/额度尾恢复成功后，桥额外发一条可见 TG 短消息（卡片编辑是静默的）。
// R2667：压缩提示统一格式，并拦掉同一场压缩的迟到观测（api 滞留 / ctxdrop 重复）。
// R2682：仅标题合并链锚点已不在聊天底部时，改为重新堆叠（新卡到底部）。
// R2702：重堆时计数从 1 重新开始，不再继承上一条链的累计次数。
// R2683：合并链与最新 message_id 落盘，热重载/重启后能接着原卡堆叠。
const VERSION = "r2733-egress-notice"

// ---------------------------------------------------------------------------
// 每实例配置（多 Bot 隔离的核心）
//
// 为什么不用 process.env 传配置：插件入口热重载会**重新求值整个模块图**，
// 上一次为备用 Bot 设置的 env 会被“主实例”继承 → 两个实例同 token 轮询
// → getUpdates 409 风暴 + 状态互相覆盖。实测踩过，因此改为显式传参。
//
// 每个 Bot 通过 cache-bust 动态 import 拿到独立的模块实例，再调用
// configureBot() 写入自己的 token/路径/代号，之后互不干扰。
// ---------------------------------------------------------------------------
export type BotConfig = {
  id?: string
  /** 用户可见名（通常是 @username）；只用于菜单/状态卡，不参与状态文件命名。 */
  label?: string
  token?: string
  fallbackToken?: string
  allowedChats?: string
  pushChat?: string
  configPath?: string
  fallbackEnvPath?: string | null
  statePath?: string
  ownerPath?: string
  commandCachePath?: string
  stripStatePath?: string
  stripFailPath?: string
  tapPath?: string
  genKey?: string
  /** 新实例没有自己的 front 时，继承一个起始会话（否则会一直“无法解析目标会话”） */
  initialFront?: string
  /** 是否拥有“队列置顶卡”。同一 chat 里只能有一个 owner：Telegram 不允许跨 Bot 编辑
   *  别人的消息，两个 Bot 各自建卡会互相 400 + 出现两条队列消息。 */
  queueCardOwner?: boolean
  /** 启动时的附加镜像列表。给非主实例传 [] 可避免继承到别人的 watch
   *  （否则备用 Bot 会镜像主会话，两个 Bot 交叉发言）。 */
  initialWatch?: string[]
  /** R1565 每轮「AI 主动结束输出」短提示开关。默认开；false 关。env TG_TURN_END_NOTIFY=0 等效。 */
  turnEndNotify?: boolean
  /** R1593 循环轮不发 note 开关。默认开；false 关（回退循环也发）。env TG_TURN_NOTE_LOOP_SKIP=0 等效。 */
  turnNoteLoopSkip?: boolean
  /** R1596 主实例独占 note 开关。默认开（只有主实例发）；false 关（每实例都发）。env TG_TURN_NOTE_OWNER_ONLY=0 等效。 */
  turnNoteOwnerOnly?: boolean
}

let CONFIG_PATH = `REDACTED_ROOT/.config/opencode/tg.env`
// 默认**关闭**备用投递通道（fail-closed）。
// 此前默认值就是那个 env 路径，于是"配置里没显式关掉"就等于"通道开着" —— 启动自检
// 实测主 Bot 的 fallbackApiBase=set，而用户明确要求过关闭备份发送机制。
// 现在只有入口显式传入 fallbackEnvPath 才会打开；两个 Bot 默认都只用自己的 token。
let FALLBACK_ENV_PATH: string | null = null
let STATE_PATH = `REDACTED_ROOT/.config/opencode/tg-chats.json`
let OWNER_PATH = "/tmp/opencode/tg-poll-owner.json"
let COMMAND_CACHE_PATH = "/tmp/opencode/tg-command-cache.json"
let STRIP_STATE_PATH = "/tmp/opencode/strip-run.json"
let STRIPFAIL_PATH = "/tmp/opencode/stripfail.json"
// R2570（D3）：backfillStrip 只在本实例启动 5s 后跑一次，扫描前就写入了 10 分钟
// 冷却时间戳。若这一跑撞上 429 限流，旧实现会 `break` 后把时间戳留在原地 ——
// 本进程不再重试（热重载后的新实例也会因 <10 分钟冷却直接跳过）⇒ 旧卡片的 ⏹
// 按钮可以一直清不掉（用户实报「有部分停止按钮没有删除」）。defer 时回收时间戳
// 并在限流结束后重试，冷却才不会吞掉这一次。
let stripRetryTimer: ReturnType<typeof setTimeout> | undefined
let TAP_PATH = "/tmp/opencode/v2plugin.log"
let GEN_KEY = "__tgBridgeGen"
let TOKEN = ""
let FALLBACK_TOKEN = ""
let fallbackApiBase = ""
let ALLOWED_RAW: string[] = []
let allowedNorm = new Set<string>()
let PUSH_RAW = ""
let PUSH_NORM = ""
let PUSH_CHAT = ""
let BOT_ID = "primary"
/** 用户可见名（registry label / @username）。内部状态文件仍用 BOT_ID，避免破坏已有会话绑定。 */
let BOT_LABEL = "primary"
// tool/shell part 停在 running 的时间戳（key → 首次进入 running 的时间）
const staleToolBorn = new Map<string, number>()
/**
 * 正在运行的工具卡专用索引：bare key（`ses:tool:<callID>`）→ {id, fallback, born}。
 *
 * 为什么不能只靠 protoMap：protoMap 是**全量消息映射**，size>200 的 GC 会删掉所有
 * `:input` 键、size>800 还会持续裁剪（实测本会话已涨到 801 条，裁剪分支常态触发）。
 * 而"永远执行中"的修复恰恰需要那张卡的 message id —— 一旦被 GC 抹掉，看门狗就
 * **结构性地**无从下手：卡片永远停在"执行中"，且日志里一条痕迹都没有（用户实测）。
 * 这里用一个**只装运行中工具卡**的小索引：不受 protoMap GC 影响，条目数天然有界
 * （工具一进终态即删除），超上限时留痕。
 */
const staleCardIdx = new Map<string, { id: number; fallback: boolean; born: number }>()
const STALE_CARD_IDX_MAX = 80
/**
 * 已完成工具键的软上限。protoMap 里每个 `:tool:` 键只在"改写那张卡"时有用，几分钟后
 * 就是纯垃圾。实测两侧共 704 个工具键把 protoMap 顶到 800 → `size>800` 的裁剪分支
 * 常态触发 → 连**正在运行**的 `:input` 键一起删掉，那正是"卡片永远执行中"的机制性
 * 原因（修复路径需要那张卡的 message id）。压住工具键数量即可让运行中的记录活下来。
 */
const TOOL_KEYS_MAX = 150
const capStaleCardIdx = (): number => {
  if (staleCardIdx.size <= STALE_CARD_IDX_MAX) return 0
  const keys = [...staleCardIdx.keys()].sort((a, b) => (staleCardIdx.get(a)?.born ?? 0) - (staleCardIdx.get(b)?.born ?? 0))
  const drop = keys.slice(0, staleCardIdx.size - STALE_CARD_IDX_MAX)
  for (const k of drop) staleCardIdx.delete(k)
  return drop.length
}
let QUEUE_CARD_OWNER = true
// R1091: 允许各实例自建/自管自己的队列置顶卡（用户确认：三 bot 各置顶自己的队列/状态卡）。
// 独立开关而非复用 QUEUE_CARD_OWNER —— QUEUE_CARD_OWNER 还承载 ownsAsk/scopeOwn 语义
//（主实例=跟随前台 + 兜底询问），放开它会让非主实例抢答。env TG_SELF_QUEUE_PIN=0 可关。
const ALLOW_SELF_QUEUE_PIN = process.env.TG_SELF_QUEUE_PIN !== "0"
// R1565 每轮「AI 主动结束输出」短提示开关：默认开，env TG_TURN_END_NOTIFY=0 或
// configureBot 传 turnEndNotify:false 可关（与 turn-end-note.ts 文案配套）。
let TURN_END_NOTIFY = process.env.TG_TURN_END_NOTIFY !== "0"
// R1593：循环轮（已完成消息文本含 [ROUND n]）**不发** note——用户真实反馈
//「本轮完成刷屏」（实测近 5min 三 bot 合并 39 条 note ≈4 条/分钟）。默认开（跳过
// 循环轮，仅非循环手动轮发「✅ 输出结束」）；env TG_TURN_NOTE_LOOP_SKIP=0 或
// configureBot 传 turnNoteLoopSkip:false 可回退旧行为（循环也发）。
let TURN_NOTE_LOOP_SKIP = process.env.TG_TURN_NOTE_LOOP_SKIP !== "0"
// R1596：turn-end note 只由主实例（QUEUE_CARD_OWNER，index 0）发。alt/bot3 实例的 front
// 是各自项目的真实会话（proxyip / robin 等），不喝本循环注入 → R1595 续跑检测对它们
// 恒 false → 各自项目回合一结束就发，跨 bot 刷屏。默认开；env TG_TURN_NOTE_OWNER_ONLY=0
// 或 configureBot 传 turnNoteOwnerOnly:false 可回到每实例都发。
let TURN_NOTE_OWNER_ONLY = process.env.TG_TURN_NOTE_OWNER_ONLY !== "0"
// R2672（运营者："不要保留，不能直接询问要不要循环吗，做好功能联动"）：
// turn-end note 不再有任何安静窗。回合终态确认且正文已投递后立即发；文案直接询问
// 本会话要不要继续循环，按钮写真实的会话级循环状态（见 turnEndKeyboard / te: 回调）。
// 历史 R1597/R2648 的 120s 观察窗已删除 —— 循环中也不会再拖 2 分钟。
const PROTO_RETRY_MAX_ATTEMPTS = Number(process.env.TG_PROTO_RETRY_MAX_ATTEMPTS ?? "") || 240 // R714 重试总额度（240 次 ≈ 2h）：Telegram rawRetryAfter 实测 4631s，900s 封顶会多轮重装；48 次（≈22min）仍可能在原始冷却结束前丢消息
// R431（「乱序消息再次出现」的传输层根因收敛）：瞬时失败（网络异常/5xx）首次重试从 5s 提前到
// 0.6s —— 迟到窗口越小，期间新消息抢先送达造成的时钟倒挂越少。429 仍用原 5s 首拍（尊重
// flood gate / retry_after）；后续退避不变（5s×attempt）。可用 TG_PROTO_RETRY_QUICK_MS 覆盖。
const PROTO_RETRY_QUICK_MS = Number(process.env.TG_PROTO_RETRY_QUICK_MS ?? "") || 600
// R2558（D3/D4，429 循环）：冷却期内新消息会全部堆进 protoRetry（实测一次积压 42 条）。
// 冷却结束后若仍按 1.2s/条 集中补发（≈50/min），会立刻再次触发 Telegram 限流，
// 形成 900s→174s→… 的循环。给同一 chat 的补发加最小间隔：默认 3.2s（≈18/min，
// 低于群聊 20/min 上限），可用 TG_PROTO_RETRY_GAP_MS 调整。
const PROTO_RETRY_GAP_MS = Math.max(1_000, Number(process.env.TG_PROTO_RETRY_GAP_MS ?? "") || 3_200)
// R-2026-10-19 补发标注降噪（运营者实报「补发也太多了」）：catchup 补推常见迟到仅数秒~25s，
// R276 的「（补发 …）」括注在高频补推时刷屏。现仅当迟到 ≥ LATE_NOTE_MIN_MS 才显示括注；
// 阈值内补推**仍改写标题时钟**（发送顺序单调不变，R276 初衷保留）。可用 TG_LATE_NOTE_MIN_MS 调整。
const LATE_NOTE_MIN_MS = Number(process.env.TG_LATE_NOTE_MIN_MS ?? "") || 60_000

const loadFileEnv = (path?: string | null): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!path) return out
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
      if (m) out[m[1]] = m[2]
    }
  } catch {
    /* no file */
  }
  return out
}

const harden = (path: string): void => {
  try {
    chmodSync(path, PRIVATE_FILE_MODE)
  } catch {
    /* first run; creation below uses mode 0600 */
  }
}

const recomputeIdentity = (): void => {
  TOKEN = process.env.TG_BOT_TOKEN ?? TOKEN
  FALLBACK_TOKEN = process.env.TG_FALLBACK_BOT_TOKEN ?? FALLBACK_TOKEN
  fallbackApiBase = FALLBACK_TOKEN ? `https://api.telegram.org/bot${FALLBACK_TOKEN}` : ""
  const allowed = process.env.TG_ALLOWED_CHAT
  if (typeof allowed === "string" && allowed !== "") {
    ALLOWED_RAW = allowed.split(",").map((s) => s.trim()).filter(Boolean)
  }
  allowedNorm = new Set(ALLOWED_RAW.map((s) => s.replace(/^@/, "")))
  PUSH_RAW = process.env.TG_PUSH_CHAT ?? PUSH_RAW ?? ALLOWED_RAW[0] ?? ""
  PUSH_NORM = PUSH_RAW.replace(/^@/, "")
  PUSH_CHAT = PUSH_RAW
}

/** 显式配置本模块实例代表的 Bot。必须在 TgBridgePlugin() 之前调用。 */
/**
 * R1829：`/use` 目标「是否存在」的判定（纯函数，便于回归）。
 * 返回 true = 接受该 id；false = 明确不存在 → 调用方应报错且**不改动**当前目标。
 * 保守放行策略：`listOk=false`（会话列表查询失败）或 `knownIds` 为空时不阻断，
 * 以免把「拉不到列表」误判成「会话不存在」而拒绝一个有效 id。
 */
export const sessionIdAcceptable = (id: string, knownIds: readonly string[], listOk: boolean): boolean => {
  if (!String(id).startsWith("ses_")) return false
  if (!listOk) return true
  if (knownIds.length === 0) return true
  return knownIds.includes(id)
}

/**
 * R1876：**未认领会话**（本实例没有 front / fixedTarget）时，谁负责投递。
 * 单 Bot 时代恒真（谁在跑谁发）；多 Bot 时代只有**主实例**（QUEUE_CARD_OWNER）兜底 ——
 * 否则每个"front 为空"的实例都会把全局事件流里的任意会话当自己的主目标**全量推送**，
 * 多实例并存即跨 Bot 串台/重复。与 `ownsAsk` 的"都不负责时由主实例兜底"是同一条规则
 * （ownsAsk = isPrimaryPush || isWatched || QUEUE_CARD_OWNER）。
 */
export const unownedFrontOwner = (queueCardOwner: boolean): boolean => queueCardOwner

export const configureBot = (cfg: BotConfig, opts: { deferLoad?: boolean } = {}): void => {
  if (cfg.id) BOT_ID = cfg.id
  BOT_LABEL = cfg.label?.trim() || BOT_ID
  if (typeof cfg.queueCardOwner === "boolean") QUEUE_CARD_OWNER = cfg.queueCardOwner
  if (typeof cfg.turnEndNotify === "boolean") TURN_END_NOTIFY = cfg.turnEndNotify
  if (typeof cfg.turnNoteLoopSkip === "boolean") TURN_NOTE_LOOP_SKIP = cfg.turnNoteLoopSkip
  if (typeof cfg.turnNoteOwnerOnly === "boolean") TURN_NOTE_OWNER_ONLY = cfg.turnNoteOwnerOnly
  if (cfg.genKey) GEN_KEY = cfg.genKey
  if (cfg.configPath) CONFIG_PATH = cfg.configPath
  if (cfg.fallbackEnvPath !== undefined) FALLBACK_ENV_PATH = cfg.fallbackEnvPath
  if (cfg.statePath) STATE_PATH = cfg.statePath
  if (cfg.ownerPath) OWNER_PATH = cfg.ownerPath
  if (cfg.commandCachePath) COMMAND_CACHE_PATH = cfg.commandCachePath
  if (cfg.stripStatePath) STRIP_STATE_PATH = cfg.stripStatePath
  if (cfg.stripFailPath) STRIPFAIL_PATH = cfg.stripFailPath
  if (cfg.tapPath) TAP_PATH = cfg.tapPath
  const env = { ...loadFileEnv(CONFIG_PATH), ...loadFileEnv(FALLBACK_ENV_PATH) }
  if (typeof cfg.token === "string") TOKEN = cfg.token
  else TOKEN = env.TG_BOT_TOKEN ?? ""
  if (typeof cfg.fallbackToken === "string") FALLBACK_TOKEN = cfg.fallbackToken
  else FALLBACK_TOKEN = FALLBACK_ENV_PATH ? env.TG_FALLBACK_BOT_TOKEN ?? "" : ""
  if (typeof cfg.allowedChats === "string") {
    ALLOWED_RAW = cfg.allowedChats.split(",").map((s) => s.trim()).filter(Boolean)
  } else {
    ALLOWED_RAW = (env.TG_ALLOWED_CHAT ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  }
  PUSH_RAW = cfg.pushChat ?? env.TG_PUSH_CHAT ?? ALLOWED_RAW[0] ?? ""
  PUSH_NORM = PUSH_RAW.replace(/^@/, "")
  PUSH_CHAT = PUSH_RAW
  FALLBACK_TOKEN = FALLBACK_TOKEN ?? ""
  fallbackApiBase = FALLBACK_TOKEN ? `https://api.telegram.org/bot${FALLBACK_TOKEN}` : ""
  allowedNorm = new Set(ALLOWED_RAW.map((s) => s.replace(/^@/, "")))
  for (const p of [STATE_PATH, COMMAND_CACHE_PATH, STRIP_STATE_PATH, STRIPFAIL_PATH]) harden(p)
  // 由入口显式配置的实例（备用 Bot）：此时本模块已求值完，可以安全加载状态。
  // 用微任务延后，避开模块顶层 TDZ（loadPersistedState 是后面才定义的 const）。
  if (opts.deferLoad !== false) {
    try {
      queueMicrotask(() => {
        try {
          loadPersistedState()
        } catch {
          /* best-effort */
        }
        // 新实例没有任何 front 时用传入的起始会话兜底（之后完全由自己的 /use 管）
        if (!QUEUE_CARD_OWNER && !ALLOW_SELF_QUEUE_PIN && queuePin.size > 0) {
          // 非 owner 且未启用自建：不管理队列卡，丢掉历史遗留的卡 id（R1091 前旧行为）
          queuePin.clear()
          queuePinOn.clear()
          try {
            savePersistedState()
          } catch {
            /* best-effort */
          }
        }
        if (Array.isArray(cfg.initialWatch)) {
          watchedSessions.clear()
          for (const v of cfg.initialWatch.slice(0, WATCH_MAX)) {
            if (/^ses_[A-Za-z0-9_-]+$/.test(v)) watchedSessions.add(v)
          }
          watchSnapshot = [...watchedSessions]
          // 必须落盘：syncPersistedTarget 每轮都会按文件对齐，否则文件里残留的
          // watch 会在下一次 tick 把这里清掉的列表又读回来（备用 Bot 又去镜像主会话）。
          try {
            savePersistedState()
          } catch {
            /* best-effort */
          }
        }
        // 自己就是目标时不需要（也无法）再 watch 自己
        if (persistedFront && watchedSessions.has(persistedFront)) {
          watchedSessions.delete(persistedFront)
          watchSnapshot = [...watchedSessions]
          try {
            savePersistedState()
          } catch {
            /* best-effort */
          }
        }
        if (cfg.initialFront && !persistedFront) {
          persistedFront = cfg.initialFront
          try {
            savePersistedState()
          } catch {
            /* best-effort */
          }
        }
      })
    } catch {
      /* best-effort */
    }
  }
}

// 本模块实例的身份：入口用 `?bot=<id>&v=<hash>` 动态 import 取得独立实例。
// 带 bot 参数的实例**不能在 import 阶段加载默认状态**（那是主实例的路径），
// 必须等入口调用 configureBot() 指定自己的路径后再加载。
const BOOTSTRAP_BOT = (() => {
  try {
    return new URL(import.meta.url).searchParams.get("bot") ?? ""
  } catch {
    return ""
  }
})()

// 直接 import（主实例 / 手工加载）：完全保持既有行为
if (!BOOTSTRAP_BOT) configureBot({}, { deferLoad: false })

let knownNumericChatIDs = new Map<string, string>()
let persistedOffset = 0
// 本 Bot 真实处理过的最大 update_id（持久化）
let lastRealUpdateId = 0
try {
  chmodSync(STRIPFAIL_PATH, PRIVATE_FILE_MODE)
} catch {
  /* first run; creation below uses mode 0600 */
}
const persistStripFail = (): void => {
  try {
    const entries = [...stripFail.entries()].slice(-200)
    const out: Record<string, unknown> = Object.fromEntries(entries)
    // 顺带存"已处理"集合。为什么要落盘：热重载会清空内存里的 strippedKb，于是**每次重载后
    // 下一轮剥离回填都要重走同一批遗留消息** —— 实测 2 小时内 18 轮 × 约 64 条 ≈ 1150 次
    // 无用的 editMessage 调用，其中 33 次升级成 error 级超时。那是我自己频繁重载**放大**出来的。
    // protoMap 的键是从持久化状态恢复的（j.proto，跨重载稳定），所以这个集合落盘后真的能命中。
    out.__stripped = [...strippedKb].slice(-STRIP_KB_MAX)
    writeFileSync(STRIPFAIL_PATH, JSON.stringify(out), { encoding: "utf8", mode: PRIVATE_FILE_MODE })
  } catch {
    /* best-effort */
  }
}
try {
  chmodSync(OWNER_PATH, PRIVATE_FILE_MODE)
} catch {
  /* first run; creation below uses mode 0600 */
}
const OWNER_STALE_MS = 60_000
// 每个 Bot 实例一个独立的代号命名空间：多 Bot 同进程并存时，后加载的实例
// 不能把先加载的实例判成“过期实例”并抢走它的轮询。
// R1869：真实 update_id 去重环容量。**内存 / 落盘 / 读回必须同源** —— 旧实现内存硬上限
// 500（超限 trim 回落到 300），但落盘与读回都写死 `.slice(-300)`：热重载后环会静默缩水
// 最多 200 个 id。落在被截窗口里的重投 update 会被**再次处理**（"同一条命令触发两次"）。
// 注意：合成事件（菜单）不入环（见 handleUpdateInner），故这里只装真实 update_id。
const SEEN_RING_MAX = 500
const SEEN_RING_KEEP = 300
const seenUpdates = new Set<number>()
type FilterMode = 0 | 1 | 2
// 推送过滤：0=不发，1=只发标题行，2=正常发送
const filters: Record<"reply" | "think" | "tool" | "status", FilterMode> = { reply: 2, think: 2, tool: 2, status: 2 }
// R2674：仅标题连续卡合并是**本 Bot 的推送显示设置**（与 filters 同一张菜单、同一份状态文件）。
// 旧版（R2673）误用了跨 Bot 共享的 title-merge-mode.json → bot A 的开关会改到 bot B。
// 现在读写各自 tg-chats[-<id>].json 的 titleMerge 字段；菜单切换后本实例下一张卡即生效。
let titleMergeOn = false
// 旧版全局开关只用于**一次性迁移**：状态文件还没有 titleMerge 字段时，沿用旧值，
// 下一次 savePersistedState 会把结果写进本 Bot 自己的文件。之后各 Bot 完全独立。
const LEGACY_TITLE_MERGE_MODE_PATH = `REDACTED_ROOT/.config/opencode/title-merge-mode.json`
const legacyTitleMergeSeed = (): boolean => {
  try {
    const j = JSON.parse(readFileSync(LEGACY_TITLE_MERGE_MODE_PATH, "utf8")) as any
    return j?.mode === "on"
  } catch {
    return false
  }
}
const filt = (k: "reply" | "think" | "tool" | "status"): FilterMode => filters[k] ?? 2
const setFilt = (k: "reply" | "think" | "tool" | "status", v: number): void => {
  filters[k] = v === 0 ? 0 : v === 1 ? 1 : 2
  savePersistedState()
}
// 压缩设置（/quiet 菜单可调，auto-continue 侧实时读取）：auto=false 停掉一切自动压缩尝试；threshold 为 ctx 水位门控
// R719：notice = 「🗜 上下文已压缩」通知卡片是否发送（用户点名要的选项；默认开=保持原行为）。
const compactPrefs: { auto: boolean; threshold: number; notice: boolean } = { auto: true, threshold: 0.7, notice: true }
const COMPACT_TH_STEPS = [0.6, 0.7, 0.8, 0.9] as const
const errorRing: Array<{ ts: number; msg: string }> = []
const dropRing: Array<{ ts: number; kind: string; detail: string }> = []
const noteError = (msg: string): void => {
  try {
    errorRing.push({ ts: Date.now(), msg: String(msg ?? "").slice(0, 300) })
    if (errorRing.length > 30) errorRing.splice(0, errorRing.length - 30)
  } catch {
    /* ignore */
  }
}
const noteDrop = (kind: string, detail: string): void => {
  try {
    dropRing.push({ ts: Date.now(), kind, detail: String(detail ?? "").slice(0, 200) })
    if (dropRing.length > 20) dropRing.splice(0, dropRing.length - 20)
  } catch {
    /* ignore */
  }
}
const claimPollOwner = (id: string, kind: string): void => {
  try {
    let current: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(readFileSync(OWNER_PATH, "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed
    } catch {
      /* first run */
    }
    current[kind] = { id, ts: Date.now() }
    // R1849：OWNER_PATH 被 tg-bridge 多实例与 auto-continue 跨进程读写（`amPollOwner`/
    // `readPollOwner` 都 `JSON.parse`）；裸写有 O_TRUNC 窗口，读侧 parse 失败会误判
    // "无主" → 重复抢主。改用 atomicWrite（tmp+rename）。
    atomicWrite(OWNER_PATH, JSON.stringify(current), PRIVATE_FILE_MODE)
  } catch {
    /* best-effort */
  }
}
const amPollOwner = (id: string, kind: string): boolean => {
  try {
    const j = JSON.parse(readFileSync(OWNER_PATH, "utf8")) as any
    const cur = j?.[kind]
    if (!cur || typeof cur.id !== "string") {
      claimPollOwner(id, kind)
      return true
    }
    if (cur.id === id) return true
    // stale owner (>OWNER_STALE_MS without heartbeat) → take over (crash safety)
    if (typeof cur.ts === "number" && Date.now() - cur.ts > OWNER_STALE_MS) {
      claimPollOwner(id, kind)
      return true
    }
    return false
  } catch {
    claimPollOwner(id, kind)
    return true
  }
}
const pushChatResolve = (): string => {
  const fromMap = knownNumericChatIDs.get(PUSH_NORM)
  return fromMap ?? PUSH_CHAT
}
const syncPersistedTarget = (): void => {
  try {
    const j = JSON.parse(readFileSync(STATE_PATH, "utf8")) as any
    const front = typeof j?.front === "string" && j.front.startsWith("ses_") ? j.front : persistedFront
    const pinned = typeof j?.pinned === "string" && j.pinned.startsWith("ses_") ? j.pinned : undefined
    if (front !== persistedFront || pinned !== fixedTarget) {
      persistedFront = front
      fixedTarget = pinned
    }
    // 附加镜像集合也以状态文件为准：tg-chats.json 是 tg-bridge/auto-continue
    // 共享的真值来源，外部改动（含热重载前写入）必须被采纳，否则会在下一次
    // savePersistedState 时被内存旧值覆盖。
    if (Array.isArray(j?.watch)) {
      const next = j.watch.filter((v: unknown): v is string => typeof v === "string" && /^ses_[A-Za-z0-9_-]+$/.test(v)).slice(0, WATCH_MAX)
      if (next.length !== watchedSessions.size || next.some((v: string) => !watchedSessions.has(v))) {
        watchedSessions.clear()
        for (const v of next) watchedSessions.add(v)
        watchSnapshot = [...watchedSessions]
        try {
          watchSyncHook?.([...watchedSessions])
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    /* keep in-memory target */
  }
}
const protoOwned = new Set<string>()
const sentParts = new Map<string, string>()
const sentHash = new Set<string>()
const lastRound = new Map<string, string>()
const hashText = (s: string): string => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(16)
}
const INTERNAL_PREFIXES = ["[tg-bridge]", "[auto-continue]"]
const isInternalLog = (t: string): boolean => {
  const s = String(t ?? "").trimStart()
  return INTERNAL_PREFIXES.some((p) => s.startsWith(p))
}
// runningAt：进入 running 的时刻（0 = 非运行）。落盘后重启仍能认出"哪些卡停在执行中"。
type ProtoCache = { id: number; text: string; fallback?: boolean; runningAt?: number }
const protoChat = new Map<string, number>()
const protoMap = new Map<string, ProtoCache>()
/**
 * R2673：每个 chat 当前「仅标题合并」链条。
 * 只记录**最近一条已发出的仅标题卡**；下一次同会话、同种类的仅标题卡到来时
 * 改写这条消息（时间取新卡、末尾累计 `（×n）`），而不是另发一条。
 * 任何新的非仅标题卡（回复正文/错误/问询/压缩）都会把链条清掉。
 */
type TitleMergeChain = { sid: string; kind: string; key: string; id: number; count: number; fallback: boolean }
const titleMergeChains = new Map<string, TitleMergeChain>()
/**
 * R2682：每个 chat 已知的最新 message_id。只用来判断合并链锚点还在不在底部；
 * 用户消息、其它 Bot 的卡、本实例发出的任何 sendMessage 都会推进它。
 * 只是内存观测值（不落盘）：未知时按旧行为原地合并，绝不凭空多发。
 */
const lastChatMessageIds = new Map<string, number>()
const noteLatestChatMessage = (chatID: unknown, messageID: unknown): boolean => {
  const c = String(chatID ?? "")
  const id = Math.floor(Number(messageID) || 0)
  if (!c || id <= 0) return false
  if (id <= (lastChatMessageIds.get(c) ?? 0)) return false
  lastChatMessageIds.set(c, id)
  // 只服务标题合并，条目数不需要无限增长；超出就丢最早见过的 chat。
  if (lastChatMessageIds.size > 200) {
    const oldest = lastChatMessageIds.keys().next().value
    if (typeof oldest === "string") lastChatMessageIds.delete(oldest)
  }
  return true
}
const forEachProto = (sessionID: string, fn: (k: string) => void): void => {
  for (const k of [...protoMap.keys()]) if (k.startsWith(sessionID)) fn(k)
}
const protoClear = (sessionID: string): void => {
  forEachProto(sessionID, (k) => protoMap.delete(k))
  for (const k of [...sentParts.keys()]) if (k.startsWith(`${sessionID}:`)) sentParts.delete(k)
  protoOwned.delete(sessionID)
}
const shouldSend = (key: string, text: string): boolean => {
  const prev = sentParts.get(key)
  if (prev === text) return false
  if (sentParts.size > 2000) {
    const toolKeys = [...sentParts.keys()].filter((k) => k.includes(":tool:"))
    for (const k of toolKeys.slice(0, Math.max(100, toolKeys.length / 2))) sentParts.delete(k)
    for (const k of [...sentParts.keys()].slice(0, 100)) sentParts.delete(k)
  }
  sentParts.set(key, text)
  return true
}
const outQueue: Array<{ chat: string; text: string; ts: number; kb?: unknown; replyTo?: number }> = []
// 置顶注入队列（用户→会话方向）：串行注入 + 注入提示；持久化，重启可恢复（/queue 置顶查看）
type PinItem = { id: string; sid: string; text: string; ctx: string; chat: string; ts: number; tgMid?: number }
const pinQueue: PinItem[] = []
const pumping = new Set<string>()
const PINQ_MAX = 30
let pinRestorePending = 0
// 注入进行中的条目：注入期间它**不在 pinqueue 里**，落盘也单独放（pininflight）。
// 这样"注入途中崩溃/实例换代"不会让下一个实例再次注入它 —— at-most-once。
// 失败时条目会移回 pinqueue（用户可见、可重试），成功则丢弃。
const pinInFlight: PinItem[] = []
// 重启后被丢弃的队列条目数（诊断用；>0 说明有内容在重启中消失）
let pinRestoreDropped = 0
// 队列恢复阶段的诊断文件（模块作用域可用）
const RESTORE_DIAG_PATH = "/tmp/opencode/tg-bridge-restore.log"

/**
 * 模块作用域专用的诊断出口（appendFileSync 到可 grep 的文件）。
 *
 * 为什么不用工厂里的 `log()`：模块作用域与工厂作用域**不共享**名字，在模块级调
 * `log()` 是 ReferenceError；而这些诊断点几乎都包在自己的 try/catch 里，异常被吞掉
 * → **症状可见、日志全无**（本项目已在三处重复踩到：noteUsage 的 ctx 守卫、恢复时
 * 丢弃队列条目、陈旧写者跳过保存）。文件通道不依赖任何作用域，且可事后取证。
 */
const diag = (msg: string): void => {
  try {
    appendFileSync(RESTORE_DIAG_PATH, `${new Date().toISOString()} ${redactSecrets(msg)}\n`, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
    })
  } catch {
    /* best-effort */
  }
}

/**
 * 从 tool part 里取 callID（模块级）。
 *
 * 之前它定义在 `protoPushAssistantMessage` **函数内部**，却被 `fetchToolStates`、
 * `/healcards`、启动补登记三处外部使用 → 三处全是 ReferenceError。而
 * `fetchToolStates` 的 ReferenceError 又被它自己的 `catch { return out }` 吞掉
 * → 返回**空状态表** → 对账永远判定"状态未知"。也就是说"按真相纠正"这个功能
 * **从未真正生效过**（两次对账日志都打成了 real=unknown）。
 */
const callOf = (p: any): string => String(p?.callID ?? p?.id ?? p?.callId ?? "unknown")

/**
 * 对账用的**终态卡片**渲染器（模块级）。
 *
 * 为什么需要它：本宿主**工具跑完时不发完成事件**（实测：chain 事件只到"工具还在跑"
 * 为止，之后宿主静默），所以看门狗对账不是"兜底"而是**主路径**。旧实现只用一行
 * "✅ 已完成（卡片状态已按真实状态纠正）"**覆盖**整张卡 → 命令与输出全丢
 * （用户反馈"完成后也不会显示内容"）。这里按真实 part 重渲染：标题 + 输入 + 输出
 * 尾部 + 状态行 + 一句诚实的纠正说明。
 */
/**
 * 算出"这次该取消置顶/清理哪些消息 id"——**纯函数**，可单测。
 * 为什么要抽出来：修复"置顶越堆越多"的根因是让**历史上钉过的每一条**都被取消，
 * 而静态守卫只能钉住代码形状、钉不住"真的每个 id 都会走到 unpin"。
 * 抽成纯函数后这条不变量能被**证明**（bun 单测），而不是只能被相信。
 * ⚠️ 必须放在**模块级**：clearQueuePinCard 在工厂函数内部，
 *    在那里写 `export const` 会报 `Unexpected export`（今天已踩过一次，patch.sh 拦下）。
 */
export const planQueuePinCleanup = (current: number | undefined, hist: readonly number[]): number[] => [
  ...new Set([...(current !== undefined ? [current] : []), ...hist]),
]

/**
 * R249：UTF-16 安全截断（防乱码「U+FFFD」）。
 * 裸 `slice(0,n)` 若切在 emoji 等代理对中间会产生**孤立代理字符**，JSON→Telegram 渲染为 U+FFFD。
 * safeCut：头部截断；切点前一字符为高位代理 D800-DBFF 时回退 1（丢弃半个代理对）。
 * safeTail：尾部截断（取末尾 n 字符）；起点字符为低位代理 DC00-DFFF 时前移 1。
 */
const safeCut = (s: string, n: number): string => {
  if (s.length <= n) return s
  let c = n
  if (c > 0) {
    const code = s.charCodeAt(c - 1)
    if (code >= 0xd800 && code <= 0xdbff) c -= 1
  }
  return s.slice(0, c)
}
const safeTail = (s: string, n: number): string => {
  if (s.length <= n) return s
  let start = s.length - n
  const code = s.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start += 1
  return s.slice(start)
}

export const renderToolTerminalCard = (sessionID: string, part: any, status: string, mins: number): string => {
  const st = part?.state ?? {}
  const name = clean(part?.tool ?? "tool", 40)
  const disp = name.charAt(0).toUpperCase() + name.slice(1)
  const created = Number(part?.time?.created ?? 0)
  const clock = created > 0 ? fmtClock(created) : ""
  const rawIn = st.input ?? st.input_text ?? st.arguments ?? st.args
  const inText = typeof rawIn === "string" ? rawIn : rawIn ? JSON.stringify(rawIn) : ""
  const outText = typeof st.output === "string" ? st.output : st.output ? JSON.stringify(st.output) : ""
  const errText = typeof st.error === "string" ? st.error : ""
  const box = (lang: string, code: string): string =>
    `<blockquote><pre><code${lang ? ` class="language-${lang}"` : ""}>${htmlEsc(code)}</code></pre></blockquote>`
  const OUT_TAIL = 900
  const IN_TAIL = 600
  const outTail = outText.length > OUT_TAIL ? safeCut(outText, 120) + "\n…（略）…\n" + safeTail(outText, OUT_TAIL) : outText
  const inTail = inText.length > IN_TAIL ? safeCut(inText, IN_TAIL) + "\n…（略）…" : inText
  const lines: string[] = [`<b>🔧 ${htmlEsc(disp)} 执行 · 开始 ${clock}${htmlEsc(ctxSuffix(sessionID))}</b>`]
  // ① edit 类工具补 diff 区（与事件路径 inputZone 的形状对齐：📥 变更 + language-diff）
  const rawInObj = (rawIn && typeof rawIn === "object" ? rawIn : {}) as Record<string, unknown>
  const oldStr = (rawInObj.oldString ?? (st.metadata as any)?.oldString) as string | undefined
  const newStr = (rawInObj.newString ?? (st.metadata as any)?.newString) as string | undefined
  const isEditLike = /^(edit|write|patch|multiedit|apply_patch|str_replace)$/i.test(name)
  const diffBody =
    isEditLike && (typeof oldStr === "string" || typeof newStr === "string")
      ? `--- a\n${safeCut(oldStr ?? "", 600)}\n+++ b\n${safeCut(newStr ?? "", 600)}`
      : ""
  // ② 语言标记：结构化入参/输出按 JSON 上色（原先三处 box("") → 高亮全丢，探针实测 language-* = 0）
  const looksJson = (t: string): boolean => /^[\s]*[[{]/.test(t)
  const inLang = typeof rawIn === "string" ? "" : looksJson(inText) ? "json" : ""
  const outLang = looksJson(outText) ? "json" : ""
  if (diffBody) lines.push("\n📥 变更\n" + box("diff", diffBody))
  else if (inTail) lines.push("\n📥 入参\n" + box(inLang, inTail))
  if (outTail) lines.push("\n📤 输出\n" + box(outLang, outTail))
  if (errText) lines.push("\n" + box("", safeCut(errText, 500)))
  // 与**正常卡**结构对齐（用户反馈过"格式完全坏掉"）：正常卡以 DIV + statusLine 收尾，
  // 这里用同样的分隔线与同样带 exit 的措辞，避免两条路径产出两种长相。
  const exit = st?.metadata?.exit
  const exitS = exit != null ? ` (exit ${exit})` : ""
  lines.push(`\n━━━━━━━━━━━━━━━\n${toolStatusLabel(status, exit)}`)
  lines.push(
    `\n<i>本宿主不主动发工具完成事件，此卡片由看门狗按会话真实状态于 ${mins} 分钟前纠正；内容取自会话记录，非推测。</i>`,
  )
  return balanceHtmlTags(lines.join("\n"))
}
// 注入时机：now=默认立即注入（opencode 默认行为）；idle=等 AI 本轮完全结束再注入
let injectMode: "now" | "idle" = "now"
const busyTurn = new Set<string>()
const IDLE_POLL_MS = 3000
// 队列置顶条：有积压置顶一条显示条数（只改原文不重发），排空即取消置顶并删除
const queuePin = new Map<string, number>()
const queuePinHist: number[] = []
// 队列卡当前是否处于“已置顶”状态（排空时只取消置顶并保留消息复用）
const queuePinOn = new Map<string, boolean>()
let lastQPinCount = -1
let lastQPinEdit = 0
// R2574（D7）：置顶队列卡的去重键从「条数」改为「完整文案」。
// 旧实现只比条数，队列条数不变时状态行（进行中/完成/错误）永远不重算 → 卡面长期停在旧状态。
let lastQPinText = ""
let lastQPinStatusAt = 0
// 条数不变时也至少每 30s 重算一次状态行；refreshQueuePin 自带 3s 工作间隔与 5s 编辑节流。
const QPIN_STATUS_TTL_MS = 30_000
// 长轮询超时的日志节流（超时常态，不该每秒刷一条）
let pollTimeoutLogAt = 0
// R1740：入站静默判据的状态。放模块级（不是 pollOnce 闭包内）—— 闭包内的变量
// 每次插件换代都会被重置，而静默判据恰恰需要跨"没有 update"的那些轮次累积。
let lastInboundAt = 0
let lastInboundSilentWarnAt = 0
// R1741：bootAt —— 判据的**第三基线**。没有它，"重启后一直无人发言"这个最常见的
// 静默形态会让判据返回 basis:none 并永久放弃监控（详见 inbound-silence.ts 注释）。
let botBootAt = 0
// R1743：同伴入站时间（跨 bot 共享）。判别「用户安静」与「我这路坏了」的**唯一**信号
// —— 别的 bot 收到了而我没收到。纯时长做不到（同形，见 inbound-silence.ts 注释）。
const PEER_INBOUND_PATH = "/tmp/opencode/tg-peer-inbound.json"
// R1759：账本升级为两字段。**混用一个字段会同时产生假阴和假阳**：
//   in  = 我真收到 update 的时刻（poll 活着不代表收到了！长轮询 30s 空返回是常态）
//   seen= 同伴最后一次【刷新账本】的时刻（= 它 poll 还活着）
// 若只留一个字段并用 touchPeer 刷新它：
//   - 假阴：收不到消息的 bot 读不到同伴领先 → 永远不报（R1757 死结）
//   - 假阳：同伴"poll 活着"被当成"同伴收到了" → 掩盖真实故障（R1759 反向问题）
// 所以判据只认 `in`，`seen` 仅用于诊断"该 bot 进程是否还活着"。
export type PeerLedger = Record<string, { in: number; seen: number }>
/**
 * R1843：把「待写入的账本」与「磁盘现状」**逐 bot 逐字段取 max** 合并。
 * in/seen 都是单调时间戳，取 max 是正确合并。为什么必须：
 * 账本是 **read-modify-write 且跨实例共享**（/tmp/opencode/tg-peer-inbound.json）。
 * A 读到旧账 → B 写入新账 → A 回写自己那份旧账，会把 B 刚写进去的 in 抹回去（丢更新）。
 * 取 max 合并后，丢更新**不可能**把时间戳改小。
 */
export const mergePeerLedgers = (base: PeerLedger, add: PeerLedger): PeerLedger => {
  const out: PeerLedger = { ...base }
  for (const [bot, v] of Object.entries(add)) {
    const cur = out[bot] ?? { in: 0, seen: 0 }
    out[bot] = { in: Math.max(cur.in, v.in), seen: Math.max(cur.seen, v.seen) }
  }
  return out
}
let peerLastInboundAt = 0
let peerWriteFailures = 0

/**
 * R1758：**每次 poll 返回都要调**（含空数组），把自己那一项刷新到"最近一次
 * 自称有入站"的时刻，并重算同伴最新值。
 *
 * 为什么必须独立于 noteInbound —— R1757 查到的**自我抑制死结**：
 *   原设计只在 `result.length > 0`（真收到消息）时调 noteInbound，于是
 *     primary/bot3 没收到消息 → 不调 → 从不读同伴账本 → peerLastInboundAt 恒 0
 *     → 判据落 no-peer → 不报
 *   而"没收到消息"恰恰是它最该报警的时刻。故障 bot 因此**永远沉默**。
 *
 * 关键设计（与"入站基线"严格区分，别混淆）：
 *   peers[BOT_ID] 记录的是"**我最近一次确认自己还在正常 poll**"的时刻，
 *   供**同伴**横向比较用；而 `lastInboundAt` 才是"**我真收到 update**"的时刻，
 *   供我自己纵向判断静默用。二者绝不能共用同一个字段——
 *   一旦共用，poll 正常就等于"有入站"，判据彻底失效（那正是 R1739 查不到的盲区）。
 *
 * 写入节流：poll 长轮询 30s 一次，3 bot → 每 30s 最多 3 次小 JSON 写入，
 * best-effort，失败只记 diag、不影响 poll。
 */
/**
 * R1759：账本读写统一入口。**两个函数必须走同一套格式处理** ——
 * 若 touchPeer 和 noteInbound 各写各的，格式一旦分叉就会出现
 * "A 写的字段 B 读不到"的静默失效（判据看着在跑，实际读到全0 = 又一次假绿）。
 * best-effort：任何异常都不得影响 poll。
 */
const readLedger = (): PeerLedger => {
  try {
    const j = JSON.parse(readFileSync(PEER_INBOUND_PATH, "utf8"))
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const raw = j as Record<string, unknown>
      const out: PeerLedger = {}
      for (const [bot, v] of Object.entries(raw)) {
        if (v && typeof v === "object") {
          const e = v as Record<string, unknown>
          out[bot] = { in: Number(e.in) || 0, seen: Number(e.seen) || 0 }
        } else if (typeof v === "number" && v > 0) {
          // R1759 迁移：兼容 R1758 的旧格式（值是裸 number，语义就是"真实入站时刻"）。
          // 不兼容的话，重载后 peerLastInboundAt 会瞬间归 0 → 落 no-peer → **漏报**，
          // 而故障 bot 恰恰最需要报警。那条时间戳是真实数据，没理由丢掉。
          out[bot] = { in: v, seen: v }
        }
      }
      return out
    }
  } catch {
    /* 首次或损坏，从空开始 */
  }
  return {}
}

/**
 * R1851：从账本取「**同伴（不含自己）**最新的真实入站时刻」。只认 in 字段
 * （R1759：seen 是 poll 存活，不是入站）。
 *
 * 旧实现把**自己**也算进去：于是"我最近收到过"被当成"同伴最近收到过"——
 * 在**没有任何同伴数据**时，判据落 `peer-ok`（"同伴也一样安静"），而真相是 `no-peer`
 * （**根本没有跨 bot 证据**）。两者都 silent:false，不影响告警，但诊断行在骗人 ——
 * 与 R1779「不许把无法证伪的猜测包装成结论」同源。显式排除 self 以对齐文档语义。
 */
export const latestPeerInbound = (peers: PeerLedger, self: string): number => {
  let max = 0
  for (const [bot, v] of Object.entries(peers)) {
    if (bot === self) continue
    const t = v && typeof v === "object" && v.in ? Number(v.in) || 0 : 0
    if (t > max) max = t
  }
  return max
}
/** 重算"同伴（不含自己）里最新的真实入站时刻"。 */
const recomputePeer = (peers: PeerLedger): void => {
  peerLastInboundAt = latestPeerInbound(peers, BOT_ID)
}

const writeLedger = (peers: PeerLedger, what: string): void => {
  try {
    // R1843：写入前与磁盘现状**逐字段取 max 合并**（防跨实例 read-modify-write 丢更新），
    // 再用 atomicWrite（tmp+rename）落盘，避免读侧读到**半截 JSON** →
    // readLedger 落 {} → recomputePeer 归 0 → 判据落 no-peer → **故障 bot 静默漏报**
    //（正是 R1757/R1758 花大力气消除的自我抑制死结）。
    const merged = mergePeerLedgers(readLedger(), peers)
    atomicWrite(PEER_INBOUND_PATH, JSON.stringify(merged), 0o600)
    recomputePeer(merged)
  } catch {
    peerWriteFailures++
    if (peerWriteFailures <= 3) diag(`[peer-inbound] ${what} 写入失败 bot=${BOT_ID} x${peerWriteFailures}`)
  }
}

const touchPeer = (): void => {
  const peers = readLedger()
  const now = Date.now()
  const mine = peers[BOT_ID] ?? { in: 0, seen: 0 }
  // seen 只前进：它表达"我 poll 还活着"，**绝不能碰 in**（in 是真实入站时刻）。
  // R1759 血训：把 poll 存活写进 in，会让同伴把我的故障当成"我在正常收消息"。
  // ⚠️ `Number(x) || 0` 不能省：R1760 实测 `mine.in` 为 undefined 时，
  // JSON.stringify 会把整个字段**丢掉**（实测线上账本变成 {"alt":{"seen":...}}），
  // alt 04:33:29 的真实入站时刻被我自己的 touchPeer 写丢 → recompute 取不到 → 漏报。
  // 这与 R1759 的教训同源：**undefined 流进序列化 = 静默丢数据，且没有任何报错**。
  const prevIn = Number(mine.in) || 0
  const prevSeen = Number(mine.seen) || 0
  peers[BOT_ID] = { in: prevIn, seen: Math.max(prevSeen, now) }
  writeLedger(peers, "touchPeer")
}

/**
 * 记录本 bot 的**真实入站**时刻，并重算同伴最新值。
 * 只在 `result.length > 0` 时调用。lastInboundAt 语义 = "我真收到 update"。
 * best-effort，失败不影响 poll。
 */
const noteInbound = (): void => {
  const now = Date.now()
  lastInboundAt = now
  const peers = readLedger()
  const mine = peers[BOT_ID] ?? { in: 0, seen: 0 }
  // 真收到 update：in 前进到 now，seen 同步（既然收到，poll 必然是活的）。
  peers[BOT_ID] = { in: Math.max(mine.in, now), seen: Math.max(mine.seen, now) }
  writeLedger(peers, "noteInbound")
}
let qpinBusy = false
// "本实例不是队列置顶拥有者"只提示一次
let queueOwnerSkipLogged = false
let qpinDirty = false
// R2575：启动时「从聊天置顶消息认领丢失记录」只做一次（见 reconcileQueuePinCard）。
let qpinReconciled = false
// 探针失败（网络/429/5xx）不能当成「已对账」：否则一次抖动就永久放弃，孤儿卡
// 会留到下次进程重启。失败后 60s 再试，避免每个 poll 都打一次 Telegram。
let qpinReconcileAt = 0
// 队列置顶卡的**最小工作间隔**与"已置为空态"的卡片记录。
// 背景：空队列分支会 clearQueuePinCard（触网 + savePersistedState），而
// savePersistedState 又会 queuePinRequest() → 此时 qpinBusy 仍为 true → 置 dirty →
// 退出时**立即**再跑一次 → 无限紧循环（实测 ~450ms/轮，把 Telegram 打到 429 限流，
// 用户侧表现为"主机器人突然不能用"）。两层防护：① 任何触网前先过最小间隔；
// ② 同一张卡片的"队列已空"状态只写一次。
const QPIN_MIN_INTERVAL_MS = 3000
let qpinLastWorkAt = 0
const qpinEmptyShownFor = new Map<string, number>()
let queuePinRequest: (() => void) | null = null
// 对账：循环插件会从文件里取走已搭便车的条目；只删"上次存过、这次文件没了"的，
// 新入队（还没存过）一律豁免——否则 save 比 write 先读文件会把新条当场吃掉（pos=0 事故）。
let lastSavedPinIds = new Set<string>()
const reconcilePinQueue = (): void => {
  try {
    const j = JSON.parse(readFileSync(STATE_PATH, "utf8")) as any
    const fileIds = new Set<string>()
    if (Array.isArray(j?.pinqueue)) {
      for (const o of j.pinqueue) if (o && typeof (o as any).id === "string" && (o as any).id) fileIds.add((o as any).id)
    }
    for (let i = pinQueue.length - 1; i >= 0; i--) {
      const id = pinQueue[i]?.id
      if (typeof id === "string" && id && lastSavedPinIds.has(id) && !fileIds.has(id)) pinQueue.splice(i, 1)
    }
  } catch {
    /* 读不到文件就信内存 */
  }
}
const lastReply = new Map<string, { chat: string; id: number; key: string }>()
// 暂停实时推送（命令仍响应）：doStop只停回合，pause停一切live推送
let pausedMode = false
// 本 Bot 是否只答命令、不自动应答普通文本（每 Bot 独立，随自己的状态文件落盘）。
// 用途：两个 Bot 落在同一个 chat 时可能各答一条。这个开关把决定权交给用户，
// 默认 false = 维持既有行为（两个都答），不擅自替用户改默认。
let selfMute = false
// R2650 (operator: "有没有按钮给我关闭/打开，注意区分bot")：连续 2 次 429 后
// 自动换会话是**每个 Bot 独立**的设置，存在各自的状态文件里。默认开；关闭后
// 本 Bot 不再消费 rollover 请求（请求最多 24h 后过期，不会影响其它 Bot）。
let rolloverOn429 = true
// 已扒键集合：edit 通道遇到即绕行（防流式尾巴/reload重推复活），显式切换（full/fold）不受影响
const strippedKb = new Set<string>()
// 扒键连续失败计数：同一 key 连续失败达上限即放弃（记入 strippedKb），防 429 无限 hammer
// 看门狗每次改卡后要把**实际发出的正文**写回记录：否则下次纠正找不到状态行锚点，
// 只能整张重渲染 → 用户看到的就是『格式坏了』（用户反馈）。由 editTextRaw 写入。
let lastEditBody = ""
// 工具终态措辞：**两条渲染路径共用**，否则同一状态在两张卡上说法不同。
// ⚠️ 修的是一处**给你看的假状态**：实测有卡写着「✅ 成功 (exit 1)」——
//    shell 退出码非 0 却写"成功"，自相矛盾。宿主 status=completed 只表示"工具调用没报错"，
//    任务的成败要看退出码。所以退出码非 0 时**不许写"成功"**。
export const toolStatusLabel = (status: string, exit: unknown): string => {
  const ex = exit != null && exit !== "" ? ` (exit ${exit})` : ""
  if (status === "error") return `❌ 失败${ex}`
  if (exit != null && exit !== "" && Number(exit) !== 0) return `⚠️ 完成，但退出码非 0${ex}`
  return `✅ 成功${ex}`
}

// ── /tmp 磁盘水位守卫（2026-09-26）────────────────────────────────────────
// 为什么需要：`/tmp` 是 tmpfs，宿主运行时、桥、bun 缓存都在上面，写满会影响**全部服务**。
// 而此前只有**跑测试时**不变量才会因水位失败 → 平时完全不可见：本次就是这样被发现的
// —— 已经涨到 88%（剩 205MB）才发现，按实测 60MB/小时只剩约 3.4 小时。
// 现在把水位接进**生产心跳**，并在水位跨档时各记一条醒目告警（去重，不刷屏）。
// ⚠️ 本守卫**只观察、只告警，不删任何文件**：删除属于破坏性操作，需用户授权。
const TMP_WARN_MB = 500
const TMP_CRIT_MB = 200
let tmpWarnStage = 0
const tmpFreeMb = (): number => {
  try {
    // /tmp 是 tmpfs，用 statfs 的 bavail × bsize
    const st = statfsSync("/tmp")
    return Math.floor((Number(st.bavail) * Number(st.bsize)) / 1048576)
  } catch {
    return -1
  }
}
const checkTmpPressure = (): { text: string; alert: string | null } => {
  const mb = tmpFreeMb()
  if (mb < 0) return { text: "", alert: null }
  const stage = mb < TMP_CRIT_MB ? 2 : mb < TMP_WARN_MB ? 1 : 0
  if (stage === tmpWarnStage) return { text: ` tmpFree=${mb}MB`, alert: null }
  const prev = tmpWarnStage
  tmpWarnStage = stage
  return {
    text: ` tmpFree=${mb}MB`,
    alert:
      stage > prev
        ? `TMP 空间告警：剩余 ${mb}MB（跨档 ${stage}）→ 写满会影响宿主/桥/编译缓存等全部服务。` +
          `本守卫只告警、**不删任何文件**；清理需用户授权。`
        : `TMP 空间回落：剩余 ${mb}MB（跨档 ${stage}）`,
  }
}
const stripFail = new Map<string, number>()

// ── 看门狗纠正去重（用户反馈"看门狗导致格式又坏了"）──────────────────────────
// 事实：同一条工具卡会被**两条路径先后重写** —— 巡检对账（stale）与启动修复（on startup）。
// 实测近 90 分钟 39 个 key 被纠正，其中 **29 个被两条路径各写一次**。
// 修法不是改渲染器，而是**别把同一张卡写两遍**。
// ⚠️ 只对**终态**去重：running 的"仍在执行中（已 N 分钟）"必须继续每分钟更新，冻住它会让 N 变假。
// RENDER_EPOCH：渲染器发生实质变化时 +1，强制全体刷新一次。
const RENDER_EPOCH = 1
const reconcileTag = new Map<string, string>()
const isTerminalStatus = (st: string): boolean => st === "completed" || st === "error"
const reconcileTagOf = (key: string, status: string): string => `${RENDER_EPOCH}:${status}`
const alreadyReconciled = (key: string, status: string): boolean =>
  isTerminalStatus(status) && reconcileTag.get(key) === reconcileTagOf(key, status)
const markReconciled = (key: string, status: string): void => {
  if (!isTerminalStatus(status)) return
  reconcileTag.set(key, reconcileTagOf(key, status))
  if (reconcileTag.size > 400) {
    const first = reconcileTag.keys().next()
    if (!first.done) reconcileTag.delete(first.value)
  }
  savePersistedState()
}

const STRIP_FAIL_MAX = 5
// R1842：判断 backfillStrip 的失败是否**瞬时**（可重试）。瞬时失败**不计入** stripFail/放弃阈值：
// 0/undefined = 网络层没拿到响应；429 = 限流；5xx = 服务端瞬时。其余（404 等）为确定性失败。
export const isTransientStripFailure = (status: number | undefined): boolean =>
  status === undefined || status === 0 || status === 429 || (status >= 500 && status < 600)
// 当前 TG 输入（命令回执引用它）；回调走独立分支时置空
let currentInbound: { chat: string; msgID: number } | null = null
let commandReplyMode = false
// 拥塞占位条：chat -> placeholder msgID（排空即删）
const listPlaceholder = new Map<string, number>()
// 已停止的会话：不再给新消息挂停止键（doStop 置位，注入泵投递成功时清除）
const haltedSet = new Set<string>()
/**
 * R1796：把 state 文件里的 `halted` 数组灌进 Set，返回实际置入条数。
 *
 * ⚠️⚠️ **这里不得加任何条数上限**（原实现是 `hl.slice(-50)`，R1796 已移除）。
 * `halted` 记的是**用户按过 ⏹ 的会话**，是 R1107 立的"尊重用户停止意图"这条契约的唯一载体，
 * 不是缓存、不是诊断样本。写侧（L1734 `halted: [...haltedSet]`）本来就**全量写不截断**，
 * 只有读侧有界 —— 两边不对称意味着：**重启时最旧的条目会被静默丢弃**，
 * 于是用户没碰过任何按钮，那些会话的自动循环自己又跑起来了（R1794 定位的失效路径）。
 *
 * R1795 已从 DB 取回 R1107 原文核实：那一轮谈的全是"让 auto-continue 尊重持久化 halted"，
 * **从未设计过任何条数上限** —— 那个 50 是后来某轮顺手加的无注释截断，与立意无关。
 *
 * 抽成独立函数是为了**能真测**：它原本内嵌在 state 加载里、操作模块级 `haltedSet`，
 * 直接测会污染跨文件共享状态（`haltedSet` 是模块级，10 个测试文件都 import 本模块）。
 * 体积不是问题：每 sid ≈ 40 B，即便 2000 条也仅 ≈ 80 KB。
 */
// ── 跨实例停机解除表（R2500 引入；R2572 抽到 ./halt-release）──────────────
// 读/写/解除/重新停机的契约集中在 halt-release.ts，tg-bridge 与 auto-continue
// 共用同一实现（此前 auto-continue 自己解析同一文件，格式漂移时两边会得出
// 不同结论）。doStop 里 `noteHaltArm` 必须先于 `savePersistedState`。
//   * 解除（新消息投递成功 / /loop start）→ 写入 sid
//   * 重新停机（doStop）→ **抹除** sid 条目（否则新停机会被旧解除吃掉，时序错乱）

const pendingSelect = new Map<string, { gen: number; ids: string[]; ts: number }>()
let selectGen = 0
const lastInject = new Map<string, string>()
// ⚠️ **残留功能：当前构建没有任何创建置顶条的代码路径**（R1034 实测）。
// 全文件 `pinChatMessage` 只有两处调用（重新置顶 / 新建），**都属于队列卡**；
// `pinnedBar` 这里只剩四个用途：从状态文件读回(1231)、落盘(1374)、取消置顶(3538/3549/3632)、
// retry 时读一下(4540)。实测 `bar = {}`（两个 Bot 都是空）、日志里 `pinned bar` **0 条**。
// → **"置顶条"这个功能是死的**；当前唯一活的置顶是**队列卡**（msg 8887，R1030 量化过：
//   每小时约 10 次置顶/取消，每次只为显示"共 1 条"）。
// 保留这些代码是为了**读回历史状态时不报错**（万一旧实例写过 bar），但不要以为它在工作。
// 若要恢复置顶条，需要重新实现"创建"路径。
const pinnedBar = new Map<string, { msgID: number; sid: string }>()

// 每个会话已知的最近一次"宿主自动压缩"时间戳（用于识别新事件）。
// R1036：**必须在模块级** —— 状态读回/写回也在模块级，闭包内的 const 它们看不见
// （第一版补丁因此被 tsc 守卫以 TS2304 拦下，当场自动回滚）。且它要落盘（`hcompact`），
// 原因见读回处的注释：重载很频繁（96 分钟 46 次），只在内存里的话**每次重载都会把
// 一次真压缩降级成"基线播种"而跳过通知**。
const lastHostCompact = new Map<string, number>()

// R2667：每个会话「最近一次已通知的压缩事件」。与 lastHostCompact 一样必须模块级，
// 并落盘（`cnotice`）—— 热重载很频繁，只放内存会让 4-6 分钟后迟到的 api/ctxdrop
// 又发一张重复卡。`at` 是事件时间（api 用接口时间戳，event/autoc/ctxdrop 用观测时间），
// `sentAt` 是真正发卡的时间；两者用途不同，见 compactNoticeVerdict()。
const lastCompactNotified = new Map<string, CompactNoticeMark>()
// 附加镜像会话：非当前目标也把「最终回复正文」推到同一个 chat（静默档）。
// 默认空 = 旧行为（只镜像 front/pinned），避免多会话同时刷屏触发 TG 429。
const WATCH_MAX = 8
// R1867：assistant 轮询补扫的窗口**按尾部 N 条 assistant 消息**计（不是 N 行）；
// 固定行窗口在夹入宿主 synthetic 循环提示 / tool 卡 / 用户消息时，会把被事件路径漏推的
// 正文挤出窗口 → 永久丢失（见补扫处注释）。
const CATCHUP_ASSISTANT_TAIL = 6
/**
 * R1867：返回补扫窗口起始下标 = 尾部 `tail` 条 **assistant** 消息中最早那条的下标。
 * 纯函数（导出以便单测）：非 assistant 行不计入 tail，所以中间夹多少 synthetic 循环提示 /
 * tool 卡 / 用户消息，都不会把被事件路径漏推的 assistant 正文挤出窗口。
 * 无可计入的 assistant 时返回 arr.length（空窗口，不扫）。
 */
export const catchupAssistantsStart = (arr: any[], tail: number): number => {
  let start = arr.length
  let n = 0
  for (let i = arr.length - 1; i >= 0 && n < tail; i--) {
    const m = arr[i]
    if (isCompactionMessage(m)) continue
    const role = String(m?.role ?? m?.info?.role ?? "")
    const typ = String(m?.type ?? m?.info?.type ?? "")
    if (role !== "assistant" && typ !== "assistant") continue
    n++
    start = i
  }
  return start
}
const watchedSessions = new Set<string>()
// 最近一次与状态文件对齐的 watch 值；用于判断内存是否被本进程改过
let watchSnapshot: string[] = []
// 最新实例的代号（数字）；0 = 尚未有实例接管写权限。
// 必须放在 globalThis 上：热重载会重新求值模块，模块级变量每个实例各有一份，
// 用模块变量判断“自己是不是最新”永远为真，陈旧实例照样覆写状态文件。
// ⚠️ R1052：原来所有 bot **共用**一个 `__tgBridgeWriterGen` 键。
// 每个实例启动都执行 `globalThis[该键] = myGen` → **最后加载的实例独占写入权**，
// 而每个 bot 写的是**各自的状态文件** → 只有一个 bot 能落盘，其余全部静默拒绝。
// 实测症状：心跳恒为 `last=-1s bytes=0 fails=0`、状态文件永不更新；
// 2026-09-27T01:48 加入 bot3 之后 primary 的 tg-chats.json **24 分钟未落盘**，
// 而 alt/bot3 的文件都新鲜 —— 正好是"只有最后加载的 bot3 能写"。
// 连带症状：primary 上 `/unwatch` 清了内存却写不进文件 → 下一 tick 从文件读回旧值
// → **用户看到"清除镜像没有效果"**。
// 修法：写入者标记**派生自 GEN_KEY**（它本来就按 bot 命名空间隔离），各 bot 互不抢。
const writerGenKey = (): string => `${GEN_KEY}__writerGen`
let instanceGen = 0
const isLiveWriter = (): boolean => {
  if (instanceGen <= 0) return true
  const G = globalThis as Record<string, unknown>
  return G[writerGenKey()] === instanceGen && G[GEN_KEY] === instanceGen
}
// 状态文件 → 内存 的 watch 变更通知（模块级 sync 需要工厂内的 logger）
let watchSyncHook: ((ids: string[]) => void) | null = null
const aliasMap = new Map<string, string>()
const fullTextStore = new Map<string, { compact: string; full: string }>()
let fullTextSeq = 0
// 看完整版文本仓：fid → {compact/fold回跳用, full}（重启丢失→回"已过期"）。
const storeFullText = (full: string, compact?: string, sid = "", key = ""): string => {
  fullTextSeq++
  const id = `${fullTextSeq.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  fullTextStore.set(id, { compact: compact ?? full, full })
  if (sid && key) {
    fullKeyStore.set(id, { sid, key })
    if (fullKeyStore.size > 30) {
      const k2 = fullKeyStore.keys().next().value
      if (k2 !== undefined) {
        fullKeyStore.delete(k2)
        fullTextStore.delete(k2)
      }
    }
  }
  if (fullTextStore.size > 30) {
    const k = fullTextStore.keys().next().value
    if (k !== undefined) {
      fullTextStore.delete(k)
      fullKeyStore.delete(k)
    }
  }
  return id
}
// fid→会话定位（持久化，重启后过期按钮可重推刷新；全文本身不持久化）
const fullKeyStore = new Map<string, { sid: string; key: string }>()
let persistedFront = ""
let fixedTarget: string | undefined
const loadPersistedState = (): void => {
  try {
    const raw = readFileSync(STATE_PATH, "utf8")
    const j = JSON.parse(raw) as any
    if (typeof j?.front === "string" && j.front.startsWith("ses_")) persistedFront = j.front
    if (typeof j?.pinned === "string" && j.pinned.startsWith("ses_")) fixedTarget = j.pinned
    // R1734：接回 watchdog 基线（详见 savePersistedState 里的 lastpush 注释）
    if (typeof j?.lastpush === "number" && j.lastpush > 0) {
      lastProtoSendAt = j.lastpush
      // 这一行是**故意留痕**的：基线来源若丢了，症状是"watchdog 永远不报"，
      // 而那个症状和"一切正常"在其它日志里完全同形。没有这行就只能靠猜。
      diag(`[watchdog] 基线来自状态文件 lastpush=${new Date(j.lastpush).toISOString()}`)
    }
    // R1740：入站静默基线。与 lastpush 同理但**方向相反** —— lastpush 守出站，
    // lastinbound 守入站。少了它，重启后 lastInboundAt 归零 → 静默判据在重启后
    // 前 10 分钟完全瞎（R1739 那个 59 秒窗口正是"无痕"，跨重启更不能只靠内存）。
    if (typeof j?.lastinbound === "number" && j.lastinbound > 0) {
      lastInboundAt = j.lastinbound
      diag(`[watchdog] 入站基线来自状态文件 lastinbound=${new Date(j.lastinbound).toISOString()}`)
    }
    const chats = j?.chats
    if (chats && typeof chats === "object") {
      for (const [k, v] of Object.entries(chats)) {
        if (typeof v === "string" && /^\d+$/.test(v)) knownNumericChatIDs.set(k, v)
      }
    }
    const q = j?.queue
    if (Array.isArray(q)) {
      for (const item of q.slice(0, 50)) {
        if (item && typeof item.chat === "string" && typeof item.text === "string" && item.text) {
          outQueue.push({ chat: item.chat, text: item.text, ts: typeof item.ts === "number" ? item.ts : 0 })
        }
      }
    }
    const pq = j?.pinqueue
    if (Array.isArray(pq)) {
      for (const [pi, item] of pq.slice(0, PINQ_MAX).entries()) {
        const o = item as any
        if (o && typeof o.sid === "string" && o.sid.startsWith("ses_") && typeof o.text === "string" && o.text && typeof o.chat === "string" && o.chat) {
          pinQueue.push({ id: typeof o.id === "string" && o.id ? o.id : `restored-${typeof o.ts === "number" ? o.ts : 0}-${pinQueue.length}`, sid: o.sid, text: o.text, ctx: typeof o.ctx === "string" ? o.ctx : "", chat: o.chat, ts: typeof o.ts === "number" ? o.ts : 0, tgMid: Number.isFinite(Number(o.tgMid)) && Number(o.tgMid) > 0 ? Number(o.tgMid) : undefined })
        } else {
          // 静默丢弃是这轮明确要消灭的行为：队列条目在重启后消失，用户只会看到"我排的东西没了"。
          // 注意：这里在**模块作用域**（loadPersistedState 随模块求值跑），工厂里的 log()
          // 不可见 —— 直接调会 ReferenceError 然后被自己的 catch 吞掉，等于没记（踩过三次）。
          // 所以走文件通道，可 grep、可证；只记结构特征，不记正文。
          pinRestoreDropped++
          diag(`queue item dropped on restore idx=${pi} sid=${String(o?.sid ?? "").slice(0, 14)} hasSid=${typeof o?.sid === "string"} hasText=${typeof o?.text === "string" && !!o?.text} chat=${JSON.stringify(String(o?.chat ?? "").slice(0, 12))} (dropped total=${pinRestoreDropped})\n`)
        }
      }
      if (pinQueue.length > 0) pinRestorePending = pinQueue.length
    }
    // 上次进程退出时"注入进行中"的条目：按 at-most-once 语义**不重放**（宁可丢，
    // 也不要同一个要求被执行多遍）。这里留痕，便于事后核对。
    if (Array.isArray(j?.pininflight) && j.pininflight.length > 0) {
      diag(`in-flight item(s) NOT replayed: ${j.pininflight.length} (ids=${j.pininflight
            .map((x: any) => String(x?.id ?? "").slice(0, 12))
            .join(",")})\n`)
    }
    if (Number.isInteger(j?.offset) && (j.offset as number) > 0) persistedOffset = j.offset as number
    if (Number.isFinite(j?.lastRealUpdateId) && (j.lastRealUpdateId as number) > 0) lastRealUpdateId = j.lastRealUpdateId as number
    const pm = j?.proto
    if (Array.isArray(pm)) {
      for (const item of pm.slice(-1000)) {
        if (Array.isArray(item) && typeof item[0] === "string" && Number.isInteger(item[1])) {
          protoMap.set(item[0], {
            id: item[1],
            text: typeof item[4] === "string" ? protoRedact(item[4]) : "",
            fallback: item[2] === true,
            runningAt: Number(item[3] ?? 0) || 0,
          })
        }
      }
    }
    const hh = j?.hashes
    if (Array.isArray(hh)) {
      for (const x of hh.slice(-1500)) if (typeof x === "string" && x) sentHash.add(x)
    }
    const rr = j?.rounds
    if (rr && typeof rr === "object") {
      for (const [k, v] of Object.entries(rr)) {
        if (typeof v === "string" && v) lastRound.set(k, v)
      }
    }
    const su = j?.seen
    if (Array.isArray(su)) {
      for (const x of su.slice(-SEEN_RING_MAX)) if (Number.isInteger(x)) seenUpdates.add(x)
    }
    const fk = j?.fullkeys
    if (fk && typeof fk === "object") {
      for (const [k, v] of Object.entries(fk).slice(-30)) {
        const o = v as any
        if (typeof k === "string" && o && typeof o.sid === "string" && typeof o.key === "string") {
          fullKeyStore.set(k, { sid: o.sid, key: o.key })
        }
      }
    }
    const lr = j?.lastreply
    if (lr && typeof lr === "object") {
      for (const [k, v] of Object.entries(lr)) {
        const o = v as any
        if (typeof k === "string" && o && typeof o.chat === "string" && Number.isInteger(o.id)) {
          lastReply.set(k, { chat: o.chat, id: o.id, key: typeof o.key === "string" ? o.key : "" })
        }
      }
    }
    const sk = j?.stripkb
    if (Array.isArray(sk)) {
      for (const k of sk.slice(-STRIP_KB_MAX)) if (typeof k === "string" && k) strippedKb.add(k)
    }
    const sf = j?.stripfail
    if (sf && typeof sf === "object") {
      for (const [k, v] of Object.entries(sf)) {
        if (typeof k === "string" && Number.isInteger(v) && (v as number) > 0) stripFail.set(k, v as number)
      }
    }
    // sidecar 独立于主 state 文件：旧图实例会整体重写主 state 抹掉 stripfail，
    // sidecar 只有新代码读写，免疫跨图覆盖。
    try {
      const sj = JSON.parse(readFileSync(STRIPFAIL_PATH, "utf8")) as Record<string, unknown>
      if (sj && typeof sj === "object") {
        for (const [k, v] of Object.entries(sj)) {
          // 只收整数值的键：__stripped 是数组，会被这条 Number.isInteger 天然过滤掉，
          // 不会污染 stripFail 的失败计数。
          if (typeof k === "string" && Number.isInteger(v) && (v as number) > 0) {
            stripFail.set(k, Math.max(stripFail.get(k) ?? 0, v as number))
          }
        }
        // 还原"已处理"集合（上限与运行时的 GC 一致：500）
        const kb = sj.__stripped
        if (Array.isArray(kb)) {
          for (const k of kb.slice(-STRIP_KB_MAX)) if (typeof k === "string") strippedKb.add(k)
        }
      }
    } catch {
      /* first run */
    }
    if (Array.isArray(j?.rctags)) {
      for (const it of j.rctags) {
        if (Array.isArray(it) && typeof it[0] === "string" && typeof it[1] === "string") reconcileTag.set(it[0], it[1])
      }
    }
    loadHaltedInto(j?.halted, haltedSet) // R1796：全量灌入，**不截断**（理由见 loadHaltedInto 注释）
    const fj = j?.filters
    if (fj && typeof fj === "object") {
      for (const k of ["reply", "think", "tool", "status"] as const) {
        const v = (fj as any)[k]
        if (v === 0 || v === 1 || v === 2) filters[k] = v
      }
    } else if (j?.quiet === true) {
      filters.think = 0
      filters.tool = 0
      filters.status = 0
    }
    // R2674：仅标题合并是 per-Bot 设置。字段缺失（旧状态文件）时只读一次旧的全局开关，
    // 迁移后由 savePersistedState 写入本 Bot 自己的 titleMerge；之后改别的 Bot 不影响这里。
    if (typeof j?.titleMerge === "boolean") titleMergeOn = j.titleMerge
    else titleMergeOn = legacyTitleMergeSeed()
    // R2683：仅标题合并链和新位置观测跨重载/重启存活。旧状态没有这两个字段时
    // 保持空链（旧行为：重启后第一张卡新发）。恢复的链是否还能原地改写，
    // 由 lastmsgs 与运行时的入站/出站更新共同判定：锚点之后有更新 → R2682 重堆。
    const tcs = j?.titlechains
    if (Array.isArray(tcs)) {
      for (const it of tcs.slice(-50)) {
        if (!Array.isArray(it) || it.length < 7) continue
        const [chat, sid, kind, key, id, count, fallback] = it
        const cid = typeof chat === "string" ? chat : ""
        const mid = Math.floor(Number(id) || 0)
        const n = Math.floor(Number(count) || 0)
        if (!cid || typeof sid !== "string" || !sid.startsWith("ses_") || typeof kind !== "string" || !kind) continue
        if (typeof key !== "string" || !key || mid <= 0 || n < 1) continue
        titleMergeChains.set(cid, { sid, kind, key, id: mid, count: n, fallback: fallback === true })
      }
    }
    const lms = j?.lastmsgs
    if (Array.isArray(lms)) {
      for (const it of lms.slice(-200)) {
        if (!Array.isArray(it) || it.length < 2) continue
        const cid = typeof it[0] === "string" ? it[0] : ""
        const mid = Math.floor(Number(it[1]) || 0)
        if (!cid || mid <= 0) continue
        // 与运行时同口径：只前进不后退。
        if (mid > (lastChatMessageIds.get(cid) ?? 0)) lastChatMessageIds.set(cid, mid)
      }
    }
    const cp = j?.compact
    if (cp && typeof cp === "object") {
      if ((cp as any).auto === false) compactPrefs.auto = false
      // R719：压缩通知开关（false 才覆盖默认 true；缺省字段=旧状态文件 → 保持开）
      if ((cp as any).notice === false) compactPrefs.notice = false
      const th = Number((cp as any).threshold)
      if (th >= 0.5 && th <= 0.95) compactPrefs.threshold = th
    }
    const ij = j?.inject
    if (ij && typeof ij === "object" && ((ij as any).mode === "now" || (ij as any).mode === "idle")) injectMode = (ij as any).mode
    const qp = j?.qpin
    if (qp && typeof qp === "object") {
      for (const [k, v] of Object.entries(qp)) {
        if (typeof k === "string" && k && Number.isInteger(v)) queuePin.set(k, v as number)
      }
    }
    // 置顶标志读回；**缺标志时按"已置顶"处理**（保守方向）：多取消一次只是 400 无害，
    // 少取消一次就会永久留下一条置顶垃圾（这正是用户看到的堆积）。
    try {
      const qon = j?.qpinon as any
      if (qon && typeof qon === "object") {
        for (const [k, v] of Object.entries(qon)) {
          if (typeof k === "string" && k) queuePinOn.set(k, v === true)
        }
      }
      for (const k of queuePin.keys()) if (!queuePinOn.has(k)) queuePinOn.set(k, true)
    } catch {
      /* best-effort */
    }
    // 入站/出站计数落盘恢复：否则热重载归零，"消息有没有丢"无法跨重载核对
    // （只写不读更糟：会把历史清零）。逐键累加，避免重复加载同一文件时翻倍。
    try {
      const ic = j?.iocount as any
      if (ic && typeof ic === "object") {
        for (const k of Object.keys(inboundCounters) as Array<keyof typeof inboundCounters>) {
          const v = Number(ic[k])
          if (Number.isFinite(v) && v > 0) inboundCounters[k] = v
        }
      }
    } catch {
      /* best-effort */
    }
    // 读回两处去重集合（否则热重载后重复提醒 / 重复补推）
    try {
      const adv = j?.advisory
      if (Array.isArray(adv)) {
        for (const k of adv.slice(-200)) {
          if (typeof k === "string" && k.includes(":")) {
            ctxAdvisorySent.add(k)
            ctxAdvisoryAt.set(k, Date.now())
          }
        }
      }
      const pa = j?.pushask
      if (Array.isArray(pa)) for (const k of pa.slice(-200)) if (typeof k === "string" && k.includes(":")) pushedAsk.add(k)
    } catch {
      /* best-effort */
    }
    try {
      const qm = j?.qmap
      if (Array.isArray(qm)) {
        for (const row of qm.slice(-30)) {
          if (!Array.isArray(row) || row.length < 4) continue
          const [tok, sid, ans, ts] = row as [string, string, string, number]
          if (typeof tok !== "string" || typeof sid !== "string" || typeof ans !== "string") continue
          if (!sid.startsWith("ses_")) continue
          if (!Number.isFinite(Number(ts)) || Date.now() - Number(ts) >= 30 * 60_000) continue
          qMap.set(tok, { sid, answer: ans, ts: Number(ts) })
        }
      }
    } catch {
      /* best-effort */
    }
    const qh = j?.qpinhist
    if (Array.isArray(qh)) {
      // 历史卡记录要够长且去重：只留 5 条时，稍早建过的卡会失去跟踪 → 既取消不了
      // 置顶也删不掉（用户报"有多个置顶"）；不去重则同一 id 反复重试清扫。
      for (const v of qh.slice(-12)) {
        if (Number.isInteger(v) && !queuePinHist.includes(v as number)) queuePinHist.push(v as number)
      }
    }
    // legacy loopskip 已废弃：用户消息不再暂停自动续跑。
    if (j?.paused === true) pausedMode = true
    if (j?.selfmute === true) selfMute = true
    // R2650：per-Bot 设置。旧状态文件没有这个键时按开处理。
    if (j?.rollover429 === false) rolloverOn429 = false
    const al = j?.aliases
    if (al && typeof al === "object") {
      for (const [k, v] of Object.entries(al)) {
        if (typeof k === "string" && typeof v === "string" && v) aliasMap.set(k.toLowerCase(), v)
      }
    }
    if (j?.tokacc && typeof j.tokacc === "object") {
      // 兼容旧存档：r511 起不再使用累加口径，直接忽略（下次事件/回填即重建真值）
    }
    const bb = j?.bar
    if (bb && typeof bb === "object") {
      for (const [k, v] of Object.entries(bb)) {
        const o = v as any
        if (typeof k === "string" && o && Number.isInteger(o.msgID) && typeof o.sid === "string") {
          pinnedBar.set(k, { msgID: o.msgID, sid: o.sid })
        }
      }
    }
    // R1036：读回"上次已见过的宿主压缩时间戳"。
    // 为什么必须落盘：`lastHostCompact` 原先只在内存里 → **每次重载都把它清空** →
    // 下一轮扫描读到真压缩时 prev===0 → 被当成"基线播种"而**跳过发卡**。
    // 实测（R1035）：18:20:44 压缩发生，18:21:07 重载（仅隔 23 秒）→ 那次压缩的
    // api 路通知就此丢失。有了落盘值，重载后 prev>0 → 真压缩照发卡；
    // 只有"这个 sid 真的从没见过压缩"才算基线。
    const hc = j?.hcompact
    if (hc && typeof hc === "object") {
      for (const [k, v] of Object.entries(hc as Record<string, unknown>)) {
        const n = Number(v)
        if (typeof k === "string" && /^ses_[A-Za-z0-9_-]+$/.test(k) && Number.isFinite(n) && n > 0) {
          lastHostCompact.set(k, n)
        }
      }
    }
    // R2667：读回去重账本。多 Bot 共用同一份模块级 map（与 lastHostCompact 同族），
    // 因此按 sentAt 取较新的一条，避免后加载的旧 Bot 状态把新记录冲掉。
    const cn = j?.cnotice
    if (cn && typeof cn === "object") {
      for (const [k, v] of Object.entries(cn as Record<string, unknown>)) {
        if (typeof k !== "string" || !/^ses_[A-Za-z0-9_-]+$/.test(k)) continue
        const o = v as any
        const at = Number(o?.at)
        const sentAt = Number(o?.sentAt)
        const how = String(o?.how ?? "") as CompactHow
        if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(sentAt) || sentAt <= 0) continue
        if (!["api", "ctxdrop", "event", "autoc"].includes(how)) continue
        const prev = lastCompactNotified.get(k)
        if (!prev || sentAt > prev.sentAt) lastCompactNotified.set(k, { at, sentAt, how })
      }
    }
    const wl = j?.watch
    if (Array.isArray(wl)) {
      for (const v of wl) {
        if (typeof v === "string" && /^ses_[A-Za-z0-9_-]+$/.test(v) && watchedSessions.size < WATCH_MAX) watchedSessions.add(v)
      }
    }
    watchSnapshot = [...watchedSessions]
  } catch {
    // 区分两种"读不到"：
    //  - ENOENT（首次运行，文件还没生成）：正常，静默。
    //  - 文件**存在但解析失败**（截断/损坏/半写）：此前与首次运行同形静默吞掉，
    //    表现为 front/pinned/watch/入站 offset/队列**无痕归零**，与"用户自己改坏了"
    //    完全无法区分。与 savePersistedState 的失败留痕同策略：必须在 RESTORE_DIAG 留痕。
    try {
      readFileSync(STATE_PATH, "utf8") // 能再次读到 → 失败发生在 JSON.parse（文件存在但坏）
      const msg = `state load FAILED: ${STATE_PATH} 存在但无法解析 — 已从默认值启动（front/pinned/watch/队列可能被清空）`
      // diag() 自带时间戳 + 统一脱敏（R1853）
      diag(msg)
      try {
        console.error(`${new Date().toISOString()} ${redactSecrets(msg)}`)
      } catch {
        /* ignore */
      }
    } catch {
      /* 真·首次运行：文件不存在 */
    }
  }
}
/**
 * 原子写文件：先写同目录的 .tmp 再 rename。
 *
 * 为什么必须：状态文件不小（proto 最多 1000 条 + 队列 + 聊天表），一次
 * writeFileSync 要几毫秒；这期间 auto-continue 每 2 秒读一次同一文件，**可能读到
 * 写了一半的 JSON** → parse 抛错 → 读侧 catch 成"没有目标" → 循环那一拍静默跳过，
 * 表现为"循环莫名停了一下又自己好了"，极难归因。
 * rename 在同一文件系统内是原子的，读者要么看到旧内容要么看到新内容。
 */
export const atomicWrite = (path: string, body: string, mode?: number): void => {
  // R1841：tmp 名带 pid —— 与 `writeIdList` 同约定。reload 期间旧/新插件进程可能并存，
  // 固定 `.tmp` 会让两者互相截断对方正在写的临时文件，rename 后可能落一个半截状态文件。
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, body, mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode })
    renameSync(tmp, path)
  } catch {
    // R1841：不再"退回直写"。直写非原子，一旦中途失败（ENOSPC/EIO/权限）会把**原文件**
    // 截断写坏且无法回滚 —— 比"这次没保存"严重得多（状态文件损坏 = 队列/置顶全丢）。
    // 宁可本次保存失败并抛错（调用方 catch 记日志、下一拍重试），也要保证读者看到的
    // 永远是"旧的完整内容或新的完整内容"。
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw new Error(`atomicWrite failed: ${path}`)
  }
}

let stateSaveSkipLogAt = 0
let stateSaveFails = 0
let stateSaveErrLogAt = 0
let crossTalkSkipLogAt = 0
let stateSavedAt = 0
let stateSavedBytes = 0
// ⚠️ 声明必须排在 savePersistedState **之前**：模块求值期间就会调用保存函数，
// 若此处是 const 且排在后面，会命中 TDZ 抛 ReferenceError，而保存体外的 catch 会
// 把它完全静默地吞掉 → 状态文件从此不再更新（队列条目留在文件里 → 重载后重复注入、
// 计数/置顶历史不落盘）。这个坑真实发生过（r623 起状态文件冻住 15+ 分钟）。
// 入站分类计数：把"消息丢了"从感觉变成数字。丢在哪一环（白名单/去重/类型）都能分辨。
const inboundCounters = {
  total: 0,
  callback: 0,
  command: 0,
  text: 0,
  other: 0,
  droppedDupe: 0,
  droppedNotAllowed: 0,
  droppedNoMessage: 0,
  droppedBot: 0,
  droppedCallback: 0,
  outbound: 0,
  outboundFail: 0,
}
// R2634（运营者：“在429后重新检测为200后使用fork修改当前机器人会话ID”）：
// watcher 在复检 200 后写请求目录；桥认领会话后 fork，并把所有指向旧 ID 的
// 机器人映射重映射到新 ID。这里只放模块级读写内核：savePersistedState 在
// 任何一次落盘前都会套用同一份 remap，避免兄弟 Bot 用内存旧值把新 front 写回去。
const QUOTA_FORK_DIR = process.env.QUOTA_FORK_DIR ?? "/tmp/opencode/quota-fork-requests"
// 每个 old→new 一份文件：兄弟 Bot 可能同时 fork 各自的会话，单文件会互相覆盖。
const QUOTA_FORK_REMAP_DIR = `${QUOTA_FORK_DIR}/remap`
const QUOTA_FORK_REMAP_PATH = `${QUOTA_FORK_DIR}/remap.json` // 旧格式兼容（只读）
const QUOTA_FORK_REMAP_TTL_MS = 10 * 60_000
// R2649/R2700 (operator: "在429后自动创建新会话，切换并且注入：
// 阅读（原会话id）对话历史，继续任务 的提示词")：CI 在只有 429 的配额轮里，
// 把**本轮真正 429 过的会话**写成请求（放在 ~/.config/opencode，随环境快照
// 跨 run 存活；/tmp 不持久）。每轮只写最早 429 的一个，没 429 的会话不会被换；
// 计数 1 即换、换后归零。拥有该会话的桥实例认领后新建空会话、切换映射、
// 注入“阅读旧会话历史并继续”的提示词。与 R2634 的 fork 共用 remap 内核。
const ROLLOVER_REQUEST_DIR =
  process.env.ROLLOVER_REQUEST_DIR ?? `REDACTED_ROOT/.config/opencode/rollover-requests`
const ROLLOVER_REQUEST_MAX_AGE_MS = 24 * 3600_000
const isSessionId = (v: unknown): v is string => typeof v === "string" && /^ses_[A-Za-z0-9_-]+$/.test(v)
type QuotaForkRemap = { old: string; new: string; ts: number; by?: string }
const parseQuotaForkRemap = (j: any): QuotaForkRemap | null => {
  const oldSid = j?.old
  const newSid = j?.new
  if (!isSessionId(oldSid) || !isSessionId(newSid) || oldSid === newSid) return null
  const ts = Number(j?.ts ?? 0)
  if (!Number.isFinite(ts) || ts <= 0 || Date.now() - ts > QUOTA_FORK_REMAP_TTL_MS) return null
  return { old: oldSid, new: newSid, ts, by: typeof j?.by === "string" ? j.by : "" }
}
const readQuotaForkRemaps = (): QuotaForkRemap[] => {
  const out: QuotaForkRemap[] = []
  const push = (r: QuotaForkRemap | null): void => {
    if (!r || out.some((x) => x.old === r.old)) return
    out.push(r)
  }
  try {
    for (const name of readdirSync(QUOTA_FORK_REMAP_DIR)) {
      if (!name.endsWith(".json")) continue
      try {
        push(parseQuotaForkRemap(JSON.parse(readFileSync(`${QUOTA_FORK_REMAP_DIR}/${name}`, "utf8"))))
      } catch {
        /* 单个 remap 文件损坏不影响其它映射 */
      }
    }
  } catch {
    /* 目录不存在 = 还没有 fork */
  }
  // 兼容旧格式：{old,new,ts,by} 或 {maps:[...]}
  try {
    const j = JSON.parse(readFileSync(QUOTA_FORK_REMAP_PATH, "utf8")) as any
    const raw: unknown[] = Array.isArray(j?.maps) ? j.maps : Array.isArray(j) ? j : [j]
    for (const x of raw) push(parseQuotaForkRemap(x))
  } catch {
    /* 无旧格式文件 */
  }
  // 链式 fork（A→B，随后 B→C）按时间升序套用才能收敛到 C。
  return out.sort((a, b) => a.ts - b.ts)
}
// 只改内存里的 front/pinned；frontSessionID 在插件闭包内，由 R2634 的轮询同步。
const applyQuotaForkRemapToState = (): QuotaForkRemap[] => {
  const maps = readQuotaForkRemaps()
  for (const r of maps) {
    if (fixedTarget === r.old) fixedTarget = r.new
    if (persistedFront === r.old) persistedFront = r.new
  }
  return maps
}
const savePersistedState = (): void => {
  // 陈旧热重载实例不得覆写状态文件（否则会把新实例的 watch/front/队列改回旧值）
  if (!isLiveWriter()) {
    // 静默跳过是这一系列"改了没生效"问题的根源之一（认领没落盘 → 重复注入）。
    // 必须留痕，节流 30s 一条。
    if (Date.now() - stateSaveSkipLogAt > 30_000) {
      stateSaveSkipLogAt = Date.now()
      diag(`state save SKIPPED (stale writer: gen=${String((globalThis as Record<string, unknown>)[GEN_KEY])})\n`)
    }
    return
  }
  // R2634：兄弟 Bot 可能在本次 save 之前已经 fork 完并写了 remap。
  // 任何落盘都必须先把旧 front/pinned 换成新 ID，否则下一拍又会把旧值写回文件。
  applyQuotaForkRemapToState()
  const watchDirty = watchSnapshot.length !== watchedSessions.size || [...watchedSessions].some((v) => !watchSnapshot.includes(v))
  if (watchDirty) watchSnapshot = [...watchedSessions]
  try {
    reconcilePinQueue()
    try {
      queuePinRequest?.()
    } catch {
      /* best-effort */
    }
    const body = JSON.stringify({
        front: persistedFront,
        pinned: fixedTarget ?? "",
        // R1734：投递静默 watchdog 的基线。**必须落盘**，否则热重载后基线归零 →
        // "尚无投递基线"这条抑制规则会**永久生效**：万一重载后事件流又断（02:37 的形态），
        // watchdog 恰好在这个窗口里最该报，却因为"没基线"而一声不吭。
        // 这是把 02:37 那次"静默 30 分钟只有用户能发现"的风险重新引入，只是概率更低。
        lastpush: lastProtoSendAt,
      // R1740：入站静默基线落盘（见 loadPersistedState 同名读取处注释）
      lastinbound: lastInboundAt,
        chats: Object.fromEntries(knownNumericChatIDs),
        queue: outQueue.slice(0, 50),
        pinqueue: pinQueue.slice(0, PINQ_MAX),
        // 注入进行中（不重放，重启即视为丢，见 loadPersistedState 的处理）
        pininflight: pinInFlight.slice(0, 10),
        rctags: [...reconcileTag.entries()].slice(-400),
        offset: persistedOffset,
        lastRealUpdateId,
        // 第 4 段是"进入 running 的时刻"（0=非运行）：没有它，重启后既认不出
        // 哪些卡还停在"执行中"，也算不出停了多久（用户实测 read 早已完成却一直显示执行中）
        // ⚠️ 落盘也必须**标签安全**。R1009 教训：这里原来是裸 `v.text.slice(0, 1500)`，
        // 于是用户视角巡检把 22 张**早已发完**的卡片报成"标签失衡"，我据此差点去"修"一个
        // 不存在的发送层缺陷。副本畸形 ≠ 线上畸形，但**副本畸形会让巡检永久不可信** ——
        // 而巡检是唯一能抓到真实格式缺陷的那一层（R1007 的真 bug 就是它抓到的）。
        // ROUND 10：先 protoRedact 再截断（截断会把 token 劈成两半而漏过正则），
        // 既保住上面的"标签安全"，又不让工具卡原文里的凭据落盘。
        // R2637：菜单锚点必须跨重载/裁剪存活，否则下一次 /menu 会新发第二条菜单。
        proto: [
          ...[...protoMap.entries()].filter(([k]) => !k.startsWith("menu:")).slice(-1000),
          ...[...protoMap.entries()].filter(([k]) => k.startsWith("menu:")),
        ].map(([k, v]) => [k, v.id, v.fallback === true, v.runningAt ?? 0, v.text && k.includes(":tool:") ? balanceHtmlTags(safeCut(protoRedact(v.text), 1500)) : ""]),
        hashes: [...sentHash].slice(-1500),
        rounds: Object.fromEntries([...lastRound.entries()].slice(-200)),
        // 只落盘真实 update_id（负数是菜单合成事件，见 handleUpdateInner）
        seen: [...seenUpdates].filter((x) => x >= 0).slice(-SEEN_RING_MAX),
        fullkeys: Object.fromEntries(fullKeyStore),
        lastreply: Object.fromEntries(lastReply),
        stripkb: [...strippedKb].slice(-STRIP_KB_MAX),
        stripfail: Object.fromEntries([...stripFail.entries()].slice(-200)),
        // R2500：落盘时按**共享解除表**做差集 —— 别的 Bot 解除过的停机不能被我写回。
        halted: [...haltedSet].filter((s) => !(s in readHaltRelease())),
        filters: { ...filters },
        // R2674：per-Bot 的仅标题合并开关（与 filters 同文件、同菜单）。
        titleMerge: titleMergeOn,
        // R2683：合并链（含累计次数）和每个 chat 的最新 message_id 一起落盘。
        // 没有它们，每次重启/热重载都会把同一条可见链拆成两张卡。
        titlechains: [...titleMergeChains.entries()]
          .slice(-50)
          .map(([chat, c]) => [chat, c.sid, c.kind, c.key, c.id, c.count, c.fallback === true]),
        lastmsgs: [...lastChatMessageIds.entries()].slice(-200).map(([chat, id]) => [chat, id]),
        compact: { ...compactPrefs },
        inject: { mode: injectMode },
        qpin: Object.fromEntries(queuePin),
        // 「这条当前是否处于置顶状态」必须一起落盘：它此前只在内存里，
        // 重启后丢失 → clearQueuePinCard 的 `queuePinOn.get(chat)` 判假 →
        // **跳过取消置顶** → 随后新建置顶 → 每重启多留一条（用户实测积到 6 个）。
        qpinon: Object.fromEntries(queuePinOn),
        // 询问按钮的一次性 token **必须落盘**：桥一热重载 qMap 就清空，用户点按钮
        // 只得到"问题已过期"，什么都没注入（实测 06:31 推卡、06:34 重载后点击即失效）。
        // 只保留未过期的（TTL 30 分钟），避免状态文件无限增长。
        // ctx 提醒的去重集合**必须落盘**：它是"每档只提醒一次"的唯一依据，
        // 而热重载会清空内存集合 → 桥每重载一次就重复提醒用户一次（我这一轮重载 3 次，
        // 用户就会收到 3 条同样的 40% 提醒）。只保留 24 小时内的条目。
        advisory: [...ctxAdvisorySent].filter((k) => !ctxAdvisoryAt.has(k) || Date.now() - (ctxAdvisoryAt.get(k) ?? 0) < 24 * 60 * 60_000),
        // 询问补推的去重也落盘，理由相同（重载后重复补推会多一次编辑）。
        pushask: [...pushedAsk],
        qmap: [...qMap.entries()]
          .filter(([, v]) => Date.now() - v.ts < 30 * 60_000)
          .map(([k, v]) => [k, v.sid, v.answer, v.ts]),
        qpinhist: [...queuePinHist].slice(-12),
        iocount: { ...inboundCounters },
        loopskip: {},
        paused: pausedMode,
        selfmute: selfMute,
        // R2650：per-Bot 的「连续 2 次 429 自动换会话」开关（默认开）。
        rollover429: rolloverOn429,
        aliases: Object.fromEntries(aliasMap),
        bar: Object.fromEntries(pinnedBar),
        // R1036：与读回成对。少了写回，读回永远拿到空 → 等于没修。
        hcompact: Object.fromEntries(lastHostCompact),
        // R2667：压缩卡去重账本。只保留 24h，避免状态文件无限长。
        cnotice: Object.fromEntries(
          [...lastCompactNotified].filter(([, v]) => Date.now() - v.sentAt < 24 * 60 * 60_000),
        ),
        // 只有唯一写者会走到这里（见 isLiveWriter）；watch 始终落盘，
        // 外部改动由 syncPersistedTarget 采纳后再回写。
        watch: [...watchedSessions],
      })
    atomicWrite(STATE_PATH, body, PRIVATE_FILE_MODE)
    // R2686：通知同进程模块状态已更新（auto-continue 可立即失效 prefs 缓存，
    // 不必等 10s TTL）；事件只带 path，订阅方自行读取，避免复制正文。
    emit("state:changed", { path: STATE_PATH, at: Date.now() })
    lastSavedPinIds = new Set(pinQueue.map((qq) => qq.id))
    stateSavedAt = Date.now()
    stateSavedBytes = body.length
    // R1724：front 可能在本函数里被改过 → 顺手把 loop-ctl 的 sids 对齐（自身有节流）。
    syncLoopCtlSids()
  } catch (err) {
    // 保存失败此前是**完全静默**的（整段一个 catch 吞掉）。这导致"状态文件冻住"
    // 十几分钟都没人发现，而它的后果是：队列条目留在文件里 → 重载后重复注入、
    // 计数/历史不落盘、置顶记录清不掉。现在必须留痕。
    stateSaveFails++
    const msg = `state save FAILED x${stateSaveFails}: ${String(err).slice(0, 160)}`
    // diag() 自带时间戳 + 统一脱敏（R1853）
    diag(msg)
    try {
      console.error(`${new Date().toISOString()} ${redactSecrets(msg)}`)
    } catch {
      /* ignore */
    }
  }
}
// 顶层加载必须遵守 BOOTSTRAP_BOT 约定：带 `?bot=<id>` 的实例此时 STATE_PATH 还是
// **默认值（主 Bot 的文件）**，加载它会把主实例的 pinqueue/front/offset/qpin 读进
// 备用实例的内存。实测后果：备用 Bot 把**主会话的队列条目**注入到主会话
// （pinject delivered sid=ses_sanitized04… 出现在 [alt] 日志里），也就是用户看到的
// "两个 Bot 都回同一条消息"。真正的加载由 configureBot() 在微任务里做（路径已就位）。
if (!BOOTSTRAP_BOT) loadPersistedState()
const clean = (s: unknown, n: number): string =>
  safeCut(stripLogControls(String(s ?? "")).replace(/\s+/g, " ").trim(), n)
const POLL_MS = Number(process.env.TG_POLL_MS ?? "2000") || 2000
// R1885：`/api/session` 的取回条数。实测服务端默认只给最近 50 个，而项目内实有 125 个 ——
// 不显式要数量，会话选择闸口会把「排在 50 名之外但真实存在」的会话误判为不存在。
// 注意：这**只能**走裸 HTTP；宿主内置 client 不转发 limit 参数（见 refreshSessionTitles 注释）。
// 取一个远大于本地各上限的数：本地最多也就 WATCH_MAX=8 条镜像 + LOOP_SESSIONS_CAP=16，
// 而这份列表的用途是**存在性判据**，宁全勿缺（多取的成本只是几十个标题字符串）。
const SESSION_LIST_LIMIT = 1000
const ACTIVE_WINDOW_MS = 10 * 60_000
const STOP_NOTIFY_MS = 60_000

// R2685/R2686（运营者：「统一时间地区」）：时区来源仍保留 tg.env 的 TG_TZ
// 覆盖，但格式化实现只此一份（time-format.ts），出口面板共用同一条路径。
const TZ = process.env.TG_TZ ?? loadFileEnv(CONFIG_PATH).TG_TZ ?? DEFAULT_TZ
const { fmtClock, fmtTime, fmtIsoTime } = createTimeFormats(TZ)

const HARNESS_NOISE = [
  "Could not find oldString",
  "Found multiple matches for oldString",
  "Tool execution aborted",
]
const isHarnessNoise = (s: unknown): boolean => {
  try {
    const t = String(s ?? "")
    return HARNESS_NOISE.some((p) => t.includes(p))
  } catch {
    return false
  }
}

/**
 * R2561（D7）：宿主的 `outcome` 是英文枚举（succeeded/failed/cancelled…），而状态卡与
 * `/info` 是中文界面；旧实现直接拼接，运营者看到「状态=succeeded（空闲 1m）」。
 * 统一映射为中文；不认识的取值原样返回（宁可显示原值，也不吞掉诊断信息）。
 */
export const outcomeLabel = (raw: unknown): string => {
  const s = String(raw ?? "").trim()
  if (!s) return "未知"
  const map: Record<string, string> = {
    succeeded: "完成",
    success: "完成",
    failed: "失败",
    failure: "失败",
    cancelled: "已取消",
    canceled: "已取消",
    interrupted: "已中断",
    running: "运行中",
    busy: "运行中",
    idle: "空闲",
    unknown: "未知",
  }
  return map[s.toLowerCase()] ?? s
}

// ---------------------------------------------------------------------------
// R2228 循环注入状态卡（用户需求演进：逐条提醒刷屏 → 单张可编辑状态卡 + 置顶）。
// 纯函数 + 状态文件读写放模块级：文案与落盘可单测，不必起桥。
// 卡片 id 持久化到配置目录（/tmp 在进程重启会被清空，见 R1786 实录），热重载后
// 仍编辑同一条消息，不会每次重启都新建一张卡。
export type InjectCardState = {
  msgID?: number
  count: number
  lastAt: number
  lastKind: string
  lastSid: string
  avgGapMs: number
  /** R2577：卡片创建时间；缺失（旧状态文件）视为很旧，允许一次重建。 */
  cardAt?: number
  /** R2577：最近一次校验到的真实置顶状态；undefined = 尚未校验。 */
  pinOk?: boolean
  pinCheckedAt?: number
  pinFail?: number
  pinRecreatedAt?: number
}
const INJECT_CARD_KEY_RE = /^[A-Za-z0-9_-]+$/
export const injectCardStatePath = (bot: string): string =>
  `REDACTED_ROOT/.config/opencode/inject-card-${INJECT_CARD_KEY_RE.test(bot) ? bot : "x"}.json`
export const readInjectCardState = (bot: string): InjectCardState => {
  try {
    const j = JSON.parse(readFileSync(injectCardStatePath(bot), "utf8")) as any
    return {
      msgID: Number.isInteger(j?.msgID) && j.msgID > 0 ? Number(j.msgID) : undefined,
      count: Number.isInteger(j?.count) && j.count > 0 ? j.count : 0,
      lastAt: Number(j?.lastAt) > 0 ? Number(j.lastAt) : 0,
      lastKind: j?.lastKind === "quota" ? "quota" : j?.lastKind === "recover" ? "recover" : "round",
      lastSid: typeof j?.lastSid === "string" ? j.lastSid : "",
      avgGapMs: Number(j?.avgGapMs) > 0 ? Number(j.avgGapMs) : 0,
      cardAt: Number(j?.cardAt) > 0 ? Number(j.cardAt) : 0,
      pinOk: j?.pinOk === true ? true : j?.pinOk === false ? false : undefined,
      pinCheckedAt: Number(j?.pinCheckedAt) > 0 ? Number(j.pinCheckedAt) : 0,
      pinFail: Number.isInteger(j?.pinFail) && j.pinFail > 0 ? Number(j.pinFail) : 0,
      pinRecreatedAt: Number(j?.pinRecreatedAt) > 0 ? Number(j.pinRecreatedAt) : 0,
    }
  } catch {
    // 文件不存在/损坏都按空态处理：宁可从 0 重计，也不能让一张坏文件卡死注入提醒
    return { count: 0, lastAt: 0, lastKind: "round", lastSid: "", avgGapMs: 0 }
  }
}
export const writeInjectCardState = (bot: string, st: InjectCardState): void => {
  if (!INJECT_CARD_KEY_RE.test(bot)) return
  try {
    writeFileSync(
      injectCardStatePath(bot),
      JSON.stringify({
        msgID: st.msgID,
        count: st.count,
        lastAt: st.lastAt,
        lastKind: st.lastKind,
        lastSid: st.lastSid,
        avgGapMs: st.avgGapMs,
        cardAt: st.cardAt,
        pinOk: st.pinOk,
        pinCheckedAt: st.pinCheckedAt,
        pinFail: st.pinFail,
        pinRecreatedAt: st.pinRecreatedAt,
      }),
      // R941 (D3): create the card state 0600 like every other runtime state
      // file. The default umask made it 0644 on create (observed after the
      // 2026-10-21 factory reset); the boot-time normalization now covers
      // restored files, this covers files created during a run.
      { encoding: "utf8", mode: PRIVATE_FILE_MODE },
    )
  } catch {
    /* best-effort：落盘失败只影响重载后的卡 id 复用，下次创建会自愈 */
  }
}
/**
 * R2508：插件启动时会把 token 鉴权失败的 Bot 写进 tg-token-invalid.json（不含 token）。
 * 状态卡把 id 列出来，避免运营者只看到 bot4 沉默却不知道原因。
 * R2593（D4）：同时读出原因，区分「token 被拒」与「与其它 Bot 同号」——
 * 后者换 token 没用，必须删掉重复条目。
 */
export const readInvalidBotDetails = (): Array<{ id: string; desc: string }> => {
  try {
    const j = JSON.parse(
      readFileSync(`REDACTED_ROOT/.config/opencode/tg-token-invalid.json`, "utf8"),
    ) as any
    const arr = Array.isArray(j?.bots) ? j.bots : []
    return arr
      .map((b: any) => ({
        id: String(b?.id ?? ""),
        // 只作展示：去控制字符并限长，避免 Telegram 错误串破版。
        desc: stripLogControls(String(b?.desc ?? "")).slice(0, 120),
      }))
      .filter((b: { id: string }) => /^[a-z0-9_-]{1,24}$/i.test(b.id))
      .slice(0, 8)
  } catch {
    return []
  }
}
export const readInvalidBotIds = (): string[] => readInvalidBotDetails().map((b) => b.id)
/** R2593（D4）：把 Telegram 错误归类成运营者可行动的一句话。 */
export const invalidBotReasonLabel = (desc: string): string => {
  const d = String(desc ?? "")
  if (/duplicate bot id/i.test(d)) return "与其它 Bot 同号"
  if (/unauthori[sz]ed|401/i.test(d)) return "token 被拒"
  if (/token missing/i.test(d)) return "缺 token"
  if (/network|timeout|fetch|ENOTFOUND|ECONN|ETIMEDOUT/i.test(d)) return "校验失败"
  return "不可用"
}
/**
 * R2542（D7）：状态卡面向运营者，离线 Bot 与菜单一样用注册表显示名，不暴露内部 id。
 * 日志仍保留原始 id，便于与 tg-token-invalid.json / 注册表对照。
 */
export const invalidBotDisplayNames = (ids: string[] = readInvalidBotIds()): string =>
  ids.map((id) => botDisplayName(id)).join(", ")
// R2701：状态卡/注入短消息的纯渲染已上收到 tg-cards；这里注入桥解析过的 fmtTime。
const cardRenderers = createCardRenderers({ fmtTime })
export const injectCardText = cardRenderers.injectCardText
export const injectNoticeText = cardRenderers.injectNoticeText
// 同一条注入可能被多个 Bot 实例同时看见（共享会话 / 热重载）；短消息只发一次。
const INJECT_NOTICE_DEDUPE_KEY = "__oc_inject_notice_dedupe__"
const claimInjectNotice = (sid: string, kind: string, now: number): boolean => {
  const g = globalThis as Record<string, any>
  let m = g[INJECT_NOTICE_DEDUPE_KEY] as Map<string, number> | undefined
  if (!(m instanceof Map)) {
    m = new Map<string, number>()
    g[INJECT_NOTICE_DEDUPE_KEY] = m
  }
  const key = `${kind}:${sid}`
  const last = m.get(key) ?? 0
  if (now - last < 10_000) return false
  m.set(key, now)
  return true
}

/**
 * AI 改标题：提示词与结果清洗（纯函数，便于单测/复用）。
 *
 * 宿主 `POST /api/session/{id}/generate` 只返回临时文本，不会改历史；真正落标题由
 * 桥接再调 `PATCH /api/session/{id}`。模型偶尔会带回引号、Markdown、`标题：` 前缀或
 * 循环标记，这里统一洗掉，避免把解释段落/换行写进会话标题。
 */
export const AI_TITLE_PROMPT =
  "请根据当前会话最近的上下文，生成一个简洁、具体的中文标题，最多 24 个汉字。" +
  "只输出标题本身，不要引号、序号、解释、换行或 [LOOP] 标记。"

export const sanitizeAiTitle = (raw: unknown, max = 48): string => {
  // 只取第一条非空行：模型即使无视"只输出标题"，后续解释也不会被写进标题。
  const firstLine = String(raw ?? "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .find((x) => x.length > 0) ?? ""
  let s = firstLine
    .replace(/<[^>]{0,200}>/g, " ")
    .replace(/\[LOOP(?::OFF)?\]/gi, " ")
    // 控制字符与零宽/方向控制字符：标题里只保留可见文本。
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]+/g, " ")
    .replace(/[*_`~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  s = s.replace(/^["'“”‘’「」『』《》【】]+|["'“”‘’「」『』《》【】]+$/g, "").trim()
  s = s.replace(/^(?:标题|会话标题|title)\s*[:：\-]\s*/i, "").trim()
  s = s.replace(/^(?:[-–—•·]|\d+[.、)）])\s*/, "").trim()
  return Array.from(s).slice(0, Math.max(1, max)).join("").trim()
}

// 纯函数：HTML 消息卡片渲染（可单测，2026-09-29 抽出）。
// 约定 = **调用方必须传未转义的原始文本**（title 与 body 都别预转义），本函数统一 htmlEsc 一次。
// ⚠️ 踩坑实录（2026-09-29 用户实测）：曾有调用方把已转义的 "&lt;1%"（ctxSuffix 预转义产物）
// 传进来做标题 → 本函数二次转义成 "&amp;lt;1%" → Telegram 解一层 → 用户看到字面 "&lt;1%"。
/**
 * R1716：只复活**配对正确**的标签（`&lt;pre&gt;`/`&lt;b&gt;` 这类转义实体 → 真标签）。
 *
 * 缺陷实锤（2026-10-01 00:58）：旧实现是**无条件全局替换**
 * `.replace(/&lt;pre&gt;/g,"<pre>")…`。但正文/思考里会**字面**出现 `<pre>`、`</pre>`
 * （讲代码片段时），htmlEsc 后同样是 `&lt;/pre&gt;`，被无差别复活成真标签 →
 * 凭空多出未配对标签 → 发送前 `validateHtmlText` 报「标签错位: </pre> 对应的是 <b>」
 * → 走剥标签纯文本降级重发（格式丢失、消息可能重复）。
 *
 * 这里改成栈式（LIFO）配对：只有能被正确闭合的标签才还原；落单的保持转义，
 * 用户看到的是字面文本 `<pre>`，而不是结构错乱的坏 HTML。
 */
export const revivePairedEntities = (s: string, tags: readonly string[]): string => {
  let out = String(s ?? "")
  if (!out.includes("&lt;")) return out
  // R2389：**必须把全部标签放在同一个栈里配对**。
  // 旧实现是「每个 tag 各自跑一遍栈」，于是每个标签都"有开有关"但**整体交叉**的转义集合
  // 会被全部复活成非法 HTML：`&lt;b&gt;&lt;pre&gt;&lt;/b&gt;&lt;/pre&gt;`（字面 `&lt;b&gt;&lt;pre&gt;&lt;/b&gt;&lt;/pre&gt;`）
  // → 复活成 `<b><pre></b></pre>`（交叉）→ `validateHtmlText` 报「标签错位: </b> 对应的是 <pre>」
  // → 走剥标签纯文本降级（格式丢失、消息可能重复）—— 与本函数"只复活**配对正确**的标签"
  // 的契约直接矛盾（模糊测试 3000 例可稳定命中）。改单遍栈式配对，且**名称不匹配的闭标签
  // 不消费栈**（该开标签仍可能被稍后正确闭合）→ 只有全局正确嵌套的才还原。
  const names = [...tags].sort((a, b) => b.length - a.length) // 长名优先，避免 b 抢 blockquote
  if (names.length === 0) return out
  // 转义态的标签形如 &lt;b&gt; / &lt;/b&gt; / &lt;pre class="language-x"&gt;
  const re = new RegExp(`&lt;(/?)(${names.join("|")})(?:&gt;|\\s[^&]*?&gt;)`, "g")
  const toks: Array<{ start: number; end: number; close: boolean; name: string }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(out)) !== null) toks.push({ start: m.index, end: m.index + m[0].length, close: m[1] === "/", name: m[2] ?? "" })
  if (toks.length === 0) return out
  const stack: number[] = []
  const paired: boolean[] = new Array(toks.length).fill(false)
  for (let i = 0; i < toks.length; i++) {
    if (!toks[i].close) stack.push(i)
    else if (stack.length > 0 && toks[stack[stack.length - 1]].name === toks[i].name) {
      const open = stack.pop() as number
      paired[open] = true
      paired[i] = true
    }
    // 名称不匹配的闭标签：不消费栈，保持转义
  }
  if (!paired.some(Boolean)) return out // 全是落单标签 → 一律保持转义
  let res = ""
  let last = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    res += out.slice(last, t.start)
    const raw = out.slice(t.start, t.end)
    res += paired[i] ? raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">") : raw
    last = t.end
  }
  return res + out.slice(last)
}

export const renderProtoBlock = (title: string, body: string): string => {
  const lines = String(body ?? "").split("\n").map((l) => htmlEsc(l))
  // 标题的 <b> 是我们自己生成的真标签（不需复活）；body 里被转义的真标签按配对情况复活。
  // R2644（operator: "不要这些标签直接出现给我看"）：`i`/`em` 之前不在复活名单里，
  // 于是 compact-notice（<i>宿主直接报告…</i>）、ctx 提醒（<i>等到撞墙…</i>）、
  // 循环等待提示（<i>循环在等…</i>）这些**本来想显示斜体**的 body 被 htmlEsc 后
  // 只能以字面 `&lt;i&gt;…` 送到用户面前。补上 i/em 后，配对的斜体标签恢复成真标签；
  // 仍然是 LIFO 配对，落单标签保持转义（不会凭空制造非法 HTML）。
  const html = revivePairedEntities(`<b>${htmlEsc(title)}</b>\n${lines.join("\n")}`, ["b", "i", "em", "pre"])
  // 落单的 <i>/<em> 不能复活（会造出非法 HTML），但也不能以 `&lt;i&gt;` 的字面形态露给用户。
  // 只清掉这两种斜体标签的残余实体；其它未知尖括号（模型的 <revision> 等）是内容，原样保留。
  return html.replace(/&lt;\/?(?:i|em)&gt;/g, "")
}

export const mdBoldToHtml = (s: string): string => {
  const t = String(s ?? "")
  const holes: string[] = []
  const prot = t.replace(/```[\s\S]*?(```|$)/g, (m) => {
    holes.push(m)
    return `${holes.length - 1}`
  })
  const conv = prot.split("`").map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>"))).join("`")
  return conv.replace(/(\d+)/g, (_, n) => holes[Number(n)] ?? "")
}

// R1605：截断可能在 <pre> 内切断（正文 1200 上限）——未闭合则补 </pre>，防 TG HTML 非法触发降级重发。
export const closeUnclosedPre = (s: string): string => {
  const t = String(s ?? "")
  return (t.match(/<pre>/g) ?? []).length > (t.match(/<\/pre>/g) ?? []).length ? `${t}</pre>` : t
}

// R1602（用户真实指令「表格没有转化」）：Markdown 表格 → <pre> 等宽块。
// R1715（用户真实指令「等宽字符更好看 + 格内自动换行匹配手机」）：不再原样塞管道符，
// 解析表头/数据后用 renderTgTable(wrap:true) 画等宽框线表格 —— 代码块恒等宽、
// 长格自动换行成多行、整表总宽 ≤42 不横溢，手机端可读且不丢内容。
// 旧行为：正文只 mdBoldToHtml（**→<b>），表格管道符原样送出，TG HTML 无 <table> → 用户见原始 | a | b |。
// 判据：连续 ≥2 行且含「仅由 -|:空格 构成、含 | 与 -」的分隔行；跳过 ``` 围栏；非表格管道行不误包。
export const mdTableToHtml = (s: string): string => {
  const lines = String(s ?? "").split("\n")
  // R1721 Bug C：模型输出的表行**常常没有首/尾管道符**（`项 | 状态 | 证据`）。
  // 原判据 `/^\s*\|.*\|\s*$/` 会把这类行判为「非行」→ flush() 提前切断 run →
  // parseRunTables 的数据行 while 零次进入 → **渲染出只有表头的空表**，
  // 且这些行以裸管道文本泄漏到 </pre> 之外（用户看到空框线表 + 一堆 `| … |` 原文）。
  // 现在：只要含管道符就算候选行；真正的「是不是表」交给 run 级判据（≥2 行 + 含分隔行 +
  // **至少 1 个数据行**，见 flush/parseRunTables）—— 无分隔行的 run 依旧原样输出，
  // 所以放宽 isRow 不会把普通正文（含 | 的句子）吞进表格。
  const isRow = (l: string): boolean => l.includes("|") && l.trim().length > 0
  const isSep = (l: string): boolean => {
    const t = l.trim()
    // 分隔行 = 仅由 - | : 空格 组成，且至少含一个 | 与一个 -（正统表分隔行）
    return t.includes("|") && t.includes("-") && /^[-|:\s]+$/.test(t)
  }
  // 单元格净化：去两边管道、去先行 mdBoldToHtml 留下的 <b> 标签（TG <pre> 内嵌套实体不稳，
  // 且标签会破坏可视宽度计算）、去残留 **，再 trim。
  const parseRow = (l: string): string[] =>
    String(l)
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      // R1838：只去 mdBoldToHtml 产生的 `<b>`/`</b>`（原用 `/<[^>]*>/g` 会把单元格里任何
      // `<...>` 内容（如 `p <b>q` 之外的 `<div>`、比较式 `x < y > z`）**整段吞掉**）。
      // 其余尖括号内容保留，交给外层 htmlEsc 安全转义后原样显示。
      // R2377：额外剥 `<pre>`/`</pre>`——单元格里若残留裸 `<pre>`，会与表格外层的真 `<pre>`
      // 在 revivePairedEntities 里**错配**（抢占外层闭合）→ 外层开头被转义成字面 `&lt;pre&gt;`。
      // 与剥 `<b>` 同理：这是我们的包装标签，不该出现在单元格文本里。
      .map((c) => c.replace(/<\/?b\s*>/g, "").replace(/<\/?pre\s*>/g, "").replace(/\*\*/g, "").trim())
  // 把 run（连续管道行）解析成「表头+分隔行+数据行」的表序列；无法配对成表的行归入 rest。
  const parseRunTables = (run: string[]): { tables: Array<{ h: string[]; rows: string[][] }>; rest: string[] } => {
    const tables: Array<{ h: string[]; rows: string[][] }> = []
    const rest: string[] = []
    let i = 0
    while (i < run.length) {
      if (i + 1 < run.length && isSep(run[i + 1])) {
        const start = i
        const h = parseRow(run[i])
        i += 2
        const rows: string[][] = []
        while (i < run.length && isRow(run[i]) && !isSep(run[i])) {
          rows.push(parseRow(run[i]))
          i++
        }
        // R1721 Bug C：**没有任何数据行就不算表** —— 只出现「表头 + 分隔行」时，
        // 画出来的是「空壳表」（有表头、零行数据），比不画更糟；模型输出里
        // 「表头 + 分隔行」单独出现很常见（表格被分片截断就是这种形状）。
        // 这种情况把整个 run 片段（表头+分隔行）原样归入 rest → 内容零丢失、
        // 不会出现「空框线表 + 裸管道行泄漏到 </pre> 外」的破相输出。
        if (rows.length === 0) {
          for (let k = start; k < i; k++) rest.push(run[k])
          continue
        }
        tables.push({ h, rows })
      } else {
        rest.push(run[i])
        i++
      }
    }
    return { tables, rest }
  }
  const out: string[] = []
  let inFence = false
  let run: string[] = []
  let runHasSep = false
  const flush = (): void => {
    // 表格判据：连续行 ≥2 且含分隔行（防普通带 | 的正文误包）
    if (run.length >= 2 && runHasSep) {
      const { tables, rest } = parseRunTables(run)
      if (tables.length > 0 || rest.length > 0) {
        for (const tb of tables) {
          const body = renderTgTable(tb.h, tb.rows, { wrap: true, fence: false })
          // R2377：**不再**在此对表格正文做 htmlEsc（那是 R1838 的旧改动，已被证明会双重转义）。
          // 本函数的两处调用方（L5280 正链 / L9652 补发链）都会把返回值再喂给 `renderProtoBlock`，
          // 后者对每行 htmlEsc 一次**并** revivePairedEntities 复活配对的 `<pre>`/`<b>`。
          // 若这里先转义一次，单元格里的 `&`/`<`/`>` 会被**二次转义**——实测表格 `a & b`
          // 显示成字面 `a &amp; b`（revivePairedEntities 只复活外层 `<pre>` 包装，还原不了内层
          // 双重转义）。故这里只发真实 `<pre>` 标签 + **原始**单元格文本，转义统一交给
          // renderProtoBlock 的"转义一次 + 配对复活"（与 mdBoldToHtml 产出的真实 `<b>` 同一条路）。
          out.push(`<pre>${body}</pre>`)
        }
        if (rest.length > 0) out.push(...rest)
      } else out.push(`<pre>${run.join("\n")}</pre>`)
    } else out.push(...run)
    run = []
    runHasSep = false
  }
  for (const l of lines) {
    if (/^\s*```/.test(l)) { flush(); inFence = !inFence; out.push(l); continue }
    if (inFence) { flush(); out.push(l); continue }
    if (isRow(l)) { run.push(l); if (isSep(l)) runHasSep = true; continue }
    flush()
    out.push(l)
  }
  flush()
  return out.join("\n")
}

// R2426：trap-log 的**服务标签**是 `[tg-bridge/<bot>]` / `[tg-bridge/primary]`（斜杠，
// 见 /tmp/opencode/v2plugin.log），而非裸 `[tg-bridge]`。旧正则的两条**行首锚定**分支
// 写死 `\[(tg-bridge|auto-continue)\]`，对真实格式**永不命中** → 用户 `tail` 桥日志时
// 约 56% 的内部行（demote/ctx/watch 等无内容子串可命中的）原样泄漏进 TG 预览。
// 放宽为「标签名后可跟 `/标签` 或 `:标签`」（不匹配 `tg-bridge-v2`，其首字符为 `-`）。
const INTERNAL_LOG_LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\S*\s+\[(tg-bridge|auto-continue)(?:[/:][^\]]*)?\]|auto-continue: eval|getUpdates failed|proto (send|edit) (ok|failed|drop)|answerCallback|cb (recv|refresh|full)|^\[(tg-bridge|auto-continue)(?:[/:][^\]]*)?\]/
export const stripInternalLogs = (text: string): { text: string; stripped: number } => {
  const lines = String(text ?? "").split("\n")
  const keep = lines.filter((l) => !INTERNAL_LOG_LINE_RE.test(l))
  return { text: keep.join("\n"), stripped: lines.length - keep.length }
}

export const parseEditInput = (raw: unknown): { path: string; oldS: string; newS: string } | null => {
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw
    if (!o || typeof o !== "object") return null
    const oldS = (o as any).oldString
    const newS = (o as any).newString
    if (typeof oldS !== "string" || typeof newS !== "string") return null
    const path = typeof (o as any).path === "string" ? (o as any).path : ""
    return { path, oldS, newS }
  } catch {
    return null
  }
}

export const stripExitTail = (text: string): { text: string; exit: number | null } => {
  const lines = String(text ?? "").split("\n")
  if (lines.length === 0) return { text: String(text ?? ""), exit: null }
  const m = lines[lines.length - 1].trim().match(/^Command exited with code (\d+)\.?$/)
  if (!m) return { text: String(text ?? ""), exit: null }
  return { text: lines.slice(0, -1).join("\n").trimEnd(), exit: Number(m[1]) }
}

const TS_MARK_RE = /(^\s*(import|export)\s+)|(^\s*(const|let|var|function|interface|type|class|enum)\s+[\w${\[])|=>|:\s*(string|number|boolean|void|any|unknown|never)\b/
export const detectOutLang = (tool: string, text: string): string => {
  if (tool === "edit") return "diff"
  if (tool !== "shell" && tool !== "bash") return ""
  return TS_MARK_RE.test(String(text ?? "")) ? "typescript" : ""
}

export const editDiff = (oldS: string, newS: string, maxLines = 80): { text: string; plus: number; minus: number; omitted: number; key: string[] } => {
  let a = String(oldS ?? "") === "" ? [] : String(oldS ?? "").split("\n")
  let b = String(newS ?? "") === "" ? [] : String(newS ?? "").split("\n")
  if (a.length * b.length > 400000) {
    a = a.slice(0, 150)
    b = b.slice(0, 150)
  }
  const m = a.length
  const n = b.length
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i]
    const nxt = dp[i + 1]
    const ai = a[i]
    for (let j = n - 1; j >= 0; j--) {
      row[j] = ai === b[j] ? (nxt[j + 1] + 1) as number : Math.max(nxt[j], row[j + 1])
    }
  }
  type Op = { t: " " | "-" | "+"; s: string }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", s: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: "-", s: a[i] })
      i++
    } else {
      ops.push({ t: "+", s: b[j] })
      j++
    }
  }
  while (i < m) {
    ops.push({ t: "-", s: a[i++] })
  }
  while (j < n) {
    ops.push({ t: "+", s: b[j++] })
  }
  let plus = 0
  let minus = 0
  const key: string[] = []
  for (const o of ops) {
    if (o.t === "+") {
      plus++
      if (key.length < 3) key.push(`+ ${o.s.trim().slice(0, 60)}`)
    } else if (o.t === "-") {
      minus++
      if (key.length < 3) key.push(`- ${o.s.trim().slice(0, 60)}`)
    }
  }
  const out: string[] = []
  let k = 0
  while (k < ops.length) {
    if (ops[k].t !== " ") {
      out.push(`${ops[k].t} ${ops[k].s}`)
      k++
      continue
    }
    let e = k
    while (e < ops.length && ops[e].t === " ") e++
    const run = e - k
    if (run > 8) {
      out.push(`  ${ops[k].s}`, `  ${ops[k + 1].s}`, `  …（${run - 4} 行未变）`, `  ${ops[e - 2].s}`, `  ${ops[e - 1].s}`)
    } else {
      for (let x = k; x < e; x++) out.push(`  ${ops[x].s}`)
    }
    k = e
  }
  let omitted = 0
  let text = out.join("\n")
  if (out.length > maxLines) {
    omitted = out.length - maxLines
    text = out.slice(0, maxLines).join("\n") + `\n…（其余 ${omitted} 行省略）`
  }
  if (text.trim() === "") text = "(无差异)"
  return { text, plus, minus, omitted, key }
}

const SOURCE = (() => {
  try {
    return new URL(import.meta.url).pathname
  } catch {
    return "unknown"
  }
})()

/**
 * ROUND 10（D3）：`proto` 落盘存的是**工具卡片原文**（含 shell 命令行，历史上多次把 bot
 * token 字面量写进去）。`redactSecrets` 此前只接在**日志出口**（console.error / restore diag），
 * 漏掉了这条**持久化**路径 —— 于是 token 进入状态文件、`$HOME` 快照 tar、乃至 release 资产。
 *
 * 这里在**源头**（load + save 两处）对 proto 文本脱敏。替换串刻意用 HTML 实体
 * `&lt;redacted&gt;`：proto 文本会原样编辑回 Telegram（parse_mode=HTML），裸 `<redacted>`
 * 会被 Telegram 当成**未知标签**报 400，而实体是合法文本、显示即 `<redacted>`。
 */
const protoRedact = (s: string): string => redactSecrets(s).split("<redacted>").join("&lt;redacted&gt;")
const sanitizeLog = (s: unknown): string => {
  let out = stripLogControls(String(s))
  // 再兜一层：把本进程真实持有的 token 值直接抹掉（不依赖它长得像不像 token）
  if (TOKEN.length >= 20) out = out.split(TOKEN).join("<TOKEN>")
  return shrinkLogIds(redactSecrets(out)).slice(0, 300)
}

// R2707：诊断命令输出集中到 tg-diagnostics；token/version 用 getter，保持运行期现读。
const diagnostics = createDiagnostics({
  fmtTime,
  sanitizeLog,
  token: () => TOKEN,
  version: () => VERSION,
})

const partsOf = (m: any): any[] => (Array.isArray(m?.parts) ? m.parts : [])
const hasQuestionPart = (m: any): boolean => {
  try {
    return partsOf(m).some((p: any) => p?.type === "tool" && String(p?.tool ?? "") === "question")
  } catch {
    return false
  }
}
// 询问作答 token：q:<tok> → {sid, answer}，一次性，30条上限，重启失效
const qMap = new Map<string, { sid: string; answer: string; ts: number }>()
const makeQ = (sid: string, answer: string): string => {
  const token = Math.random().toString(36).slice(2, 8)
  qMap.set(token, { sid, answer, ts: Date.now() })
  if (qMap.size > 30) {
    const k = qMap.keys().next().value
    if (k !== undefined) qMap.delete(k)
  }
  // 回调数据上限 64 **字节**（不是字符！中文 1 字 = 3 字节）。曾经按字符数判断，
  // `qa:<30 字符 sid>|<12 汉字>` = 73 字节 → 预检报"callback_data 超 64 字节"，
  // 按钮整卡丢失。内联方案现在只作为**兜底**，且严格按字节裁剪。
  const budget = 64 - 3 - sid.length - 1
  if (budget >= 6) {
    let shortAns = ""
    for (const ch of answer) {
      if (Buffer.byteLength(shortAns + ch, "utf8") > budget - 3) break
      shortAns += ch
    }
    const inline = `qa:${sid}|${shortAns}`
    if (Buffer.byteLength(inline, "utf8") <= 64) return inline
  }
  return `q:${token}`
}

// R1862：解析内联作答回调 `qa:<sid>|<答案>`（makeQ 的逆）。**答案可以是任意选项文本**
// （用户问题的 label），里面可能含 `:`；而 callback_data 以 `:` 分隔字段，若调用方只取
// `data.split(":")[1]`，答案会在**首个冒号处被静默截断**（例：选项 "A: B" 实际只发出 "A"）。
// 这里从首个 `|` 切分（sid 恒为 `ses_…`，不含 `|`/`:`），`|` 之后的全部（含冒号）都是答案。
export const parseAskInline = (data: string): { sid: string; ans: string } => {
  const s = String(data ?? "")
  const rest = s.startsWith("qa:") ? s.slice(3) : ""
  const sep = rest.indexOf("|")
  return sep >= 0 ? { sid: rest.slice(0, sep), ans: rest.slice(sep + 1) } : { sid: rest, ans: "" }
}

const isAllowed = (chat: any): boolean => {
  const id = String(chat?.id ?? "")
  if (id && allowedNorm.has(id)) return true
  const uname = chat?.username ? String(chat.username).replace(/^@/, "") : ""
  if (uname && allowedNorm.has(uname)) return true
  // 形态换算：白名单里配的是**用户名**（如 alice），而某些更新只带**数字 chat id**
  // （或反之）→ 直接比对会判成"非白名单"并**静默丢弃**这条消息。
  // 症状：备用 Bot 收得到按钮回调（回调路径不过白名单）却收不到任何文字 —— 用户报"消息丢失"。
  // 这里用 knownNumericChatIDs（本进程已确认、且随状态文件落盘的"用户名 ↔ 数字 id"映射）
  // 做**等价换算**：只有当白名单里那一项本来就指向这个 chat 时才放行，不扩大白名单范围。
  if (id && [...allowedNorm].some((a) => knownNumericChatIDs.get(a) === id)) return true
  if (uname && [...allowedNorm].some((a) => knownNumericChatIDs.get(a) === uname || a === uname)) return true
  return false
}

const chatTarget = (chat: any): string => {
  const id = String(chat?.id ?? "")
  if (id) return id
  const uname = chat?.username ? String(chat.username) : ""
  return uname ? `@${uname}` : ""
}

/** ── Telegram payload 自检（发送前） ──────────────────────────────────
 * 400 最常见的三类原因：HTML 标签/实体不合法、inline_keyboard 结构不合法、
 * callback_data 超过 64 字节。线上只看到 "400"，定位全靠猜；这里在发送前
 * 把问题定位到具体字段，并导出为纯函数便于离线单测。
 */
/**
 * 从 staleToolBorn / protoMap 的工具 key 里取出 callID。
 *
 * 为什么不能写死下标：这类 key 有**两种**形态 ——
 *   `ses_xxx:tool:<callID>:input`  running 分支注册的形态（看门狗跟踪的就是它）
 *   `ses_xxx:tool:<callID>`        完成分支 / 启动补登记回写后的形态
 * 历史上三处都按下标 3 去取 callID —— 对前者取到的是字面量 "input"、对后者取到
 * undefined，于是**永远查不到真实状态**，只能对用户写"状态未知（可能已中断）"，
 * 而真相其实就在会话里可查（两次对账日志都打成了 real=unknown，即此缺陷的铁证）。
 * 这里按前缀 ":tool:" 切分并剥掉已知后缀，两种形态都对。
 */
export const staleCallId = (key: string): string => {
  const k = String(key ?? "")
  const pre = ":tool:"
  const i = k.indexOf(pre)
  if (i < 0) return ""
  let rest = k.slice(i + pre.length)
  for (const suf of [":input", ":cont", ":output"]) {
    if (rest.endsWith(suf)) {
      rest = rest.slice(0, -suf.length)
      break
    }
  }
  return rest
}

// R1635/R1834/R1844：retry_after 解析、冷却判断、429 冷却秒数、botname-429 合并
// 已上收到 tg-transport.ts（纯函数，可直接单测）。

// R1856：纯函数 —— 有界 LRU 的 `touch`（用于 ownSessions）。
// 缺口：旧实现只有 `set.add(sid)` + 超限删首个。Set 对**已存在**元素 add **不改变顺序**，
// 所以"仍在活跃投递、但插入最早"的会话会被当成最旧淘汰，而刚重复投递的会话得不到保护。
// 淘汰后隔离门 `ownOk` 可能不再认它（`ownSessions.has` 为 false）→ 非主实例偶发
// "不再跟这个会话"（用户体感：bot3 有时不发）。改为先 delete 再 add 置尾，实现真 LRU。
// 越界时从**表头**（最久未 touch）开始删，直到回到 cap；非 ses_ 前缀直接忽略。
export const touchOwnSession = (set: Set<string>, sid: string, cap: number): void => {
  if (!sid || !sid.startsWith("ses_")) return
  set.delete(sid)
  set.add(sid)
  const limit = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : 0
  while (set.size > limit) {
    const oldest = set.values().next()
    if (oldest.done) break
    set.delete(oldest.value)
  }
}

// R1850：poll 循环 catch 的**错误分类**（纯函数，可单测）。
// 返回 true = routine/可自愈（按 info 节流记录），false = 真错误（error 上报）。
//
// 长轮询里"超时"与"对端/链路瞬断"是同一族：本轮一定结束、下一轮立刻重发，几秒内自愈。
// 旧实现只把 timeout 降级为 info，其余一律 `poll error:` 打 error —— 于是
// `GnuTLS recv error (-110)`（TLS 非正常终止）/`ECONNRESET`/`socket hang up` 这类
// **已知可恢复**的网络抖动每次都在污染"近 N 分钟 0 error"这个健康信号
//（R1779/7784 已为超时修过同一问题，这里补全同族）。判据用**错误串证据**，
// 不靠"记得忽略"的纪律；`aborted`/`abort` 归 routine（takeover 分支在前已单独处理）。
export const isRoutinePollError = (why: string): boolean => {
  const s = String(why ?? "")
  if (!s) return false
  if (/timeout|timed out|timeouterror|aborted|abort/i.test(s)) return true
  return /econnreset|econnrefused|epipe|enetunreach|enetdown|ehostunreach|eai_again|socket hang up|fetch failed|premature|gnutls|ssl|tls/i.test(s)
}

// R1861：非 2xx 响应的**状态码**判据（纯函数）—— 与 isRoutinePollError 同族。
// getUpdates 收到 5xx（Telegram/反代 500/502/503/504）是**服务端瞬时**错误：本轮未消费任何
// update、offset 不变，下一次轮询立即重试即可自愈。旧实现把**任何**非 2xx 一律
// `getUpdates failed: …` 打 error（5xx 也照打）→ 服务端抖动一次就污染"近 N 分钟 0 error"
// 健康信号（R1850 已在 catch 路径修过同一族，这里补全响应分支）。
// 但 409（同一 token 有第二个轮询者）、401/400/403 是**真错误/真配置问题**，必须保留 error：
// 409 暴露重复轮询者，坏 token 需要人介入。故判据**只认 5xx** 为 routine。
export const isRoutinePollStatus = (status: number): boolean => {
  const s = Number(status)
  return Number.isFinite(s) && s >= 500 && s < 600
}


// R2703：菜单静态表与键盘构造器已上收到 tg-menus；运行期状态仍逐次传入。
const buildMenuKeyboard = createMenuKeyboard({ clean, filt, compactPrefs, watchedSessions })
export { buildMenuKeyboard }


// R1636/R2687：速率限制退避与 inline keyboard 校验已上收到 tg-transport.ts。
// 桥内调用点（floodWaitSeconds / 发送前 precheck）保持不变。

/**
 * R921：用户可见的 Bot 名。注册表 label（@username）优先，**绝不把内部 id 暴露到界面**
 *（用户明确要求「不要搞 bot 代号，直接用用户名」）。内部状态文件仍用 id，避免破坏绑定。
 */
export const botDisplayName = (id: string, registryPath?: string): string => {
  try {
    const p = registryPath ?? `REDACTED_ROOT/.config/opencode/tg-bots.json`
    const j = JSON.parse(readFileSync(p, "utf8")) as any
    const hit = (Array.isArray(j?.bots) ? j.bots : []).find((b: any) => String(b?.id ?? "") === id)
    const label = String(hit?.label ?? "").trim().replace(/^@+/, "")
    return label ? `@${label}` : id
  } catch {
    return id
  }
}

export const TgBridgePlugin: Plugin = async ({ client }) => {
  // service.json is created by the host after restore; re-run the normalizer here
  // because the module-level call may have happened before the file existed.
  normalizePrivateConfigPerms()
  // 横幅里的 fallback 必须与运行时一致：运行时用的是 fallbackApiBase（由
  // FALLBACK_TOKEN 推导）。此前横幅读的是别的字段，出现过"横幅 set、实际 no"的自相矛盾。
  const banner = `[tg-bridge] plugin loaded (bot=${BOT_ID}, ver=${VERSION}, token=${TOKEN ? "set" : "MISSING"}, fallback=${fallbackApiBase ? "set" : "none"}, allowed=${allowedNorm.size} chat(s), push=${PUSH_CHAT || "(none)"}, watch=${watchedSessions.size}, state=${STATE_PATH}, source=${SOURCE})`
  try {
    await client.app.log({ body: { service: "tg-bridge", level: "info", message: banner } })
    // R1398 诊断：load 时 dump 客户端真实形状（session / experimental.session 键），
    // 实证 v2.0.10 运行态下 background/subagent 挂在哪个路径（免猜、免等用户）。
    try {
      const sessK = Object.keys(((client as any)?.session) ?? {}).slice(0, 40)
      const expK = Object.keys(((client as any)?.experimental?.session) ?? {}).slice(0, 40)
      await client.app.log({ body: { service: "tg-bridge", level: "info", message: `[tg-bridge] bg shape-dump: session=[${sessK.join(",")}] exp=[${expK.join(",")}]` } })
    } catch { /* 诊断失败不阻断启动 */ }
    // 启动自检：备用投递通道到底有没有被打开。此前"横幅 set / 运行时 no"自相矛盾，
    // 根因是 recomputeIdentity() 会在 configureBot 之后**再次**从 process.env 读
    // TG_FALLBACK_BOT_TOKEN（旧入口时代写进 env 的残留），把已关闭的备用通道又打开了。
    // 没有这行自检，谁也说不清主 Bot 到底会不会借另一个 Bot 的 token 发消息。
    await client.app.log({
      body: {
        service: "tg-bridge",
        level: "info",
        message: `[tg-bridge] boot self-check: bot=${BOT_ID} fallbackApiBase=${fallbackApiBase ? "set" : "none"} fallbackEnvPath=${FALLBACK_ENV_PATH ?? "(null)"} envFallbackInProcess=${process.env.TG_FALLBACK_BOT_TOKEN ? "present" : "absent"} state=${STATE_PATH}`,
      },
    })
  } catch (err) {
    console.log(`${banner} (app.log failed: ${redactSecrets(String(err))})`)
  }
  if (!TOKEN || allowedNorm.size === 0) {
    try {
      await client.app.log({
        body: { service: "tg-bridge", level: "info", message: "[tg-bridge] disabled (set TG_BOT_TOKEN + TG_ALLOWED_CHAT)" },
      })
    } catch {
      /* ignore */
    }
    return {}
  }
  // Single-owner: only the serve daemon drives TG (poll + push).
  // The TUI process loads the same plugin files; without this gate both
  // processes poll (409s) and push (duplicate TG messages) concurrently.
  const IS_SERVE = process.argv.some((a) => a === "serve") || process.env.TG_BRIDGE_FORCE_SERVE === "1"
  if (!IS_SERVE) {
    try {
      await client.app.log({
        body: { service: "tg-bridge", level: "info", message: "[tg-bridge] standby (TUI process, serve owns TG)" },
      })
    } catch {
      /* ignore */
    }
    return {}
  }

  // ── 错误爆发折叠（R967 记录的问题，本轮实现）──────────────────────────────
  // 起因：TLS 校验失败那次爆发，**59 条完全相同的 error**，把其它真错误淹没，
  // 于是"近 N 分钟 0 error"这个信号失去鉴别力（而它是我判断系统健康的主要依据）。
  // 规则：
  //   ① **只折叠 error**，绝不碰 info —— info 是我的诊断信号（`card mode=` 等），
  //      折叠它等于自己把观测手段弄瞎。
  //   ② 前 5 次照常逐条记（短时错误不能被压掉）；之后每 20 次再记一条**带计数的汇总**，
  //      汇总里保留原文 → 按关键词 grep 仍然能查到，不会"静默丢失"。
  //   ③ **被折叠的错误仍然计入错误预算**：noteError 在折叠判断之前调用（见下），
  //      所以预算不会因为折叠而变乐观 —— 这正是错误预算纪律要求的"只有没有自动兜底
  //      的失败才记 error"，折叠只影响**日志体量**，不影响**统计口径**。
  const BURST_MIN = 5
  const BURST_EVERY = 20
  const burstCount = new Map<string, number>()
  const burstSig = (lvl: string, msg: string): string =>
    `${lvl}|${msg.replace(/[0-9a-f]{8,}|[0-9]+/gi, "#").slice(0, 120)}`
  const log = async (level: "info" | "warn" | "error", rawMessage: string) => {
    // 出口脱敏：任何新增日志语句都不可能绕过（此前只有部分调用点用了 sanitizeLog）
    // R1873：脱敏之外还要**去控制字符**。redactSecrets 只认 token 形态；而外部文本
    // （TG API 的 `desc`、反代响应 body、异常 message）可含 `\n`/控制字符 → 撕裂或伪造日志行，
    // 而"近 N 分钟 0 error"正是靠**可 grep 的单行**日志判定健康。出口统一置为空格，调用点无法绕过。
    const message = stripLogControls(redactSecrets(rawMessage))
    if (level === "error") noteError(message)
    // 爆发折叠（只对 error）：前 5 次逐条记，之后每 20 次记一条带计数的汇总。
    let outMessage = message
    if (level === "error") {
      const sig = burstSig(level, message)
      const n = (burstCount.get(sig) ?? 0) + 1
      burstCount.set(sig, n)
      if (burstCount.size > 500) {
        const oldest = burstCount.keys().next()
        if (!oldest.done) burstCount.delete(oldest.value)
      }
      if (n > BURST_MIN && n % BURST_EVERY !== 0) return
      if (n > BURST_MIN) outMessage = `${message}（同签名错误累计 ${n} 次，其间每 ${BURST_EVERY} 次记一条汇总）`
    }
    try {
      // 带上 bot 标识：多 Bot 共用一个日志文件时，否则无法分辨是哪条实例写的
      await client.app.log({ body: { service: `tg-bridge/${BOT_ID}`, level, message: `[${BOT_ID}] ${outMessage}` } })
    } catch (err) {
      console.error(`[tg-bridge] ${level}: ${message} (log failed: ${redactSecrets(String(err))})`)
    }
  }

  // 注入 ctx 主动告警实现（模块级钩子，原因见 CTX_ADVISORY_Fn 的注释）
  ctxAdvisoryFn = (sessionIDArg: string, pct: number, noCache: boolean, ageS: number): void => {
    for (const step of CTX_ADVISORY_STEPS) {
      if (pct < step) continue
      const key = `${sessionIDArg}:${step}`
      if (ctxAdvisorySent.has(key)) continue
      const chat = pushChatResolve()
      if (!chat) return
      ctxAdvisorySent.add(key)
      ctxAdvisoryAt.set(key, Date.now())
      if (ctxAdvisorySent.size > 200) {
        const first = ctxAdvisorySent.values().next()
        if (!first.done) ctxAdvisorySent.delete(first.value)
      }
      const nm = clean(sessionNameOf(sessionIDArg) || "", 40) || sessionIDArg.slice(0, 12)
      const body = [
        `<b>⚠️ 上下文 ${Math.round(pct)}%</b> · ${htmlEsc(nm)}`,
        ``,
        `到达阈值时会**自动压缩**（本桥会主动调用，宿主自身也会压）；也可以现在手动压。`,
        noCache ? `注意：当前数字缺少缓存计数，是**下界**，实际更高。` : ``,
        ageS > 600 ? `该数字是 ≥${Math.round(ageS / 60)} 分钟前的采样。` : ``,
        ``,
        `到 100% 之前建议从下面选一个：`,
        `· /compact —— 立即压缩当前会话（最省事）`,
        `· /new —— 开一个全新会话（最干脆）`,
        `· /migrate —— 把当前上下文带到新会话`,
        ``,
        `<i>等到撞墙才发现就来不及了，所以提前提醒。</i>`,
      ]
        .filter((l) => l !== "")
        .join("\n")
      // ⚠️ 必须留痕：sendTextRaw 是**直接**调用的（不经过 protoSend），成功时一行日志都不打
      // → 这个提醒"发没发"在日志里完全看不出来。我因此一度以为它没触发（其实无法判断）。
      // 这与压缩探测那次是同一个毛病：只在成功路径留痕还不够，**外部要能观测到"做过"**。
      void (async () => {
        const r = await sendTextRaw(chat, protoBlock(`⚠️ ctx 提醒`, body), undefined, true)
        await log(
          "info",
          `ctx advisory sent (session=${sanitizeLog(sessionIDArg).slice(0, 14)}, step=${step}%, ` +
            `pct=${Math.round(pct)}%, result=${r.r}, len=${(r as unknown as { len?: number }).len ?? "?"})`,
        )
      })()
    }
  }

  watchSyncHook = (ids) => {
    const short = ids.map((s) => s.slice(0, 12)).join(",") || "(empty)"
    void log("info", `watch list synced (${ids.length}/${WATCH_MAX}): ${short}`)
  }

  // 手动停止必须写入循环总闸；否则只中断当前 turn，下一次 idle/定时评估会复活。
  //
  // R1724（用户指令「不同机器人的循环设置要求单独」）：原先 /loop stop 写的是**全局**闸
  // → 任一 Bot 停循环，另外两个 Bot 也一起停。现在写**单 Bot 条目**（bots[BOT_ID]），
  // sids 绑定本 Bot 当前 front 会话 → auto-continue 的 loopGateStopped 按 sid 判定，
  // 其它 Bot 不受影响。顶层 stopped 保留给守卫（PROBLEM/WEBSEARCH 仍停全部）与
  // `/loop stop all`；sids 每次 state save 刷新，front 切换后自动跟随。
  const cur_front_sid = (): string => {
    const cur = frontSessionID || persistedFront || ""
    return cur.startsWith("ses_") ? cur : ""
  }
  const writeLoopCtl = (mutate: (j: any) => void): void => {
    const cur = cur_front_sid()
    const r = mutateLoopCtlFile((j) => {
      if (cur) {
        const e = (j.bots[BOT_ID] && typeof j.bots[BOT_ID] === "object" ? j.bots[BOT_ID] : {}) as any
        e.sids = [cur]
        j.bots[BOT_ID] = e
      }
      mutate(j)
    })
    // 写失败要留痕：静默失败会让「我点了停止但 Bot 还在跑」完全无法排查（R1724 同类症状）。
    if (r === "err") {
      try {
        void log("warn", `loop-ctl write FAILED (bot=${BOT_ID}): user action may not take effect`)
      } catch {
        /* best-effort */
      }
    } else if (cur) {
      ctlSidsSynced = cur
    }
  }
  const persistLoopStop = (reason: string, scopeAll = false): void => {
    writeLoopCtl((j) => {
      if (scopeAll) {
        j.stopped = true
        j.by = "user"
        j.reason = reason.slice(0, 160)
      } else {
        j.stopped = false // 全局闸不动：只停本 Bot
        const e = (j.bots[BOT_ID] ?? {}) as any
        e.stopped = true
        e.by = "user"
        e.reason = reason.slice(0, 160)
        e.ts = Date.now()
        j.bots[BOT_ID] = e
      }
    })
    try {
      queuePinRequest?.()
    } catch {
      /* best-effort */
    }
  }
  const clearLoopStop = (): void => {
    writeLoopCtl((j) => {
      const e = (j.bots[BOT_ID] ?? {}) as any
      e.stopped = false
      e.ts = Date.now()
      // R433（R425 待办）：清闸时一并清 by/reason 残留 —— stopped=false 却留着
      // "user /loop stop" 会误导 D1/菜单判读（审计信息走日志，不留在闸文件里）。
      delete e.by
      delete e.reason
      j.bots[BOT_ID] = e
      // R2497：AI 宣告 [LOOP: PAUSE] 走的是**顶层软闸**（auto-continue 的
      // writeCtlStopped(true,"agent",…)），而本函数原先只清 bots[bot].stopped →
      // 顶层 stopped=true 仍在 → loopGateStopped 首判即停 → 用户按菜单「继续循环」
      // （= /loop start）毫无效果，实报「自动循环没了，还不能切换」。
      // agent 软闸语义 = 等用户处理完继续 → /loop start 应能清它。
      // 但 /loop stop all 写的（by="user"）是用户显式硬闸，仍只由 /loop start all 清，语义不变。
      //
      // R2498（2026-10-17 用户实报「设置界面循环按钮显示为关闭，但点击之后不能切换」）：
      // 上面这条只认 by==="agent"，而 auto-guard 停闸写的是 **by="auto-guard"** → 条件不命中
      // → 顶层 stopped:true 清不掉 → 按钮仍显示「▶️ 继续循环」，点了毫无反应
      // （当日实测 loop-ctl.json = {stopped:true, by:"auto-guard", reason:"…循环缺少 END-STATE…"}）。
      // 守卫停闸的语义同样是「等用户确认后继续」，用户亲手按「继续循环」即为该确认 → 一并放行。
      // 用**白名单**而非再加一个 ||：by="user" 的显式硬闸永不在集合内，语义边界不被侵蚀。
      if (j.stopped === true && SOFT_LOOP_GATES.has(String(j.by ?? ""))) {
        const via = String(j.by ?? "soft")
        j.stopped = false
        // R433：同理清残留 —— 原先写 by="user"/"user /loop start (cleared …)" 同样造成
        // stopped=false + by/reason 不一致；审计改走日志。
        delete j.by
        delete j.reason
        void log("info", `loop start cleared ${via} soft gate (by/reason reset)`)
      }
    })
  }

  // 收敛自 turn-end-note.ts 的 SYNTHETIC_LOOP_MARKERS（防两处前缀漂移）
  const SYNTHETIC_MARKERS = SYNTHETIC_LOOP_MARKERS
  const isSyntheticUserMsg = async (sessionID: string, msgID: string): Promise<boolean> => {
    try {
      const res = await client.session.messages({ path: { id: sessionID } })
      const messages = res.data ?? []
      if (!Array.isArray(messages) || !msgID) return false
      const hit = messages.find((m: any) => String(m?.id ?? m?.info?.id ?? "") === String(msgID))
      if (!hit) return false
      // R2659/R2663：循环注入的正文可能是“继续”或任意自定义文案，合成身份由
      // prompt metadata 承载。必须先看 metadata，不能按文本猜。
      if (rowHasLoopInjectMeta(hit)) return true
      const t = partsOf(hit)
        .filter((p: any) => p?.type === "text")
        .map((p: any) => String(p?.text ?? ""))
        .join("")
        .trim()
      return SYNTHETIC_MARKERS.some((p) => t.startsWith(p))
    } catch {
      return false
    }
  }

  const apiBase = `https://api.telegram.org/bot${TOKEN}`

  /**
   * R2577：读取聊天当前的最新置顶消息。Bot API 的 getChat 只返回一条
   * `pinned_message`（按发送时间最新），所以调用方必须结合文案判断它是不是
   * 队列卡/注入卡；返回 ok=false 表示探针本身失败（网络/429/5xx），调用方
   * 不能把它当成「没有置顶」。探针不经过 tgFetch 是因为 tgFetch 只回传
   * message_id/status，丢掉了 pinned_message 正文。
   */
  const readPinnedMessage = async (
    chat: string,
  ): Promise<{ ok: boolean; mid?: number; text: string; status?: number }> => {
    try {
      const res = await fetch(`${apiBase}/getChat?chat_id=${encodeURIComponent(chat)}`, {
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return { ok: false, text: "", status: res.status }
      const j = (await res.json()) as any
      const pm = j?.result?.pinned_message
      const mid = Number(pm?.message_id)
      return { ok: true, mid: mid > 0 ? mid : undefined, text: String(pm?.text ?? pm?.caption ?? "") }
    } catch {
      return { ok: false, text: "" }
    }
  }

  // Menu signature cache: hot reloads should not spend Telegram quota on identical commands.
  const registerMyCommands = async (): Promise<void> => {
    try {
      // 收敛后的命令面板：手机端命令菜单只暴露 7 个入口，其余功能全在 /menu 按钮菜单里。
      // 文本命令全部保留（菜单动作复用同一条处理链），只是不再占菜单位置。
      const commands = [
        { command: "menu", description: "打开控制台（全部功能）" },
        { command: "use", description: "切换会话 /use [序号|名称|前缀|ID]" },
        { command: "loop", description: "自动循环与每轮注入 /loop [start|stop|status|full|simple|custom]" },
        { command: "stop", description: "中断当前回合" },
        { command: "sessions", description: "列出会话" },
        { command: "help", description: "文本命令速查" },
        { command: "addbot", description: "登记一个新机器人 /addbot <token> [chatId]" },
      ]
      const signature = hashText(JSON.stringify(commands))
      const allScopes = [...new Set([...knownNumericChatIDs.values()].filter((cid) => /^\d+$/.test(cid)))]
      let prior: any = {}
      try {
        prior = JSON.parse(readFileSync(COMMAND_CACHE_PATH, "utf8")) as any
      } catch {
        /* first run */
      }
      const priorTs = typeof prior?.ts === "number" ? prior.ts : 0
      const fresh = priorTs > 0 && Date.now() - priorTs < COMMAND_CACHE_MAX_AGE_MS
      const globalNeeded = prior?.signature !== signature || !fresh
      const priorScopes = new Set(Array.isArray(prior?.scopes) ? prior.scopes.filter((x: unknown) => typeof x === "string") : [])
      const targetScopes = globalNeeded ? allScopes : allScopes.filter((cid) => !priorScopes.has(cid))
      if (!globalNeeded && targetScopes.length === 0) {
        await log("info", `setMyCommands cached (bot=${BOT_ID}, age=${Math.max(0, Math.round((Date.now() - priorTs) / 1000))}s)`)
        return
      }
      const post = async (scope?: unknown): Promise<number> => {
        const body: any = { commands }
        if (scope) body.scope = scope
        const res = await fetch(`${apiBase}/setMyCommands`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        })
        return res.status
      }
      const statuses: number[] = []
      if (globalNeeded) statuses.push(await post())
      for (const cid of targetScopes) statuses.push(await post({ type: "chat", chat_id: Number(cid) }))
      if (statuses.length > 0 && statuses.every((status) => status === 200)) {
        writeFileSync(
          COMMAND_CACHE_PATH,
          JSON.stringify({ signature, ts: Date.now(), scopes: [...new Set([...priorScopes, ...allScopes])] }),
          { encoding: "utf8", mode: PRIVATE_FILE_MODE },
        )
        await log("info", `setMyCommands registered (bot=${BOT_ID}) status=${statuses.join(",")} requests=${statuses.length}`)
      } else {
        await log("error", `setMyCommands failed (bot=${BOT_ID}): status=${statuses.join(",") || "no-request"}`)
      }
    } catch (err) {
      await log("error", `setMyCommands failed: ${sanitizeLog(err).slice(0, 160)}`)
    }
  }
  void registerMyCommands()
  // ctx 水位按需回填：查 session.messages，取最近一次压缩之后最后一条 assistant 全量 tokens（how-much 口径）
  const backfillInflight = new Set<string>()
  const backfillCtxUsage = async (sid: string): Promise<void> => {
    try {
      if (!sid || backfillInflight.has(sid)) return
      backfillInflight.add(sid)
      try {
        // 窗口口径 = 消息事件里最近一次请求的 tokens（noteUsage 是覆盖语义，天然正确）。
        // 服务端账本 session_v2.tokens_* 是**生命周期累计**（f339 已 16.1M），不能当窗口用：
        // 旧代码优先用它，导致每条推送的 ctx 后缀永远显示 100%。这里只借它取模型/窗口信息。
        let ledger: { input: number; output: number; reasoning: number; modelID: string; providerID: string } | null = null
        try {
          ledger = await readSessionUsage(sid)
        } catch {
          /* ignore */
        }
        const r = await client.session.messages({ path: { id: sid } })
        const msgs = Array.isArray((r as any)?.data) ? (r as any).data : []
        let stoppedAtCompaction = false
        // R718(loop 修复)：**必须先按时序归一** —— 实测宿主 API（及其 v1 适配）返回的列表是
        // **新→旧（DESC）、封顶最近 50 条**；旧实现从数组尾部（=窗口里最旧一条）往前扫，
        // 实际拿到的是「窗口内最旧的一条 assistant」，而不是这里注释声称的
        // 「最近一次压缩之后**最后一条**（=最新）assistant」。活证据：2026-10-15T12:33:37
        // 回填取到 153.3k = 压缩前 12:27:43 报告消息的 tokens 原位匹配，而当时压缩后
        // 真实水位仅 ~45–80k；同窗口模拟扫描同样落在窗口最旧一条上。修法：显式按时序降序。
        const ordered = [...msgs].sort((a: any, b: any) => {
          const ta = Number(a?.info?.time?.created ?? a?.time?.created ?? 0)
          const tb = Number(b?.info?.time?.created ?? b?.time?.created ?? 0)
          return tb - ta
        })
        // R719（本段核心修复）：跳过「会话生命周期累计」形状的样本，**继续向更旧走**。
        // 活证据（2026-10-15 12:33–13:18 restore-log + v2plugin.log 对账）：活跃回合中，
        // 尚无真实步 tokens 的新消息被上层填充成 `{input: 会话累计(49.9m), 其余全 0}`；
        // 旧实现把它当候选 → noteUsage 合法拒绝 → 无脑 `return`（不回落更老的真实样本）
        // → 显示值与采样时刻永久停在上一份真实样本上，卡片挂「（N 分钟前）」——
        // 这正是用户两次报「（127/27 分钟前）」的机制性根因。
        // 修法：①同源判据 isLifetimeUsage（与 noteUsage 拒绝闸一致）→ continue；
        //       ②只认 noteUsage 返回 accepted 才算命中（旧代码不看返回值，打印的是旧值，
        //         日志看起来在刷新、实际纹丝不动——本 bug 长期未被识破的第二个原因）。
        let skippedSamples = 0
        for (const mm of ordered) {
          const m = (mm as any) ?? {}
          const info = m?.info ?? {}
          // 压缩标记（兼容行 role=system+type=compaction，或原始 v2 行 type=compaction）：
          // 新→旧扫描，遇到最近一次已完成压缩即停。旧实现只认 type/status，而兼容行
          // 曾把标记放在 info.compaction=true / info.compactionStatus="completed" → 该停止
          // 条件从不命中，扫描会**越过压缩点**把压缩前的样本当窗口值。
          const mstatus = String(m?.status ?? info?.status ?? info?.compactionStatus ?? "")
          const isCompactionItem = isCompactionMessage(m) || /compaction/i.test(String(info?.compactionStatus ?? ""))
          if (isCompactionItem && (mstatus === "" || /completed/i.test(mstatus))) {
            stoppedAtCompaction = true
            break
          }
          // 判据与 noteUsage 对齐：**只看 input > 0 是错的** —— 宿主经常只报 cache 而把
          // input 报 0（本项目实测多数轮次如此）。旧判据让回读直接"找不到样本"放弃，
          // 于是显示值长期不刷新、每张卡片都挂"（N 分钟前）"。缓存前缀本身就是上下文。
          const parsedItem = parseTokenUsage(info?.tokens)
          if (info?.role === "assistant" && parsedItem.present) {
            const winItem = windowFor(String(info?.model?.id ?? ""), String(info?.model?.providerID ?? ""))
            if (isLifetimeUsage(parsedItem, winItem)) {
              // 这不是可用样本：继续向更旧走，去拿最近一条真实步 tokens。
              skippedSamples++
              continue
            }
            const accepted = noteUsage(sid, info)
            if (!accepted) {
              // 防御分支：形状过了预检但 noteUsage 仍拒绝（边缘情形）——同样继续走，别当成功打印。
              skippedSamples++
              continue
            }
            const u = ctxUsage.get(sid)
            if (u && !u.modelID && ledger?.modelID) {
              // 消息里没带模型信息时，用账本补上（只补模型，不补数值）
              ctxUsage.set(sid, { ...u, modelID: ledger.modelID, providerID: ledger.providerID })
            }
            const uu = ctxUsage.get(sid)
            if (uu) {
              const total = ctxTotal(uu)
              const win = windowFor(uu.modelID, uu.providerID)
              // R1887：诊断行必须与 ctxSuffix **同一诚实口径**。此前这里无条件打印
              // fmtK(win) 与百分比，而窗口未知时 win 是兜底常量 → 日志里出现
              // 「=54k/1m (5%)」，正是 R1881 从界面上拿掉的那种「显示 1m」的假象；
              // 超窗值还会被 Math.min(100,…) 静默夹成 100%，被读成「上下文满了」。
              // 诊断是排障入口，撒谎比缺字段更有害：窗口未知打 win=?，超窗打 over。
              const known = windowKnown(uu.modelID, uu.providerID)
              const pct = known ? (total / win) * 100 : 0
              const winTxt = known ? fmtK(win) : "?"
              const pctTxt = !known ? "?" : total > win ? "over" : pct < 1 ? "<1%" : `${Math.round(pct)}%`
              const skipTxt = skippedSamples > 0 ? ` skips=${skippedSamples}` : ""
              await log("info", `[tg-bridge] ctx backfill ${sanitizeLog(sid).slice(0, 12)}=${fmtK(total)}/${winTxt} (${pctTxt}) in=${fmtK(uu.usage.input)} out=${fmtK(uu.usage.output)} rea=${fmtK(uu.usage.reasoning)} cr=${fmtK(uu.usage.cacheRead)} cw=${fmtK(uu.usage.cacheWrite)}${uu.usage.cacheKnown ? "" : " nocache"}${skipTxt} [msg]`)
            }
            return
          }
        }
        // 没有可用的消息口径：只把账本当诊断信息输出，绝不写进 ctxUsage（否则 100% 假象）
        const skipDiag = skippedSamples > 0 ? `, skippedLifetime=${skippedSamples}` : ""
        if (ledger && !ctxUsage.has(sid)) {
          const life = ledger.input + ledger.output + ledger.reasoning
          await log(
            "info",
            `[tg-bridge] ctx backfill ${sanitizeLog(sid).slice(0, 12)}: no active-window value (msgs=${msgs.length}, stoppedAtCompaction=${stoppedAtCompaction}${skipDiag}; lifetime=${fmtK(life)} [db] ignored for window)`
          )
          return
        }
        await log("info", `[tg-bridge] ctx backfill ${sanitizeLog(sid).slice(0, 12)}: no post-compaction assistant (msgs=${msgs.length}, stoppedAtCompaction=${stoppedAtCompaction}${skipDiag})`)
      } finally {
        backfillInflight.delete(sid)
      }
    } catch (err) {
      await log("error", `[tg-bridge] ctx backfill failed: ${sanitizeLog(err).slice(0, 160)}`)
    }
  }
  ctxBackfillRequest = (sid) => {
    void backfillCtxUsage(sid)
  }
  // 模型窗口（10 分钟 TTL）。R1881：**两个数据源**，且失败必须留痕。
  //
  // 背景（用户实报「默认模型的上下文是1m」）：本宿主版本的插件 client **没有**
  // `provider.list`，旧实现直接 `return` → modelWindows 永远是空表 → 所有模型一律
  // 回落 1048576 → 卡片显示 "1m"。实测默认模型 `opencode/big-pickle` 的真实窗口是
  // **200000**：显示值错 5 倍，且 windowFor 的另一处消费（自动压缩阈值）也被算松 5 倍。
  //
  // 数据源 2 = 宿主 HttpApi `GET /api/model`（实测 HTTP 200，`{data:[{providerID,id,limit:{context}}]}`）。
  // 凭证与 bgHttpPromote 同源：~/.local/state/opencode/service.json，Basic base64("opencode:"+pw)。
  const fetchModelWindowsHttp = async (): Promise<number> => {
    const { url, password: pw } = await hostServiceReg()
    if (!url || !pw) return 0
    const token = Buffer.from(`opencode:${pw}`, "utf8").toString("base64")
    const r = await fetch(`${url}/api/model`, {
      headers: { Authorization: `Basic ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) return 0
    const entries = modelWindowEntries(await r.json())
    for (const e of entries) modelWindows.set(e.key, e.context)
    return entries.length
  }
  const refreshModelWindows = async (): Promise<void> => {
    if (Date.now() - modelWinTs < 10 * 60_000) return
    modelWinTs = Date.now()
    let n = 0
    const fn = (client as any)?.provider?.list
    if (typeof fn === "function") {
      try {
        const r = await fn.call((client as any).provider, {})
        const list = Array.isArray((r as any)?.data) ? (r as any).data : Array.isArray(r) ? (r as any) : []
        for (const p of list) {
          const pid = String((p as any)?.id ?? "")
          const mo = (p as any)?.models
          // models 既可能是数组，也可能是 `Record<modelID, model>` 映射 —— 两种都吃。
          const models: any[] = Array.isArray(mo) ? mo : mo && typeof mo === "object" ? Object.values(mo) : []
          for (const mm of models) {
            const mid = String((mm as any)?.id ?? "")
            const lim = Number((mm as any)?.limit?.context)
            if (pid && mid && Number.isFinite(lim) && lim > 0) {
              modelWindows.set(`${pid}/${mid}`, lim)
              n++
            }
          }
        }
      } catch (err) {
        // 旧实现整段 `/* ignore */`：抛错也一声不吭，于是窗口表悄悄空着。
        await log("error", `[tg-bridge] ctx model windows: provider.list failed (${sanitizeLog(err).slice(0, 140)}), trying HttpApi`)
      }
    } else {
      await log("info", "[tg-bridge] ctx model windows: provider.list unavailable, using HttpApi /api/model")
    }
    if (n === 0) {
      try {
        n = await fetchModelWindowsHttp()
      } catch (err) {
        await log("error", `[tg-bridge] ctx model windows: HttpApi /api/model failed: ${sanitizeLog(err).slice(0, 140)}`)
      }
      if (n > 0) publishModelWindows()
      await log(
        n > 0 ? "info" : "error",
        n > 0
          ? `[tg-bridge] ctx model windows: ${n} models (HttpApi /api/model)`
          : "[tg-bridge] ctx model windows: 0 models — 窗口将回落 1M 兜底，ctx 百分比与压缩阈值均不可信",
      )
      return
    }
    publishModelWindows()
    await log("info", `[tg-bridge] ctx model windows: ${n} models`)
  }
  // R1882：这两步有**先后依赖** —— 窗口表必须先填好，回填算出的百分比才有正确分母。
  // 原来是两个并列的 `void`，实测每次热重载后首个回填都抢在取窗口之前跑完
  // （三个 bot 的 backfill 时间戳全部早于 `ctx model windows: 57 models`）
  // → 用户看到的仍是 `/1m`，会以为 R1881 没生效。
  // 串进同一个协程：既保证顺序，又保持 setup 不被网络往返阻塞。
  void (async () => {
    await refreshModelWindows()
    await backfillCtxUsage(fixedTarget ?? persistedFront ?? "")
  })()
  // offset 只在 poll 成功处理 update 后提交
  const commitOffset = (uid: number): void => {
    if (!Number.isFinite(uid) || uid <= 0) return
    if (uid + 1 <= offset) return
    offset = uid + 1
    if (offset !== persistedOffset) {
      persistedOffset = offset
      savePersistedState()
    }
  }
  let offset = persistedOffset
  let polling = false
  // R2507：鉴权熔断。401/400/403 是确定性配置错误（token 被吊销/写错），不是网络抖动；
  // 每 2 秒重试只会把同一签名刷满日志。连续 3 次后停掉本实例的 poll，并留一条明确
  // error（不含 token），等人工更新 token + reload 桥。
  let authFailStreak = 0
  let authDisabled = false
  // 自愈请求挂起位：轮询在飞时不能发 getUpdates（见 sanityCheckOffset 注释）
  let sanityPendingReason: string | null = null
  // 在飞的长轮询句柄：新实例在 setup 里抢占租约后，旧实例必须在几秒内**主动中断**
  // 自己那次 20 秒长轮询，否则新实例第一次 getUpdates 必然 409（换代抖动）。
  let pollAbort: AbortController | null = null
  let pollAbortTakenOver = false
  // R2507：offset 自检的 peek 也是一次 getUpdates，且它的 15s 超时可能跨越一次热重载。
  // 旧实例的 pollAbort 只覆盖长轮询，不覆盖 peek → 新实例首 poll 会被旧 peek 撞 409。
  // 这里单独持有 peek 的句柄，换代/丢租约时一并中断。
  let sanityAbort: AbortController | null = null
  // Singleton, two layers (covers both ESM-cache hypotheses + cross-process):
  // 1. globalThis generation: newest instantiation in THIS process wins.
  //    globalThis survives module hot-reload, so stale loops suicide on next tick.
  // 2. File owner with unique-per-invocation id: newest process/instance wins
  //    across processes; losers suicide (old code without gen check uses this).
  const G = globalThis as Record<string, unknown>
  G[GEN_KEY] = (typeof G[GEN_KEY] === "number" ? (G[GEN_KEY] as number) : 0) + 1
  const myGen = G[GEN_KEY] as number
  // 状态写权限跟随最新实例：热重载后旧实例的定时器/事件仍可能调用
  // savePersistedState()，会把新实例的内存态（watch/front/队列）整体覆盖回旧值。
  G[writerGenKey()] = myGen
  instanceGen = myGen
  // R2708：识别「同进程再次加载」= 热重载。登记点必须在 serve 分支之后：TUI/standby
  // 进程也会装载本模块，若在那里登记，一次普通装载就会被误判成热重载。
  const reloadState = registerBridgeLoad(G, BOT_ID, VERSION, Date.now(), process.pid)
  const isHotReload = reloadState.hot
  // R1569：turn-end note 轮询的"实例启动时间"基准。热重载后新实例的 turnEndNotified
  // Set 是空的——若没有这个守卫，会把**已通知过**的最近 completed 消息再补发一条重复
  // note（每次热重载每会话可能 1 条）。只认 boot 之后完成的消息即可避免补发。
  const turnNoteBootAt = Date.now()
  // R2648：完成事件驱动的即时检查与 5s 轮询共用节流，避免 message.updated 风暴把
  // session.messages 拉爆（真正要发的那次不会被吞：最多推迟到下一拍轮询）。
  let turnNoteCheckAt = 0
  // R2648c：同一组「待完成后台 shell」只记一条 deferral 日志（每次轮询/事件都会重评估）。
  let turnNotePendingLogged = ""
  // R2657：同一组「正文还没投递」也只记一条 deferral 日志（5s 轮询会反复评估）。
  let turnNoteContentLogged = ""
  // R2648c：后台 shell 存活探测。完成通知可能永远不来（被中断的 shell 实测如此），
  // 所以第三层看 metadata.pid：进程消失 = 结束。留 15s 宽限，避免「进程刚退出、
  // 完成通知还在路上」时抢发 —— 那正是本修复要消灭的原症状。
  const SHELL_DEAD_GRACE_MS = 15_000
  const shellDeadFirstSeen = new Map<string, number>()
  const shellStillAlive = (shellID: string, pid: number): boolean => {
    if (!(pid > 0)) return true
    let alive = true
    try {
      process.kill(pid, 0)
    } catch (err) {
      // 只有 ESRCH（进程不存在）才算结束；EPERM/其它异常保守当存活，避免误放行。
      alive = (err as NodeJS.ErrnoException)?.code !== "ESRCH"
    }
    if (alive) {
      shellDeadFirstSeen.delete(shellID)
      return true
    }
    const first = shellDeadFirstSeen.get(shellID)
    if (first === undefined) {
      shellDeadFirstSeen.set(shellID, Date.now())
      return true
    }
    if (Date.now() - first < SHELL_DEAD_GRACE_MS) return true
    shellDeadFirstSeen.delete(shellID)
    return false
  }
  // R1741/R1743：入站静默判据的 boot 基线。与 turnNoteBootAt 同一位置、同一语义
  // （本代实例的启动时刻）。放模块级是因为判据要跨"没有 update"的那些轮次累积。
  botBootAt = Date.now()
  // 429 时不让关键 proto 消息消失：按 key 保留内存重试，定时退避。
  const protoRetry = new Map<string, {
    chatID: string
    text: string
    kb?: unknown[][]
    silent: boolean
    editId: number
    attempt: number
    firstTryAt: number
    timer?: ReturnType<typeof setTimeout>
  }>()
  // R2558：每个 chat 最近一次补发尝试的时间（含失败）。冷却结束/多次失败后，
  // 队列里的条目会各自到期；仅靠“比谁更老”的屏障仍可能背靠背发送。用这个
  // 时间戳把同 chat 的补发尝试强制拉开 PROTO_RETRY_GAP_MS，匀速排空积压。
  const protoRetryLastAttempt = new Map<string, number>()
  const pollInstanceId = `pid-${process.pid}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  const ownsPollLease = (): boolean => {
    try {
      const j = JSON.parse(readFileSync(OWNER_PATH, "utf8")) as any
      return j?.tg?.id === pollInstanceId
    } catch {
      return false
    }
  }
  const shortId = pollInstanceId.slice(-6)
  let pollLostLogged = false
  let pollCensusLogged = false
  claimPollOwner(pollInstanceId, "tg")
  let activeSessionID: string | undefined
  let activeSessionTitle: string | undefined
  const lastActivity = new Map<string, number>()
  const touchActivity = (sid: string | undefined): void => {
    if (!sid) return
    lastActivity.set(sid, Date.now())
  }
  const sessionTitleCache = new Map<string, string>()
  // R921：状态卡需要「会话最近结果 / 空闲时刻 / 模型」，一并缓存，避免状态命令再打一次 HTTP。
  const cachedSessionList: Array<{ id: string; title?: string; outcome?: string; idle?: number; model?: string }> = []
  // R923：置顶循环卡也显示会话实时状态；与 /loop status 使用同一份缓存/活动时间。
  const sessionStateLabel = (sid: string): string => {
    const info = cachedSessionList.find((x) => x.id === sid)
    const act = lastActivity.get(sid)
    const mins = act ? Math.max(0, Math.round((Date.now() - act) / 60000)) : -1
    const idleMin = info?.idle ? Math.max(0, Math.round((Date.now() - info.idle) / 60000)) : -1
    const running = mins >= 0 && mins <= 2
    return running ? "运行中" : `${outcomeLabel(info?.outcome)}${idleMin >= 0 ? `（空闲 ${idleMin}m）` : ""}`
  }
  // R1884：上次记进日志的条数（-1 = 还没记过）。仅用于"变化才记"，避免刷屏。
  let lastLoggedSessionCount = -1
  // R1885：裸 HTTP 取**全量**会话列表。凭证与 `/api/model`（R1881）同源。
  // 返回 null 表示"取不到"（service.json 不可读 / 网络失败 / 非数组），调用方据此回落。
  const fetchSessionListHttp = async (): Promise<any[] | null> => {
    try {
      const { url, password: pw } = await hostServiceReg()
      if (!url || !pw) return null
      const token = Buffer.from(`opencode:${pw}`, "utf8").toString("base64")
      const r = await fetch(`${url}/api/session?limit=${SESSION_LIST_LIMIT}`, {
        headers: { Authorization: `Basic ${token}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!r.ok) return null
      const body = await r.json()
      const arr = Array.isArray(body) ? body : Array.isArray((body as any)?.data) ? (body as any).data : null
      return arr
    } catch {
      return null
    }
  }
  // R1874：返回**本轮刷新是否成功**。此前返回 void，而 5 个存在性闸都把 `sessionIdAcceptable`
  // 的第三参 `listOk` 硬编码为 `true` —— 参数形同虚设：`session.list` 失败时缓存里可能仍是
  // **旧的非空列表**，于是把"新建/未在旧缓存里的有效会话"误判成"不存在"并拒绝，恰好违背
  // R1829 写明的"拉不到列表时保守放行、不误伤"策略。改为返回 boolean，闸口按真实结果传参。
  const refreshSessionTitles = async (): Promise<boolean> => {
    try {
      // R1885：**存在性判据必须完整**，而宿主 client 给不完整。
// 实测（本项目 service.json + Basic 票）：
      //   `GET /api/session`                →  50 个（服务端默认上限）
      //   `GET /api/session?limit=1000`     → 125 个（项目内实有）
      //   `?directory=/root&limit=1000`     → 119 个（与目录无关，50 上限照样生效）
      //   插件 client 实测只拿到 **50** 个（R1884 的诊断日志读出的真值）。
      // 两种"给 client 传 limit"的写法都**试过并被实测否掉**：顶层 `{limit}` 与
      // `{query:{limit}}` 之后日志仍是 50 —— 宿主内置 client 与已安装 SDK 版本不同，
      // 不转发该参数。**唯一可行路径是裸 HTTP**（`/api/model` 已是同一套路，可用）。
      //
      // 危害链条（判据，不是展示列表）：
      //   列表 → cachedSessionList → sessionIdAcceptable(id, ids, listOk)
      //   → 5 个闸口（回调 use: /use /watch /alias /sendto）统一 `if (!ok) → "会话不存在"`
      // 于是排在 50 名之外、**真实存在**的会话被**误判为不存在**，用户被挡在门外，
      // 且提示语与真实原因（列表被截断）完全对不上，无从自查。注意方向性：
      // 这与 R1829 的"保守放行"是**反方向**的错 —— 那个是该放行却收紧，这个是该承认却拒绝。
      let arr: any[] | null = await fetchSessionListHttp()
      if (!arr && cachedSessionList.length > 0) {
        // 手上有上一份**好**列表时，绝不用 client 那份**截断**列表覆盖它：
// 否则 HTTP 抖一次，误判就又回来了（这正是本修复要消灭的症状）。
        for (const [sid, ts] of lastActivity) {
          if (Date.now() - ts > ACTIVE_WINDOW_MS) lastActivity.delete(sid)
        }
        return true
      }
      if (!arr) {
        const res = await (client as any).session.list?.({})
        arr = Array.isArray(res?.data) ? (res.data as any[]) : null
      }
      const ok = Array.isArray(arr)
      // R1878：**只在拿到合法数组时才重建缓存**。旧代码的清空动作是**无条件执行**的
      // → `session.list` 返回**非数组**（降级/畸形响应）时，最后一份好数据被抹掉，
      // `/sessions` 会短暂全空（用户看到"会话列表没了"），偏偏发生在最不该丢数据的时刻。
      // 选择面不受影响（R1829/R1874 保守放行：读失败返回 false，不因一次畸形读收紧可选项），
      // 但**展示面**不该被一次坏读摧毁 —— 保留上一份好列表，读成功时再整体替换。
      if (ok) {
        cachedSessionList.length = 0
        for (const s of arr as any[]) {
          const id = String(s?.id ?? "")
          if (!id) continue
          const title = String(s?.title ?? s?.info?.title ?? "").slice(0, 60)
          const outcome = typeof s?.outcome === "string" ? s.outcome : undefined
          const idle = Number(s?.time?.idle) || 0
          const mdl = s?.model && typeof s.model === "object"
            ? `${String(s.model.providerID ?? "")}/${String(s.model.id ?? "")}`.replace(/^\/|\/$/g, "")
            : ""
          cachedSessionList.push({ id, title: title || undefined, outcome, idle: idle || undefined, model: mdl || undefined })
          if (title) sessionTitleCache.set(id, title)
        }
        // R1884：把"存在性判据"的**规模**变成可观测量。这份列表是
        // `sessionIdAcceptable` 判定"会话是否存在"的唯一依据，此前它的条数在日志里
        // 完全不可见 —— 于是"列表被截断 → 真实会话被误判为不存在"这类问题只能靠猜。
        // 只在条数**变化**时记一条（refreshSessionTitles 每个闸口命令都会调，静默记会刷屏），
        // 并且把 listOk=false 的坏读也报出来（那才是"缓存被保留"的时刻）。
        if (lastLoggedSessionCount !== cachedSessionList.length) {
          lastLoggedSessionCount = cachedSessionList.length
          void log("info", `session list ok (${cachedSessionList.length} 个，作为存在性判据)`)
        }
        // R1893：dead watch entries persist —— 会话被删后 watch 条目只是滞留占格
        // （/watch 列表还会展示它、WATCH_MAX 被它占用），持久化也累加。refreshSessionTitles
        // 只有在 **listOk && 缓存非空** 时才许修剪 —— 绝不能因一次坏读/降级把真在用的
        // watch 条目一并删掉。判据与 /watch 入口（L7055）同款：列表可用时必须在列。
        if (ok && cachedSessionList.length > 0) {
          const live = new Set(cachedSessionList.map((s) => s.id))
          const dead: string[] = []
          for (const w of watchedSessions) if (!live.has(w)) dead.push(w)
          if (dead.length > 0) {
            for (const w of dead) watchedSessions.delete(w)
            void log("info", `watch pruned dead entries (missing from session list): ${dead.map((d) => d.slice(0, 12)).join(",")}`)
            savePersistedState()
          }
        }
      } else {
        void log("warn", `session list 非数组（保留上一份好列表 ${cachedSessionList.length} 个）`)
      }
      for (const [sid, ts] of lastActivity) {
        if (Date.now() - ts > ACTIVE_WINDOW_MS) lastActivity.delete(sid)
      }
      return ok
    } catch {
      /* non-fatal: titles stay empty */
      return false
    }
  }
  const sessionNameOf = (sid: string): string => {
    const t = sessionTitleCache.get(sid)
    if (t && t.length > 0) return t
    if (sid === (activeSessionID ?? "")) return activeSessionTitle ?? ""
    return ""
  }
  void refreshSessionTitles()
  // R1060：bot 自动改名。用内存中的 TOKEN 调 Telegram setMyName / setMyShortDescription。
  // token 只在内存里拼进 URL，绝不落日志/写文件。会话无标题时不动名字。
  let lastRenameSig = ""
  let lastRenameSkipSid = ""
  let lastRenameCheck = 0
  const RENAME_CHECK_MS = 60_000
  // R1897：429 告警节流戳必须在**闭包层**（跨调用持久）。旧代码把它放在
  // renameBotToSession 函数体内，每次调用重置为 0 → 节流形同虚设 → 每 60s
  // poll 一条 warn，实测 1.5h 刷 159 条。
  let rename429LogAt = 0
  // R1897：改名签名落盘。lastRenameSig 原是纯内存态，服务每次重启清零 →
  // 名字没变也会在启动后立刻重打一次 setMyName（实测 15:26:28 刚成功、15:26:58
  // 重启后 15:27:05 再打即撞 429，retry_after≈21.5h）。持久化后重启/热重载
  // 不再发无谓请求。
  const RENAME_SIG_PATH = `REDACTED_ROOT/.config/opencode/botname-sig.json`
  try {
    const sj = JSON.parse(readFileSync(RENAME_SIG_PATH, "utf8")) as Record<string, string>
    if (typeof sj?.[BOT_ID] === "string") lastRenameSig = sj[BOT_ID]
  } catch { /* 首次运行：无签名 */ }
  let renameInFlight: Promise<boolean> | null = null
  const renameBotToSession = async (sid: string): Promise<boolean> => {
    const title = sessionNameOf(sid) || ""
    if (!title) {
      // R1063：skip 日志按 sid 去重 —— 无标题会话每 60s 会被 poll 检查到，
      // 不节流会每分钟刷一条相同日志。
      if (lastRenameSkipSid !== sid) {
        lastRenameSkipSid = sid
        await log("info", `bot rename skip: session has no title (sid=${sid.slice(0, 12)})`)
      }
      return false
    }
    const sig = `${sid.slice(0, 12)}|${title}`
    if (sig === lastRenameSig) return false
    if (renameInFlight) await renameInFlight
    const name = title.slice(0, 64)
    const short = `TG \\u2192 ${sid.slice(0, 12)}`
    // R1635：setMyName 响应校验 + 429 冷却跨重载持久化。
    // 之前 fetch 200 即记成功、且提前推进 lastRenameSig —— 429 静默失败时
    // 名称永远不更新（alt @opencodev2_bot 实测冻结 14.6h）。现改为：
    //   * 检查 HTTP status 与响应体 {ok:false, error_code, parameters.retry_after}；
    //   * 429 时把冷却截止时间按 BOT_ID 写入 botname-429.json（reload 后仍记得，防再打 429）；
    //   * lastRenameSig 仅在**两请求都成功**后推进，失败留空 → 下轮 poll 自动重试。
    const RENAME_429_PATH = `REDACTED_ROOT/.config/opencode/botname-429.json`
    let rename429Until = 0
    {
      try {
        const j = JSON.parse(readFileSync(RENAME_429_PATH, "utf8")) as Record<string, { until?: number }>
        rename429Until = Number(j?.[BOT_ID]?.until ?? 0) || 0
        // R1897：限流实测是**共享出口 IP 级**——三个 Bot 的 429 截止时间精确汇聚到
        // 同一窗口（bot3 14:14 的 81968s 与 primary/bot2 15:27 的 77632s，同一秒级终点）。
        // 只读自己的键 → 任一 Bot 撞 429 后，其它 Bot 仍会"各自再打一次"再撞一次。
        // 读取取 max(自己, __shared)；写入时也同时写 __shared（见 noteRename429）。
        rename429Until = Math.max(rename429Until, Number(j?.["__shared"]?.until ?? 0) || 0)
      } catch { rename429Until = 0 }
    }
    const noteRename429 = (retryAfterSec: number): void => {
      const until = Date.now() + Math.max(1, Math.floor(retryAfterSec)) * 1000
      // R1844：冷却截止单调，写入前与磁盘现状逐 bot 取 max 合并（只延长不缩短），
      // 并用 atomicWrite（tmp+rename）落盘。旧写法原地 read-modify-write：多 bot/重载并存时
      // ① 互相覆盖对方 bot 的冷却键（丢更新 → 那个 bot 反复打 429）；
      // ② 读侧可能读到半截 JSON → catch 归 0 → **冷却被静默遗忘** → 重载后又 hammer 429。
      rename429Until = Math.max(rename429Until, until)
      try {
        let j: Record<string, { until?: number }> = {}
        try { j = JSON.parse(readFileSync(RENAME_429_PATH, "utf8")) as Record<string, { until?: number }> } catch { j = {} }
        const merged = mergeRename429Until(j, BOT_ID, until)
        // R1897：同时写 __shared —— 限流是 IP 级共享窗口（证据见启动读取处），
        // 任一 Bot 撞 429 即为全通道装冷却，省掉其它 Bot 的"陪打"请求。
        const mergedAll = mergeRename429Until(merged, "__shared", until)
        atomicWrite(RENAME_429_PATH, JSON.stringify(mergedAll), 0o600)
        rename429Until = Math.max(rename429Until, mergedAll[BOT_ID]?.until ?? 0, mergedAll["__shared"]?.until ?? 0)
      } catch { /* 非致命：冷却仍在本进程内存生效 */ }
    }
    const postJson = async (path: string, body: object): Promise<void> => {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        const retryAfter = parseTgRetryAfter(text)
        // R1834：429 必须始终装冷却（响应体读不到 retry_after 时用兜底 300s），
        // 否则 poll 每 60s 重试一次会持续 hammer；非 429 且无 retry_after 不冷却。
        const coolSec = rename429Seconds(res.status, retryAfter)
        if (coolSec > 0) noteRename429(coolSec)
        throw new Error(`TG ${path} HTTP ${res.status}${retryAfter > 0 ? ` retry_after=${retryAfter}s` : ""}: ${text.slice(0, 80)}`)
      }
    }
    const run = async (): Promise<boolean> => {
      if (renameCooling(rename429Until, Date.now())) {
        // R1897：① 节流 60s→30min（节流戳已上移到闭包层，见 RENAME_CHECK_MS 旁）；
        // ② until 带完整日期 + 剩余分钟 —— 旧格式只打 HH:MM:SS，跨天截止（次日 13:00）
        // 看起来像"已过期还在限流"，实测误导排查方向。
        if (Date.now() - rename429LogAt > 30 * 60_000) {
          rename429LogAt = Date.now()
          const leftMin = Math.max(1, Math.round((rename429Until - Date.now()) / 60_000))
          await log("warn", `bot rename rate-limited (bot=${BOT_ID}, until=${new Date(rename429Until).toISOString()}, remaining≈${leftMin}min, sid=${sid.slice(0, 12)})`)
        }
        return false
      }
      try {
        await postJson("setMyName", { name })
        await postJson("setMyShortDescription", { short_description: short })
      } catch (err) {
        await log("error", `bot rename failed: ${sanitizeLog(err).slice(0, 120)}`)
        return false
      }
      lastRenameSig = sig
      try {
        // R1897：签名落盘（atomicWrite tmp+rename，多 Bot 各写各的键不互踩）。
        let sj: Record<string, string> = {}
        try { sj = JSON.parse(readFileSync(RENAME_SIG_PATH, "utf8")) as Record<string, string> } catch { sj = {} }
        sj[BOT_ID] = sig
        atomicWrite(RENAME_SIG_PATH, JSON.stringify(sj), 0o600)
      } catch { /* 非致命：本内存态仍生效 */ }
      await log("info", `bot renamed to "${sanitizeLog(title).slice(0, 30)}" (sid=${sid.slice(0, 12)})`)
      return true
    }
    renameInFlight = run()
    const ok = await renameInFlight
    renameInFlight = null
    return ok
  }
  const resumeFallback = async (): Promise<void> => {
    if (frontSessionID || activeSessionID) return
    try {
      let sid = persistedFront && persistedFront.startsWith("ses_") ? persistedFront : ""
      if (!sid) {
        const res = await (client as any).session.list?.({})
        const arr = Array.isArray(res?.data) ? res.data : []
        const real = arr
          .filter((s: any) => s && typeof s?.id === "string" && s.id.startsWith("ses_")) as Array<Record<string, any>>
        real.sort((a: any, b: any) => {
          const ta = a?.time?.updated ?? a?.time?.created ?? 0
          const tb = b?.time?.updated ?? b?.time?.created ?? 0
          return (typeof tb === "number" ? tb : 0) - (typeof ta === "number" ? ta : 0)
        })
        sid = typeof real[0]?.id === "string" ? real[0].id : ""
      }
      if (sid) {
        activeSessionID = sid
        frontSessionID = sid
        persistedFront = sid
        savePersistedState()
        const title = ""
        await log("info", `resume fallback: pinned ${sid.slice(0, 12)}${persistedFront === sid ? " (persisted front)" : ""}`)
      }
    } catch (err) {
      await log("error", `resume fallback failed: ${sanitizeLog(err).slice(0, 160)}`)
    }
  }
  setTimeout(() => {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    void resumeFallback()
  }, 2500)
  let frontSessionID: string | undefined
  // followPrimaryFront 骨架已撤回（曾因模块级引用闭包内变量触发 TS2304 + scope-guard 失败；dim1 B 接线留待后续聚焦轮一次做完整）。
  let activeFrontOverride = ""
  const activeFront = async (): Promise<string> => {
    if (fixedTarget) return fixedTarget
    if (activeFrontOverride) return activeFrontOverride
    try {
      const m = (client as any).session?.active
      if (typeof m === "function") {
        const res = await m.call((client as any).session, {})
        const data = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
        const first = data[0]
        const sid = typeof first?.sessionID === "string" ? first.sessionID : typeof first?.id === "string" ? first.id : ""
        if (sid) {
          activeFrontOverride = sid
          return sid
        }
      }
    } catch {
      /* fall back below */
    }
    return frontSessionID ?? ""
  }
  let lastPushedText = ""

  // desc/status 只在 "drop" 时有值，供调用方把"为什么丢"写进日志（不必再各自重查一遍）
  // R2616: `same` means Telegram accepted the edit as a no-op ("message is not
  // modified"). The screen already shows the target content, but the operator
  // gets no visible change — /menu uses this to send a short receipt.
  // R2689：实例级闸门/连续 429 计数的唯一状态容器。
  const floodGate = createFloodGate()
  // R2602（D3）：本地限流闸门必须跨进程重启恢复。实测 2026-11-12 01:05:59：新
  // opencode 进程启动时 bot-flood.json 里仍有有效 gate（until 01:08:52/01:10:08），
  // 但 floodGate.floodUntil 恒为 0 → 启动回扫 backfill strip 立刻触网，又吃 429
  // （rawRetryAfter=543/530），把 gate 推到 01:17:10/01:17:42。每次 run 接力都
  // 重新武装一次洪水，永远排不干。启动即从共享标记恢复，所有发送/编辑/回扫路径
  // 都走同一个本地闸门。
  try {
    const persistedFloodUntil = Number(readFloodFlagDisk()[BOT_ID]?.until) || 0
    if (persistedFloodUntil > Date.now()) {
      floodGate.floodUntil = persistedFloodUntil
      void log("info", `restored persisted flood gate (bot=${BOT_ID}, left=${Math.ceil((persistedFloodUntil - Date.now()) / 1000)}s)`)
    }
  } catch {
    /* 共享标记损坏时按无闸门启动；真正的 429 仍会在 tgFetch 里记录并重新写盘 */
  }
  // R2608（D3）：只在启动时恢复一次不够。实测 2026-11-12 01:45:10 启动实例
  // 已恢复 primary/bot5 闸门（until 02:16），但 01:46:05 同两个 Bot 的注入卡
  // 编辑仍触网吃 429：长寿命/兄弟实例的本地 floodGate.floodUntil 落后于共享标记（另一
  // 实例在它启动后才写入 429）。每次发送/编辑前按需合并共享闸门（最多 1s
  // 一次文件读），任何实例都不会越过别人刚写下的冷却。
  let lastFloodDiskSyncAt = 0
  const syncSharedFloodGate = (now: number): void => {
    if (now - lastFloodDiskSyncAt < 1000) return
    lastFloodDiskSyncAt = now
    try {
      const diskUntil = Number(readFloodFlagDisk()[BOT_ID]?.until) || 0
      if (diskUntil > floodGate.floodUntil && diskUntil > now) {
        floodGate.floodUntil = diskUntil
        void log("info", `adopted shared flood gate (bot=${BOT_ID}, left=${Math.ceil((diskUntil - now) / 1000)}s)`)
      }
    } catch {
      /* 共享标记损坏：按无新增闸门处理，真正的 429 仍会记录 */
    }
  }
  // 限流说明：硬限流期间**任何**消息都发不出去（限制的是整个 Bot，不只是某个方法），
  // 所以"正在限流"这类通知根本送不到 —— 硬发只会进队列一起等，白占一条。
  // 诚实的做法是限流结束、第一条成功发出之后，补一句"刚才限流了多久"。
  // R2699：该状态与补发逻辑在 tg-out-queue 引擎内（每实例一份）。
  // 限流期内“本 Bot 不可用”提示的节流（每分钟最多一条）
  let lastUnavailableNoticeAt = 0
  // R1636：连续 429 计数（指数退避的 attempt 来源）。主 Bot / 备用 Bot 各算各的 ——
  // 备用通道健康不代表主通道健康，混算会让主 Bot 恢复后仍被"连坐"继续长退避。
  // 任一次成功即清零该通道的计数（真正恢复，而不是"等够了就再试"）。
  // R2689：退避计算已上收到 tg-flood-gate.floodWaitSeconds（仍走 tg-transport 的唯一实现）。
  // R2690：HTTP 细节（POST/15s 超时/2xx message_id/错误体 description+retry_after）
  // 已上收到 tg-api.callTelegramApi；这里只保留 sendMessage 成功后的最新消息位置
  // 记账（R2682），网络异常仍向上抛给 tgFetch 统一转成 status 0。
  const callTelegram = async (base: string, method: string, body: Record<string, unknown>): Promise<TelegramResult> => {
    const r = await callTelegramApi(base, method, body)
    if (r.ok && method === "sendMessage") noteLatestChatMessage(body?.chat_id, r.id)
    return r
  }
  // R2691：通道编排（主/备选择、备用去按钮、429 记账、本地闸门、日志节流）
  // 已上收到 tg-send.createTgFetch；桥只注入运行态与唯一 HTTP 客户端。
  const tgFetch = createTgFetch({
    getApiBase: () => apiBase,
    getFallbackApiBase: () => fallbackApiBase,
    getBotID: () => BOT_ID,
    gate: floodGate,
    syncSharedGate: syncSharedFloodGate,
    log,
    sanitize: sanitizeLog,
    markFlooded: markSelfFlooded,
    call: callTelegram,
  })
  // R1898：桥侧最后一次成功投递（R1728 静默 watchdog 基线）在 sendTextRaw /
  // editTextRaw 的每个 `sent` 返回点**源头刷新**。此前只在 protoSend 的 3 个分支刷新，
  // 而循环期卡片以**编辑重渲染**为主（proto edit ok）、另有队列/命令回执/菜单等 7 类
  // 成功送达路径各自不刷新 → 基线长期停滞 → `proto silent 15/30/45min` 误报
  //（2026-10-06 实测，同时段日志里 send/edit 全部 ok）。源头一处修，未来新路径不再漏。
  // R2543/R2687：stale reply anchor 判定已上收到 tg-transport.replyTargetMissing
  //（400 "message to be replied not found"；降级重发必须丢坏锚点，否则整条回执丢失）。
  // R2592（D3）：2026-11-11 实测 thinking 卡以 ~0.65s 间隔突发（3 条/1.3s），
  // 两个 Bot 随后各吃 770s/1122s 的 Telegram flood wait —— 卡片停更、消息积压。
  // 这里只对**新消息**做同 chat 最小间隔（编辑路径另有节流），削峰但保留全部内容；
  // 可用 TG_SEND_MIN_GAP_MS=0 关闭（测试/排障）。
  const sendGapEnv = Number(process.env.TG_SEND_MIN_GAP_MS ?? 1100)
  const SEND_MIN_GAP_MS = Number.isFinite(sendGapEnv) ? Math.max(0, sendGapEnv) : 1100
  // R2697：削峰状态/计时已上收到 tg-pace；桥只注入最小间隔与日志出口。
  const paceSend = createPaceSend({
    minGapMs: SEND_MIN_GAP_MS,
    log,
    sanitize: sanitizeLog,
  })
  // R2694：发送正文的编排（分段/截断/HTML 降级/重试/丢弃记账）已上收到 tg-send-text；
  // 桥只注入运行态。fetch 用惰性转发，避免与稍后定义的 tgFetch 初始化顺序耦合。
  const sendTextRaw = createSendText({
    pace: paceSend,
    fetch: (method, body, preferFallback) => tgFetch(method, body, preferFallback),
    log,
    sanitize: sanitizeLog,
    noteDrop,
    noteOutbound: (count) => {
      inboundCounters.outbound += count
    },
    markDelivered: () => {
      lastProtoSendAt = Date.now()
    },
  })
  // R2695：编辑正文编排已上收到 tg-send-text.createEditText；桥只注入运行态。
  const editTextRaw = createEditText({
    fetch: (method, body, preferFallback) => tgFetch(method, body, preferFallback),
    log,
    sanitize: sanitizeLog,
    noteDrop,
    markDelivered: () => {
      lastProtoSendAt = Date.now()
    },
    setLastEditBody: (text) => {
      lastEditBody = text
    },
  })
  // R2699：外发队列引擎（直发/排队/占位条/限流恢复）已上收到 tg-out-queue。
  // 队列数组与占位表仍由桥持有并注入（持久化/状态卡/命令共享同一份状态）；
  // flush/send 只保留别名，桥里不再有第二套直发/排队流程。
  const outQueueEngine = createOutQueueEngine({
    items: outQueue,
    placeholders: listPlaceholder,
    send: sendTextRaw,
    fetch: (method, body) => tgFetch(method, body),
    log,
    sanitize: sanitizeLog,
    save: savePersistedState,
    noteDrop,
    markPushed: () => {
      lastPushAt = new Date().toISOString()
    },
    // R2732：限流恢复也是「全局信息」。本 Bot 开关关闭时只补发消息本身，
    // 不再追加这条提示；队列排空/投递不受影响。
    notify: async (chat, text) => {
      if (!readCardOps(BOT_ID).enabled) return
      await reply(chat, text)
    },
    getFloodUntil: () => floodGate.floodUntil,
    hasFallback: () => Boolean(fallbackApiBase),
  })
  const flushQueue = outQueueEngine.flush

  // R2684（运营者：「改成消息全部推送完本轮再结束」）：CI 出口 watcher 在结束
  // 本轮前会先写 stop 标记，再给一个有界 drain 窗口。桥在这里主动排空外发队列，
  // 而不是等下一次 poll/定时器；否则进程被 TERM 时队列里的卡会直接消失。
  // 只排空 outQueue（Bot→用户）；pinQueue 是用户→会话的注入，不属于“推送完”。
  if (process.env.EGRESS_STATE_DIR) {
    const stopFile = `${process.env.EGRESS_STATE_DIR}/stop`
    let stopFlushStarted = false
    setInterval(() => {
      // 热重载后的旧实例也会继续跑 interval；只让当前代际排空，避免旧实例
      // 拿着过期的 outQueue 重复发送。
      if (stopFlushStarted || G[GEN_KEY] !== myGen || !existsSync(stopFile)) return
      stopFlushStarted = true
      void (async () => {
        await log("info", `egress stop seen (bot=${BOT_ID}); flushing outbound queue (n=${outQueue.length})`)
        try {
          await flushQueue()
          // flushQueue 在另一个 flush 已进行时会立即返回；等它真正排空，
          // 否则日志会误报 done，watcher 也可能提前看到 queue=0。
          for (let i = 0; i < 40 && (outQueueEngine.isFlushing() || outQueue.length > 0); i++) {
            await new Promise((r) => setTimeout(r, 500))
          }
        } catch (err) {
          await log("warn", `egress stop flush failed: ${sanitizeLog(String(err)).slice(0, 120)}`)
        }
        await log("info", `egress stop flush done (bot=${BOT_ID}); remaining=${outQueue.length}`)
      })()
    }, 1_000)
  }

  // R2699：直发/排队流程已上收到 tg-out-queue 引擎；桥只保留别名。
  const sendQueued = outQueueEngine.send

  const reply = async (chatID: string, text: string, kb?: unknown): Promise<void> => {
    const quote = currentInbound && currentInbound.chat === chatID ? currentInbound.msgID : undefined
    if (commandReplyMode) {
      // R2602（D3）：限流闸门开启时命令回执不触网。旧实现仍然直发，每条 /命令
      // 都记一条 `immediate command reply unavailable: retry` error（01:02:55/56
      // 实测），既污染错误日志又白挨 429。改为转入持久化队列，闸门结束后补发。
      if (Date.now() < floodGate.floodUntil || Date.now() < floodGate.fallbackUntil) {
        const left = Math.max(1, Math.ceil((Math.max(floodGate.floodUntil, floodGate.fallbackUntil) - Date.now()) / 1000))
        await log("info", `immediate command reply deferred to queue (chat=${sanitizeLog(chatID)}, left=${left}s)`)
        await sendQueued(chatID, htmlEsc(text), kb, quote, true)
        return
      }
      // 命令回执直达 Telegram，不进入 outQueue；429 时明确失败，不伪装成“已排队”。
      const r = await sendTextRaw(chatID, htmlEsc(text), kb, false, quote)
      if (r.r === "sent") {
        await log("info", `immediate command reply sent (chat=${sanitizeLog(chatID)}) len=${text.length}`)
      } else {
        await log("error", `immediate command reply unavailable (chat=${sanitizeLog(chatID)}): ${r.r}`)
      }
      return
    }
    await sendQueued(chatID, htmlEsc(text), kb, quote)
  }

  // ── R2652：自动化行为进行时提示 ──────────────────────────────────────────
  // 运营者要求「给所有自动化行为进行时增加一个提示」。自动动作（429 换会话、
  // 429 fork、自动转后台、迁移…）开始时先发一条**静默**的「⏳ …进行中」，
  // 结束时**另发一条**「✅ 完成 / ❌ 失败」—— 不修改旧的进行中消息，聊天记录
  // 保留真实过程，也避免 Telegram 编辑失败/限流影响结果回执。提示是纯旁路：
  // 发送失败只记日志，绝不影响自动化本身，也不会因为 TG 限流阻塞换会话。
  const AUTOMATION_LABEL: Record<string, string> = {
    rollover: "429 换会话",
    fork: "429 fork 会话",
    bg: "自动转后台",
    migrate: "迁移到新会话",
  }
  type AutomationLive = { chat: string; id: number; at: number; pid: number; run: string }
  const automationLive = new Map<string, AutomationLive>()
  // R2653：进行中提示要跨 CI 重启。若进程在动作中途被杀，内存里的记录消失，
  // 那条「⏳」会永远停在聊天里（运营者会以为还在跑）。把记录落盘到本 Bot 的
  // 状态文件旁边；下次启动时把上一进程留下的 ⏳ 编辑成「已中断（桥重启）」。
  // 同一进程内的热重载（run id 相同且 pid 仍活着）不动它，避免抢正在收尾的动作。
  const automationLivePath = (): string => `${STATE_PATH.replace(/\.json$/, "")}-automation-live.json`
  const automationRunId = (): string => String(process.env.GITHUB_RUN_ID ?? "")
  const automationPidAlive = (pid: number): boolean => {
    if (!Number.isFinite(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const saveAutomationLive = (): void => {
    const path = automationLivePath()
    try {
      if (automationLive.size === 0) {
        try {
          unlinkSync(path)
        } catch {
          /* absent is fine */
        }
        return
      }
      const tmp = `${path}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(automationLive)), { encoding: "utf8", mode: 0o600 })
      renameSync(tmp, path)
    } catch {
      /* best-effort: a lost record only costs a stale ⏳ after a crash */
    }
  }
  const automationStart = async (kind: string, detail = ""): Promise<void> => {
    if (automationLive.has(kind)) return
    try {
      const chat = pushChatResolve()
      if (!chat) return
      const label = AUTOMATION_LABEL[kind] ?? kind
      const r = await sendTextRaw(chat, htmlEsc(`⏳ 自动${label}进行中…${detail ? `\n${detail}` : ""}`), undefined, true)
      if (r.r === "sent" && r.id) {
        automationLive.set(kind, { chat, id: r.id, at: Date.now(), pid: process.pid, run: automationRunId() })
        saveAutomationLive()
      } else await log("warn", `automation notice start dropped (kind=${kind}): ${r.r}`)
    } catch (err) {
      await log("warn", `automation notice start failed (kind=${kind}): ${sanitizeLog(String(err)).slice(0, 120)}`)
    }
  }
  const automationEnd = async (kind: string, ok: boolean, detail = ""): Promise<void> => {
    const rec = automationLive.get(kind)
    automationLive.delete(kind)
    saveAutomationLive()
    try {
      const chat = rec?.chat ?? pushChatResolve()
      if (!chat) return
      const label = AUTOMATION_LABEL[kind] ?? kind
      const secs = rec ? Math.max(1, Math.round((Date.now() - rec.at) / 1000)) : 0
      const text = `${ok ? "✅" : "❌"} 自动${label}${ok ? "完成" : "失败"}${secs ? `（${secs}s）` : ""}${detail ? `\n${detail}` : ""}`
      // R2654：运营者要求「不修改旧的，直接发一条新的」。结果永远另发一条，
      // 旧的 ⏳ 原样保留；编辑失败也不再是回执丢失的风险点。
      await reply(chat, text)
    } catch (err) {
      await log("warn", `automation notice end failed (kind=${kind}): ${sanitizeLog(String(err)).slice(0, 120)}`)
    }
  }
  // R2653：启动补收上一进程遗留的「⏳」。判据看整份记录（同一 Bot 的记录必然
  // 来自同一进程）：run id 相同且 pid 仍活着 = 本进程热重载，留给旧实例收尾；
  // 其余（CI 重启后 pid 已死 / run id 变了）一律另发一条「已中断」，避免假进行中。
  // R2654：按运营者要求不修改旧消息，只补发新消息。
  const recoverStaleAutomation = async (): Promise<void> => {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    const path = automationLivePath()
    let j: any = null
    try {
      j = JSON.parse(readFileSync(path, "utf8"))
    } catch {
      return
    }
    const recs = Object.entries(j && typeof j === "object" ? j : {}).filter(
      ([, v]: [string, any]) => v && typeof v.chat === "string" && Number.isFinite(v.id),
    ) as Array<[string, AutomationLive]>
    if (recs.length === 0) {
      try {
        unlinkSync(path)
      } catch {
        /* ignore */
      }
      return
    }
    const sample = recs[0][1]
    const sameRun = Boolean(sample.run) && sample.run === automationRunId()
    if (sameRun && automationPidAlive(Number(sample.pid))) return
    // 先删记录再补发：即使发送失败也不要在每次启动重复刷同一条。
    try {
      unlinkSync(path)
    } catch {
      /* ignore */
    }
    for (const [kind, rec] of recs) {
      const label = AUTOMATION_LABEL[kind] ?? kind
      const secs = Number.isFinite(rec.at) ? Math.max(1, Math.round((Date.now() - rec.at) / 1000)) : 0
      const text = `⚠️ 自动${label}已中断（桥重启）${secs ? `（跑了 ${secs}s）` : ""}\n上一进程退出时该动作尚未完成；如仍需要请重试。`
      try {
        await reply(String(rec.chat), text)
        await log("info", `stale automation notice closed (kind=${kind}, sent)`)
      } catch (err) {
        await log("warn", `stale automation notice close failed (kind=${kind}): ${sanitizeLog(String(err)).slice(0, 120)}`)
      }
    }
  }

  // ── R942：结束本轮以更换出口（/proxy next）────────────────────────────────
  // 出口代理**按轮换**：Bun 在进程启动时解析一次代理，运行期改 env 也不换隧道
  // （实测），所以"换出口"只能靠**结束本轮** → workflow relay 起新 run → 新 run
  // 重新挑一个代理（新出口 IP ⇒ 不再撞同一个额度）。
  // 桥就住在将被杀的 opencode 进程里 ⇒ 必须**先回 TG、再延迟杀**（1.5s）。
  const endRunForNewExit = (): void => {
    if (String(process.env.TG_BRIDGE_FORCE_SERVE ?? "") !== "1") {
      void log("info", "exit-proxy: end-run requested outside CI (TG_BRIDGE_FORCE_SERVE!=1); ignored")
      return
    }
    setTimeout(() => {
      try {
        for (const name of readdirSync("/proc")) {
          if (!/^\d+$/.test(name)) continue
          const pid = Number(name)
          if (pid === process.pid) continue
          let comm = ""
          try {
            comm = readFileSync(`/proc/${name}/comm`, "utf8").trim()
          } catch {
            continue
          }
          if (comm === "opencode") {
            try {
              process.kill(pid, "SIGKILL")
            } catch {
              /* 已退出/无权限：忽略 */
            }
          }
        }
      } catch {
        /* /proc 不可读：忽略 */
      }
    }, 1500)
  }

  // 只有最新回复保留按钮：新回复落地即扒掉上一条同会话回复的键
  const trackReplyButtons = async (sess: string, chatID: string, msgID: number, kb: unknown[][] | undefined, key: string): Promise<void> => {
    if (!sess || !kb) return
    const prev = lastReply.get(sess)
    // R2635（运营者：同时发送多条信息时停止按钮会遗留，直到兜底清除）：
    // 先登记“最新一条”，再 await 扒旧键。旧实现等网络返回后才写 lastReply，
    // 并发发送时后一条仍读到更早的 prev（中间那条没人扒）；或最后的 set 顺序
    // 反过来，把真正最新的一条覆盖掉 —— 两种情况都会留下停止键，只有启动
    // 回扫（backfillStrip）才清得掉。登记提前后，每次调用都只依赖上一次调用
    // 已同步写入的 lastReply，链式 demote 不再受网络时序影响。
    lastReply.set(sess, { chat: chatID, id: msgID, key })
    savePersistedState()
    if (!prev || prev.id === msgID) return
    const pk = prev.key || ""
    const kind = pk.includes(":message:") ? "reply" : pk.includes(":tool:") ? "tool" : pk.includes(":thinking:") ? "think" : pk.includes(":status:") ? "status" : "other"
    let rows: unknown[][] | null = []
    if (kind === "tool") {
      let fid = ""
      for (const [k2, v2] of [...fullKeyStore.entries()]) {
        if (v2.sid === sess && v2.key === pk) fid = k2
      }
      rows = fid ? [[{ text: "📄 看完整版", callback_data: `full:${fid}` }]] : []
    } else if (kind === "other" || kind === "") {
      rows = null
    }
    if (rows === null) return
    try {
      const r = await tgFetch("editMessageReplyMarkup", { chat_id: Number(prev.chat) || prev.chat, message_id: prev.id, reply_markup: { inline_keyboard: rows } })
      // R2510：400 "message is not modified" = 按钮早已是目标状态（成功），
      // 旧代码把它记成 fail，正是“部分停止按钮没删除”的假警报来源。
      // 真失败必须带 Telegram 的 desc，否则无法区分“已清掉”和“永远清不掉”。
      const why = sanitizeLog(r.desc ?? "").slice(0, 80)
      const noop = r.status === 400 && /not modified/i.test(why)
      await log(
        "info",
        `demote prev buttons (session=${sanitizeLog(sess)} msg=${prev.id} kind=${kind} ${r.ok || noop ? "ok" : "fail"}${noop ? " (not modified)" : why && !r.ok ? ` desc=${why}` : ""})`,
      )
      if ((r.ok || noop) && pk) {
        strippedKb.add(pk)
        if (strippedKb.size > STRIP_KB_MAX) {
          const first = strippedKb.values().next()
          if (!first.done) strippedKb.delete(first.value)
        }
      } else if (!r.ok) {
        // R2635：并发发送/限流时这次 demote 会失败（本地 flood gate 直接返回 429，
        // 不触网）。旧实现丢掉这次失败 —— 旧键一直留到下次启动回扫。现在把
        // backfill 的冷却清零并在闸门结束后补扫；它只清非最新卡，不会误删新卡。
        deferStrip(`demote msg=${prev.id} status=${r.status ?? 0}`)
      }
    } catch {
      // best-effort: 旧消息过旧则跳过；同样安排一次兜底补扫
      deferStrip(`demote msg=${prev.id} exception`)
    }
  }

  // 关键消息遇到 429/本地 flood gate 时保留并退避重试；思考/工具/状态卡仍按防洪策略舍弃。
  // R568：同 chat 是否还有待重发的更早消息（发送顺序屏障用；不再改写标题时钟）。
  const pendingProtoRetryForChat = (chatID: string): boolean => {
    for (const it of protoRetry.values()) {
      if (String(it.chatID) === String(chatID)) return true
    }
    return false
  }

  const scheduleProtoRetry = (
    key: string,
    chatID: string,
    text: string,
    kb: unknown[][] | undefined,
    silent: boolean,
    editId = 0,
    fallback = false,
    firstDelayMs = 5_000
  ): void => {
    if (!key.includes(":message:") && !key.includes(":ask:")) return
    const old = protoRetry.get(key)
    if (old) {
      old.chatID = chatID
      old.text = text
      old.kb = kb
      old.silent = silent
      old.editId = editId
      old.fallback = fallback
      return
    }
    const item = { chatID, text, kb, silent, editId, fallback, attempt: 0, firstTryAt: Date.now(), timer: undefined as ReturnType<typeof setTimeout> | undefined }
    protoRetry.set(key, item)
    while (protoRetry.size > 200) {
      const first = protoRetry.keys().next()
      if (first.done) break
      const oldKey = first.value
      const oldItem = protoRetry.get(oldKey)
      if (oldItem?.timer) clearTimeout(oldItem.timer)
      protoRetry.delete(oldKey)
      // R1857：淘汰最旧待重发内容**必须留痕** —— 与 abandon / permanent-drop 同族。
      // 旧实现静默 clearTimeout+delete：重试队列积压超 200 时，最旧那条消息就凭空消失，
      // 事后从日志完全看不出（正是用户体感的"部分消息不发送"）。上限本身可以接受，
      // 但"丢弃"这个动作不能无声。
      void log(
        "warn",
        `proto retry evicted (cap 200, oldest): ${sanitizeLog(oldKey)} attempts=${oldItem?.attempt ?? 0} len=${(oldItem?.text ?? "").length}`,
      )
      // R1890：但 warn 日志**对用户不可见** —— 必须同时进 drop census，与 send/edit/
      // queue-full/flood-shed/edit-degrade/proto-retry-exhausted 同属「内容确实没送出去」。
      // dropRing 消费方是 /drop 诊断卡（L7773-7778），只列最后 10 条；不进它，用户在 TG
      // 里就看不到这次淘汰造成的内容损失。实测 dropRing 无"容量类"单独子类、淘汰条目
      // 与其它 kind 平等，故本条必须显式 noteDrop。
      noteDrop(
        "proto-retry-evicted",
        `chat=${sanitizeLog(oldItem?.chatID ?? "")} attempts=${oldItem?.attempt ?? 0} len=${(oldItem?.text ?? "").length}`,
      )
    }
    const run = async (): Promise<void> => {
      const retrySid = key.split(":")[0] ?? ""
      const retryFront = frontSessionID || persistedFront
      if (G[GEN_KEY] !== myGen || (loopStopped() && !key.includes(":ask:") && (!retryFront || retrySid !== retryFront))) {
        // 停止/换代时放弃这条待重发内容 —— 可以接受（用户主动停的），但**必须留痕**：
        // 此前是静默删除，事后从日志里完全看不出"有内容没送到"。
        await log(
          "info",
          `proto retry abandoned (${sanitizeLog(key)}): ${G[GEN_KEY] !== myGen ? "instance superseded" : "loop stopped, non-target session"}`,
        )
        protoRetry.delete(key)
        return
      }
      item.timer = undefined
      // R2558：同 chat 最小补发间隔。冷却期积压的条目会在结束后同时到期，
      // 只靠“最老优先”屏障仍可能背靠背触网（实测 42 条积压 → 二次 429）。
      // 这里先按上次尝试时间匀速放行；失败尝试也计入，避免失败风暴。
      const lastRetryAt = protoRetryLastAttempt.get(item.chatID) ?? 0
      const retryWaitMs = PROTO_RETRY_GAP_MS - (Date.now() - lastRetryAt)
      if (lastRetryAt > 0 && retryWaitMs > 0) {
        item.timer = setTimeout(run, retryWaitMs)
        return
      }
      // R568：同 chat 串行重发——若还有 firstTryAt 更早的待重发项，先等它落地，
      // 避免后发先到造成倒挂（顺序由屏障保证，不再改写表面时间）。
      for (const [k2, it2] of protoRetry) {
        if (k2 === key) continue
        if (String(it2.chatID) !== String(item.chatID)) continue
        const olderTs = it2.firstTryAt || 0
        const myTs = item.firstTryAt || 0
        if (olderTs < myTs || (olderTs === myTs && k2 < key)) {
          item.timer = setTimeout(run, PROTO_RETRY_GAP_MS)
          return
        }
      }
      // R568：原先在发送副本上改写标题时钟（R-2026-10-19 的止血）已移除——顺序由上面的
      // 同 chat 屏障保证；item.text 保持原文，标题时钟即生成时刻，不再改动表面时间。
      // R568：顺序由同 chat 屏障保证（更早的待重发未落地前本条不发、新消息也排队），
      // 因此保留**原始标题时钟**，不再改写表面时间。
      // R2558：无论本次成功/失败都占用一个补发窗口，防止失败风暴。
      protoRetryLastAttempt.set(item.chatID, Date.now())
      const sendText = item.text
      const r = item.editId > 0
        ? await editTextRaw(item.chatID, item.editId, sendText, item.kb, item.fallback)
        : await sendTextRaw(item.chatID, sendText, item.kb, item.silent)
      if (r.r === "sent") {
        const id = r.id ?? item.editId
        // ── 重复发送自清理（at-least-once 的必然产物）─────────────────────
        // 实测：`sendMessage` 报 `network-exception` 但请求**已被 Telegram 接受**（只是回包丢了）
        // → 重试再发一次 → 用户看到两条同内容消息（msg=9372 与 msg=9373）。
        // Telegram 的 sendMessage 不幂等、也没有"列出消息"接口，**无法完全避免**；
        // 但桥知道旧 id（protoMap 里有同内容记录）→ 把旧那条改成一句说明，避免视觉重复。
        // 诚实标注：若首条落地时**没有**留下 id（首抛异常、protoMap 为空），这种情况**无法清理**。
        const prevSame = id > 0 ? protoMap.get(key) : undefined
        if (prevSame && prevSame.id > 0 && prevSame.id !== id && prevSame.text === item.text) {
          const cleaned = await editTextRaw(
            item.chatID,
            prevSame.id,
            "（重复发送已自动清理：上一条与本条内容相同）",
            undefined,
            false,
          )
          await log(
            "info",
            `proto duplicate cleaned (key=${sanitizeLog(key)}, stale_msg=${prevSame.id}, kept_msg=${id}, edit=${cleaned.r})`,
          )
        }
        if (id > 0) protoMap.set(key, { id, text: item.text, fallback: r.fallback === true })
        const h = hashText(item.text)
        // R1444：判重键绑定 key，与 protoSend 检查身一致（见前文注释）
        if (h) sentHash.add(`${key}#${h}`)
        lastPushAt = new Date().toISOString()
        lastRealPush.set(key.split(":")[0] ?? "", Date.now())
        touchActivity(key.split(":")[0] ?? "")
        savePersistedState()
        if (id > 0 && item.kb && r.fallback !== true) await trackReplyButtons(key.split(":")[0] ?? "", item.chatID, id, item.kb, key)
        protoRetry.delete(key)
        await log("info", `proto retry delivered (${sanitizeLog(key)}) msg=${r.id ?? item.editId}`)
        return
      }
      if (r.r === "retry") {
        item.attempt++
        // R1889：重试**总额度**。旧实现 attempt 只增不设上限，只要判定还是 retry 就无限续，
        // 退避实际封顶 **30s** → 一个永久失败的 key 会**每 30 秒**打一次 Telegram 直到天荒地老。
        // （实测更正：外层 `Math.min(60_000, …)` 那层钳位**不可达** —— 内层 `Math.min(attempt,6)`
        //   已把上限锁在 6×5s=30s。此前注释与状态记录都写成"封顶 60s / 每分钟"，是错的。）
        // 收敛出口本来只有四条：成功、非 retry 的永久失败、换代/停循环放弃、队首淘汰
        // （cap 200，淘汰会 warn 但那条内容就此不再送达）。没有额度上限意味着"瞬时抖动"
        // 与"永久故障"在行为上**无法区分**：后者会一直占着一个队列位并持续刷网。
        // 定性诚实：**无线上实际复发证据**（可见日志只覆盖约 7.5 分钟、436 行，不足以判断），
        // 故这是潜在面硬化。R714 实测：rawRetryAfter=4631s，900s 封顶会多轮重装；48 次
        // （≈22 分钟）仍可能在原始冷却结束前丢弃 bot3 补发；默认改为 240 次（≈2 小时）。
        // 耗尽后走**与永久失败同一条** verdict（error 级 + noteDrop 语义的日志），
        // 于是"没送出去"在日志里始终有交代，不靠沉默。env TG_PROTO_RETRY_MAX_ATTEMPTS 可调。
        if (item.attempt >= PROTO_RETRY_MAX_ATTEMPTS) {
          clearTimeout(item.timer)
          protoRetry.delete(key)
          // 必须同时进 drop census：这与 send/edit/queue-full/flood-shed/edit-degrade 是
          // **同一族**「内容确实没送出去」的事件。此前只记 log → 用户在 TG 里看到的
          // 丢件清单里**看不到这条**，等于损失只存在于日志、不可见。
          noteDrop("proto-retry-exhausted", `chat=${sanitizeLog(item.chatID)} attempts=${item.attempt} budget=${PROTO_RETRY_MAX_ATTEMPTS} len=${item.text.length}`)
          await log(
            "error",
            `proto retry dropped permanently (${sanitizeLog(key)}): attempts=${item.attempt} reason=retry-budget-exhausted budget=${PROTO_RETRY_MAX_ATTEMPTS} last=${sanitizeLog((r as any).desc ?? "").slice(0, 120)}`,
          )
          return
        }
        const delay = Math.min(60_000, 5_000 * Math.min(item.attempt, 6))
        item.timer = setTimeout(() => void run(), delay)
        return
      }
      // 永久失败（4xx 等）：丢弃但必须记录，否则表现为"内容凭空消失"
      await log(
        "error",
        `proto retry dropped permanently (${sanitizeLog(key)}): attempts=${item.attempt} desc=${sanitizeLog((r as any).desc ?? "").slice(0, 120)}`,
      )
      protoRetry.delete(key)
    }
    item.timer = setTimeout(() => void run(), firstDelayMs)
  }

  // R2570：本次扫描没跑完（429/5xx/网络层）时不能保留"刚扫过"的冷却时间戳，
  // 否则同一进程内的热重载/后续调用会跳过、旧按钮继续残留。归零让下一次
  // 调用立即可重试；本进程若还活着，则在限流闸结束后再补一次。
  // R2635：提为闭包级，发送路径的 demote 失败也会调用（见 trackReplyButtons）。
  const deferStrip = (why: string): void => {
    try {
      writeFileSync(STRIP_STATE_PATH, JSON.stringify({ owner: pollInstanceId, ts: 0 }), {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
      })
    } catch {
      /* best-effort */
    }
    if (stripRetryTimer) return
    const delay = Math.max(60_000, Math.max(floodGate.floodUntil, floodGate.fallbackUntil) - Date.now() + 5_000)
    stripRetryTimer = setTimeout(() => {
      stripRetryTimer = undefined
      if (G[GEN_KEY] !== myGen) return
      // R2635：这次补扫由**真实的 demote 失败**触发，不是空闲巡检 ——
      // 即使循环已停止（用户按过 /stop 后仍在手动对话）也必须执行，
      // 否则旧停止键会一直留到下次进程重启的启动回扫。
      void backfillStrip(true)
    }, delay)
    void log("info", `backfill strip retry scheduled in ${Math.ceil(delay / 1000)}s (${why})`)
  }

  // 启动回扫：protoMap 里残留的旧 :message: 键一律扒键（新回复落地后自然只剩最新）。
  // TUI  standby 直接 return，此处只在 serve 执行。
  // `force=true`：由 deferStrip 的失败补扫调用，绕过 loopStopped 闸门 ——
  //   循环停止只表示不再自动跑下一轮，用户手动对话留下的旧停止键仍然是垃圾。
  const backfillStrip = async (force = false): Promise<void> => {
    try {
      if (G[GEN_KEY] !== myGen || !ownsPollLease()) return
      if (!force && loopStopped()) return
      const chat = pushChatResolve()
      if (!chat) return
      const now = Date.now()
      let lastRun = 0
      try {
        const prior = JSON.parse(readFileSync(STRIP_STATE_PATH, "utf8")) as any
        if (typeof prior?.ts === "number") lastRun = prior.ts
      } catch {
        /* first run */
      }
      if (lastRun > 0 && now - lastRun < STRIP_RUN_INTERVAL_MS) {
        await log("info", `backfill strip skipped (cooldown ${Math.ceil((STRIP_RUN_INTERVAL_MS - (now - lastRun)) / 1000)}s)`)
        return
      }
      writeFileSync(STRIP_STATE_PATH, JSON.stringify({ owner: pollInstanceId, ts: now }), { encoding: "utf8", mode: PRIVATE_FILE_MODE })
      const claimed = JSON.parse(readFileSync(STRIP_STATE_PATH, "utf8")) as any
      if (claimed?.owner !== pollInstanceId) return
      const bySess = new Map<string, number>()
      const isStopKey = (k: string): boolean => k.includes(":message:") || k.includes(":ask:") || k.includes(":thinking:") || k.includes(":tool:") || k.includes(":status")
      for (const [k, v] of [...protoMap.entries()]) {
        // R2504: thinking/tool/status cards carry the same ⏹ button; the old
        // backfill only scanned message/ask, so those buttons survived reloads.
        if (!isStopKey(k)) continue
        const sid = k.split(":")[0] ?? ""
        if (!sid) continue
        const cur = bySess.get(sid) ?? 0
        if (v.id > cur) bySess.set(sid, v.id)
      }
      let n = 0
      for (const [k, v] of [...protoMap.entries()]) {
        if (!isStopKey(k)) continue
        const sid = k.split(":")[0] ?? ""
        if (v.fallback === true) continue
        if ((bySess.get(sid) ?? 0) === v.id) {
          lastReply.set(sid, { chat, id: v.id, key: k })
          continue
        }
        // 已处理过的跳过（否则每次重载都重数 89，还白 hammer TG 招 429）
        if (strippedKb.has(k)) continue
        // 旧键清理是低优先级；限流闸开启时立即让路给实时回复/工具消息。
        if (Date.now() < floodGate.floodUntil) {
          await log("info", "backfill strip deferred (flood gate active)")
          deferStrip("flood gate active")
          break
        }
        if (G[GEN_KEY] !== myGen || !ownsPollLease()) return
        try {
          const r = await tgFetch("editMessageReplyMarkup", { chat_id: Number(chat) || chat, message_id: v.id, reply_markup: { inline_keyboard: [] } })
          if (G[GEN_KEY] !== myGen || !ownsPollLease()) return
          if (!r.ok) {
            // 400/403 是永久性拒绝（消息不可编辑、not modified、内容无变化等），
            // 重试只会刷错误日志并反复打 API；只有 429/5xx 才值得退避重试。
            if (r.status === 400 || r.status === 403) {
              stripFail.delete(k)
              strippedKb.add(k)
              // ⚠️ 必须记 `desc`：400 在这条路径上有**两种完全相反的含义 ——
              //   "message is not modified" = 按钮本来就对，等于成功；
              //   "message can't be edited"  = 那张卡**永远留着旧按钮**（用户报的"按钮越堆越多"）。
              // 行为上两者都该标记完成、不重试，所以缺 desc **不影响正确性**；
              // 但缺了它我就答不了"旧卡按钮到底清没清掉"。实测这条路径已经触发 454 次。
              // 这也正是 sendTextRaw 里早就写下的规矩（「永久失败必须记 API 的真实原因」），
              // 这里当初漏了。
              const raw = String(r.desc ?? "")
              const why = sanitizeLog(raw).slice(0, 60) || "(no desc)"
              // `not modified` = **按钮已经是目标状态**，这次 strip 本来就无需改动 ——
              // 它是**成功**，不是失败。R1021 实测：带 desc 的 159 条**全部**是这一种，
              // 而旧措辞把它们记成 `skipped; permanent`，读起来像 159 次失败。
              // `editTextRaw` 对同一个语义本来就当成功处理（记 `already up to date`），
              // 两处措辞不一致会让日志自相矛盾。行为不变（都标记完成、不重试），
              // 只是**把成功说成成功**。
              if (r.status === 400 && /not modified/i.test(raw)) {
                await log("info", `backfill strip noop (mid=${v.id}): 按钮已是目标状态，无需改动`)
              } else {
                await log("info", `backfill strip skipped (mid=${v.id}, status=${r.status}, desc=${why}; permanent)`)
              }
              continue
            }
            const status = r.status ?? 0
            // R1842：**瞬时**失败（429 限流 / 5xx / status 0 网络层无响应）**不计入** stripFail。
            // 原实现把它们跟"确定性失败"一起累加，达到 STRIP_FAIL_MAX(5) 就**永久放弃**该消息
            // （mark stripped，按钮再也删不掉）—— 与紧邻的 "网络层失败可重试" 日志**自相矛盾**；
            // 且 stripFail 跨重启持久化（sidecar），于是**有网络抖动的那台机反而更容易永久残留旧按钮**
            // （正是用户报的"按钮越堆越多"）。瞬时失败只 defer，不累计、不放弃。
            const transientStripFail = isTransientStripFailure(status)
            if (transientStripFail) {
              if (status === 429) {
                // R434（R433 backlog 微项）：瞬时 defer 不该用 error（语义=闸内延迟、非放弃；
                // error 只留给确定性失败/放弃），与 R431 retry 降噪同旨。
                await log("warn", `backfill strip deferred (mid=${v.id}, status=429; flood gate, 瞬时失败不计入放弃)`)
                deferStrip(`mid=${v.id} status=429`)
                break
              }
              const kind = status === 0 ? `network/no-response${r.desc ? ` (${r.desc})` : ""}` : `status=${status}`
              const why = status === 0 ? "网络层失败可重试" : "服务端瞬时失败可重试"
              await log("warn", `backfill strip failed (mid=${v.id}, ${kind}; ${why}，不计入放弃)`)
              deferStrip(`mid=${v.id} ${kind}`)
              continue
            }
            // 到此为**非瞬时**且非 400/403（例如 404 message not found）：确定性失败，累计用于放弃。
            const failures = (stripFail.get(k) ?? 0) + 1
            stripFail.set(k, failures)
            if (failures >= STRIP_FAIL_MAX) {
              stripFail.delete(k)
              strippedKb.add(k)
              await log("error", `backfill strip abandoned (mid=${v.id}, fails=${failures}, lastStatus=${status}, desc=${sanitizeLog(String(r.desc ?? "")).slice(0, 60)})`)
            } else {
              await log("error", `backfill strip failed (mid=${v.id}, status=${status} try=${failures}; 确定性失败)`)
            }
            continue
          }
          stripFail.delete(k)
          strippedKb.add(k)
          n++
        } catch {
          /* best-effort */
        }
      }
      while (strippedKb.size > STRIP_KB_MAX) {
        const first = strippedKb.values().next()
        if (first.done) break
        strippedKb.delete(first.value)
      }
      if (G[GEN_KEY] !== myGen || !ownsPollLease()) return
      savePersistedState()
      persistStripFail()
      await log("info", `backfill strip done (cleared=${n})`)
    } catch (err) {
      await log("error", `backfill strip failed: ${sanitizeLog(err).slice(0, 120)}`)
    }
  }
  const protoSend = async (key: string, chatID: string, text: string, edit: boolean, forceFullBtn = false, fullOverride = "", kbOverride?: unknown[][] | null, noDedup = false): Promise<void> => {
    // 重载窗口防双发：旧实例在途请求不落地，只有最新 generation 才允许触网。
    // 必须在 shouldSend 之前（shouldSend 会写共享 sentParts，拦了白拦还会污染新实例）。
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    syncPersistedTarget()
    // 停止后不再推送其它后台会话；当前 TG 目标会话的可见内容仍放行，
    // 这样用户能看到刚完成/手动触发的结果，不会因停自动循环而整页空白。
    // R2627（2026-11-13 实失）：判据必须与 isPrimaryPush/补扫同源，优先用钉选目标。
    //   旧写法 `frontSessionID || persistedFront` 只看内存前台；`/use` 只写
    //   fixedTarget/persistedFront，frontSessionID 仍停留在旧会话 → 循环停止时
    //   用户刚切过去的会话被当成后台，可见正文全部静默丢弃（六条回复 id=0 catchup）。
    const stopFront = fixedTarget ?? frontSessionID ?? persistedFront
    const stopSid = key.split(":")[0] ?? ""
    if (loopStopped() && !key.includes(":ask:") && (!stopFront || stopSid !== stopFront)) {
      // 静默跳过是这次最难查的一层：日志里只有补扫的 catchup 标记，没有“为什么没发”。
      // 记进 dropRing（/drops 可见），不逐条写日志防刷屏。
      const frontTag = stopFront ? sanitizeLog(stopFront).slice(0, 12) : "-"
      noteDrop("loop-stop", `${sanitizeLog(key).slice(0, 70)} front=${frontTag}`)
      return
    }
    // 防洪脱载：限流闸开启时只保 💬 回复与问询卡，思考/工具/状态卡直接舍（不断 append 就是 429 永动机）
    if (Date.now() < floodGate.floodUntil && (key.includes(":thinking:") || key.includes(":tool:") || key.includes(":status:"))) {
      noteDrop("flood-shed", `${sanitizeLog(key).slice(0, 60)} len=${text.length}`)
      return
    }
    if (!noDedup && !shouldSend(key, text)) return
    const noHash = key.includes(":status")
    const h = noHash ? "" : hashText(text)
    // `h` 除了做去重键，还被写进发送/编辑日志（R1013 的教训）：
    // 之前判断"是不是重复发送"只能拿 len 当**代理**，而长度相同**不等于**内容相同
    //（两次真内容不同的卡片也可能等长）→ 那条 :ask: 疑点既证不实也排除不了。
    // 日志里带上 h 之后，判重就是**测量**而不是推断。
    // R1444：判重键必须**绑定 key**（`${key}#${h}`），不能只比全局 hash——
    // 否则不同 part 的**同文本**卡（如每轮收尾的「✅ 已完成 · 用时约 X 分钟」
    // 「✅ 队列已空（复用）」等完成卡，key 各异、内容相同）会被跨 key 误吞：
    // 首张发出后 hash 进全局集合，后续所有同内容卡被静默跳过 → 用户视角
    // 「输出结束的前几条总是不发」。绑定 key 后：同 key 同文本仍防重（防流式
    // 尾巴/重试用例），跨 key 同文本正常放行。
    if (!noDedup && h && sentHash.has(`${key}#${h}`)) {
      await log("info", `proto hash-dup skip (${sanitizeLog(key)}) len=${text.length}`)
      return
    }
    if (protoMap.size > 200) {
      // **不能删掉正在被看门狗跟踪的 :input 键**：它是"永远执行中"卡片的唯一
      // message id 来源。删掉后对账拿不到 id 就无法改写，卡片将永远停在"执行中"，
      // 且日志里一条痕迹都没有（用户实测"一直执行中"）。工具一旦进入终态，
      // 完成分支会 `staleToolBorn.delete` 掉它 → 重新变得可回收，自清理仍成立。
      for (const k of [...protoMap.keys()]) {
        if (!k.endsWith(":input")) continue
        if (staleToolBorn.has(k)) continue
        // ⚠️ 还要保住 `runningAt > 0` 的键：它们是**跨重载存活的**恢复信号（内存里的
        // staleToolBorn/staleCardIdx 重载后是空的）。丢掉它们 → 启动恢复的"仍在跑"分支
        // `protoMap.has(key)` 判假 → 飞行中的工具卡永远不会被重新登记（实测：重载发生在
        // 长命令飞行途中时，13 分钟里看门狗一次都没触发）。
        if (Number((protoMap.get(k) as { runningAt?: number } | undefined)?.runningAt ?? 0) > 0) continue
        protoMap.delete(k)
      }
    }
    if (protoMap.size > 800) {
      // 内存护栏：保 :status: 键，删最旧其它（Map 保持插入序）
      for (const [k] of [...protoMap.entries()]) {
        if (protoMap.size <= 800) break
        if (k.includes(":status:")) continue
        // R2637：菜单锚点只占每 chat 一条；删掉它会让下次 /menu 多发一条。
        if (k.startsWith("menu:")) continue
        if (staleToolBorn.has(k)) continue
        if (Number((protoMap.get(k) as { runningAt?: number } | undefined)?.runningAt ?? 0) > 0) continue
        protoMap.delete(k)
      }
    }
    const sess = key.split(":")[0] ?? ""
    if (sess) protoOwned.add(sess)
    const rollback = (): void => {
      if (sentParts.get(key) === text) sentParts.delete(key)
    }
    const prev = protoMap.get(key)
    // 内容按钮：💬 回复挂 [停止]；超长被截断的回复/工具追加 [看完整版]（重试仅走 /retry 命令）
    const isReply = key.includes(":message:")
    const isTool = key.includes(":tool:")
    const isThink = key.includes(":thinking:")
    const isStatus = key.includes(":status")
    // 停止键全覆盖；已停止会话的新消息不再挂停止键
    // 停止键全覆盖；已停止会话的新消息不再挂停止键。
    // callback 自带上下文 stop:<kind>:<sid>[:<fid>]，点了即扒，不过期。
    const stopData = (kind: string, extra = ""): string => `stop:${kind}:${sess}${extra}`
    const hasStop = !haltedSet.has(sess)
    let kb: unknown[][] | undefined
    if (isReply) {
      kb = hasStop ? [[{ text: "⏹ 停止", callback_data: stopData("m") }]] : undefined
    } else if (isThink) {
      kb = hasStop ? [[{ text: "⏹ 停止", callback_data: stopData("h") }]] : undefined
    } else if (isStatus) {
      kb = hasStop ? [[{ text: "⏹ 停止", callback_data: stopData("s") }]] : undefined
    } else if (isTool) {
      kb = hasStop ? [[{ text: "⏹ 停止", callback_data: stopData("t") }]] : undefined
    }
    if ((text.length > PUSH_MAX || forceFullBtn) && (isReply || isTool)) {
      const [cut, truncated] = truncateAt(text, PUSH_MAX)
      const shown = truncated ? cut + htmlEsc(`\n[truncated -${text.length - cut.length} chars]`) : text
      const fid = storeFullText(fullOverride || text, shown, sess, key)
      savePersistedState()
      const fullRow = [{ text: "📄 看完整版", callback_data: `full:${fid}` }]
      if (isTool) {
        kb = [...(hasStop ? [[{ text: "⏹ 停止", callback_data: `stop:t:${sess}:${fid}` }]] : []), fullRow]
      } else {
        kb = kb ? [...kb, fullRow] : [fullRow]
      }
    }
    if (kbOverride !== undefined) kb = kbOverride ?? undefined
    // 已扒键：edit 通道不再重带（防流式尾巴/reload重推复活）；显式切换（kbOverride）不受影响
    if (kbOverride === undefined && strippedKb.has(key)) kb = undefined
    if (kb) {
      await log("info", `proto kb (${sanitizeLog(key)}) rows=${kb.length}`)
    }
    // machine blocks don't ring: only real replies / errors notify.
    const silent = key.includes(":thinking:") || key.includes(":tool:") || key.includes(":status")
    const noteHash = (): void => {
      if (!h) return
      // R1444：判重键绑定 key（防跨 key 同文本误吞，见前文注释）
      sentHash.add(`${key}#${h}`)
      if (sentHash.size > 1500) {
        const arr = [...sentHash]
        for (const x of arr.slice(0, arr.length - 1500)) sentHash.delete(x)
      }
    }
    // R2673（运营者：「仅标题的同种信息…连续的合并为一个…（×n）」）：
    //   仅标题卡片（整条只有 <b>标题</b>）只在**新消息**路径参与合并；
    //   `edit && prev` 是同一张卡的流式/终态改写，不是新卡，走下面的既有分支。
    const newMessage = !(edit && prev)
    const mergeKind = titleOnlyKind(text)
    // R2674：本 Bot 的开关，不再读全局文件（各 Bot 的推送过滤互不影响）。
    const mergeOn = newMessage && mergeKind ? titleMergeOn : false
    let restackCount = 0
    // R2682：重新堆叠会改写实际发出去的内容，但不改动 `text` —— `shouldSend`
    // 和 rollback 记的是**原始**文本，原地重赋值会让 rollback 永远对不上。
    let outText = text
    if (newMessage && mergeKind && mergeOn) {
      const chain = titleMergeChains.get(chatID)
      if (chain && chain.sid === sess && chain.kind === mergeKind && chain.id > 0) {
        const latestId = lastChatMessageIds.get(chatID) ?? 0
        if (titleMergeAnchorAction(chain.id, latestId) === "restack") {
          // R2682（运营者：「仅标题堆叠时保证其为最新消息，不是就重新堆叠」）：
          // 锚点之后已经有新消息（用户发言、别的卡、其它 Bot）。此时 edit 旧卡
          // 只会让计数在聊天中部悄悄变化，用户看到的“最后一条”仍是别的消息。
          // 于是发一条**新消息**到底部；旧卡留在原处作为历史。
          // R2702（运营者：「消息堆叠的计数要重新开始」）：重堆就是新链，
          // 计数从 1 起（重试项自带计数时保留，避免降级重发洗掉累计）。
          const count = titleMergeRestackCount(text)
          restackCount = count
          outText = withTitleMergeCount(text, count)
          titleMergeChains.delete(chatID)
          await log(
            "info",
            `proto merge restack (${sanitizeLog(key)}) old=${chain.id} latest=${latestId} n=${count} kind=${sanitizeLog(mergeKind)}`,
          )
        } else {
          // 重试项可能已经带着同一计数（编辑失败后降级重发又进重试）→ 不能再次 +1。
          const incomingCount = titleMergeCount(text)
          const alreadyCounted = incomingCount > 1 && incomingCount === chain.count
          const count = alreadyCounted ? chain.count : chain.count + 1
          const merged = alreadyCounted ? text : withTitleMergeCount(text, count)
          const mr = await editTextRaw(chatID, chain.id, merged, kb, chain.fallback)
          if (mr.r === "sent") {
            const fallback = mr.fallback === true || chain.fallback
            protoMap.set(key, { id: chain.id, text: merged, fallback })
            chain.count = count
            chain.key = key
            chain.fallback = fallback
            noteHash()
            savePersistedState()
            lastProtoSendAt = Date.now()
            if (kb && mr.fallback !== true) await trackReplyButtons(sess, chatID, chain.id, kb, key)
            await log("info", `proto merge ok (${sanitizeLog(key)}) msg=${chain.id} n=${count} kind=${sanitizeLog(mergeKind)}`)
            return
          }
          // 编辑失败（消息被删/超期/网络）→ 断开链条，按普通新卡发送。
          titleMergeChains.delete(chatID)
          await log("warn", `proto merge edit failed (${sanitizeLog(key)}) → new card`)
        }
      }
    }
    if (edit && prev) {
      // R2673：合并链上的卡片被后续事件改写（典型：工具从「执行中」→ 完成）时，
      // 保持末尾的（×n）不被覆盖；普通卡片编辑完全不受影响。
      const chain = titleMergeChains.get(chatID)
      const editKind = titleOnlyKind(text)
      const keep = chain && chain.id === prev.id && chain.sid === sess && editKind && editKind === chain.kind ? chain.count : 0
      const settled = keep > 1 ? withTitleMergeCount(text, keep) : text
      const r = await editTextRaw(chatID, prev.id, settled, kb, prev.fallback === true)
      if (r.r === "sent") {
        protoMap.set(key, { id: prev.id, text: settled, fallback: r.fallback === true || prev.fallback === true })
        if (keep > 1 && chain) {
          chain.key = key
          chain.fallback = r.fallback === true || chain.fallback
        }
        noteHash()
        savePersistedState()
        // R2570（D3）：编辑路径此前不更新 lastReply —— 状态卡在回合结束时被
        // `onIdle` 重新编辑并带上 ⏹，但 lastReply 仍指向更早的回复卡；30s 的
        // `stripStopOnCompletedTurn` 清掉回复卡后，状态卡上的 ⏹ 就永久残留
        //（用户实报「有部分停止按钮没有删除」）。与发送路径同口径登记最新卡，
        // 同一 id 的流式编辑不会额外触网，只有跨卡时才会 demote 旧卡。
        if (kb && r.fallback !== true) await trackReplyButtons(sess, chatID, prev.id, kb, key)
        await log("info", `proto edit ok (${sanitizeLog(key)}) msg=${prev.id} len=${settled.length} h=${h ? h.slice(0, 8) : "-"}`)
      } else {
        rollback()
        const rStatus = (r as { status?: number }).status ?? 0
        const rAfter = (r as { retryAfter?: number }).retryAfter ?? 0
        if (r.r === "retry") {
          // R2512（运营者：重复回复/按钮残留）：429/5xx/网络抖动是暂时失败，**不能降级新发**。
          // 状态卡每 60s 会整体重渲染，另发一张新卡只会让用户看到重复卡片；消息/ask 走
          // 现有 protoRetry（同一条消息稍后重试），也不新发。
          if (isStatus) {
            await log("info", `proto edit deferred (${sanitizeLog(key)}) status=${rStatus}${rAfter ? ` retry_after=${rAfter}` : ""}; status card refreshes on next tick`)
            return
          }
          if (key.includes(":message:") || key.includes(":ask:")) {
            scheduleProtoRetry(key, chatID, settled, kb, silent, prev.id, prev.fallback === true,
              rStatus === 429 ? Math.max(5_000, Math.min(900_000, rAfter * 1000)) : PROTO_RETRY_QUICK_MS)
            await log("info", `proto edit deferred behind retry (${sanitizeLog(key)}) status=${rStatus}${rAfter ? ` retry_after=${rAfter}` : ""}`)
            return
          }
          await log("warn", `proto edit transient failure (${sanitizeLog(key)}) status=${rStatus}; degrade send`)
        } else {
          await log("error", `proto edit failed (${sanitizeLog(key)}) → degrade send`)
        }
        if (pendingProtoRetryForChat(chatID)) {
          scheduleProtoRetry(key, chatID, settled, kb, silent, prev.id, prev.fallback === true, PROTO_RETRY_QUICK_MS)
          await log("info", `proto edit-degrade deferred behind pending retry (${sanitizeLog(key)})`)
          return
        }
        const n = await sendTextRaw(chatID, settled, kb, silent)
        // R1877：降级新发也走**同一条送达判定**（`protoDeliveryVerdict`），不再手写 if/else。
        const ndv = protoDeliveryVerdict(n)
        if (ndv.delivered && !ndv.degraded && n.id) {
          protoMap.set(key, { id: n.id, text: settled, fallback: n.fallback === true })
          // R2673：合并链上的卡降级新发成功 → 链条改指向新消息，后续同种卡继续合并到它。
          if (keep > 1 && chain) {
            chain.id = n.id
            chain.key = key
            chain.fallback = n.fallback === true
          }
          noteHash()
          savePersistedState()
          if (kb && n.fallback !== true) await trackReplyButtons(sess, chatID, n.id, kb, key)
        } else if (ndv.delivered) {
          // R1868：降级新发命中"TG 2xx 但无 message_id"（`callTelegram` 两条产路：result 缺
          // `message_id` / `res.json()` 抛异常）。旧代码只有上面两个分支 → 这条**静默**什么都不做：
          //   • 不刷新 `lastProtoSendAt` → 污染 R1728 静默断流 watchdog 基线（会误报"断流"）；
          //   • 不留任何日志 → 事后完全看不出"有内容已送达但无法锚定"。
          // 与主发送路径 R1802 同款处理：**已送达就得记账 + 留痕**；绝不能因无 id 就 rollback/重发
          //（那会把已送达当未投递，造成双发）。
          if (keep > 1) titleMergeChains.delete(chatID)
          noteHash()
          savePersistedState()
          lastPushAt = new Date().toISOString()
          if (sess) touchActivity(sess)
          lastProtoSendAt = Date.now()
          await log("warn", `proto edit-degrade delivered (${sanitizeLog(key)}) no message_id, 无法锚定卡片: ${ndv.why}`)
        } else if (n.r === "retry") {
          const nStatus = (n as { status?: number }).status ?? 0
          scheduleProtoRetry(key, chatID, settled, kb, silent, prev.id, prev.fallback === true, nStatus === 429 ? 5_000 : PROTO_RETRY_QUICK_MS)
        } else {
          // R1877：降级新发**永久失败**（4xx/drop）。旧写法只匹配 sent+id / retry / sent，`drop`
          // 三支全不中 → **静默丢弃**：既不排重试、不进 dropRing、也没日志。用户视角是"编辑失败后
          // 连降级新发也彻底没送到"，而日志里只有一句 `proto edit failed`，看不出新发也丢了。
          // 与主发送路径的 else（`proto send ${r.r}`）同款：**永久失败必须留痕 + 记账**。
          noteDrop("edit-degrade", `key=${sanitizeLog(key)} desc=${sanitizeLog((n as { desc?: string }).desc ?? "").slice(0, 120)}`)
          await log("error", `proto edit-degrade dropped (${sanitizeLog(key)}) desc=${sanitizeLog((n as { desc?: string }).desc ?? "").slice(0, 120)}`)
        }
      }
      return
    }
    if (pendingProtoRetryForChat(chatID)) {
      scheduleProtoRetry(key, chatID, outText, kb, silent, 0, false, PROTO_RETRY_QUICK_MS)
      await log("info", `proto send deferred behind pending retry (${sanitizeLog(key)})`)
      return
    }
    const r = await sendTextRaw(chatID, outText, kb, silent)
    // R1802：送达判定交给纯函数（原型是 `r.r==="sent" && r.id`，会把"已送达但无 id"读成失败）
    const dv = protoDeliveryVerdict(r)
    if (dv.delivered && !dv.degraded && r.id) {
      protoMap.set(key, { id: r.id, text: outText, fallback: r.fallback === true })
      // R2673：成功新发后播种/刷新合并链；非仅标题卡或模式关闭时断开链条。
      // 这条逻辑只在新消息路径执行（edit && prev 已在上方 return），所以不会误伤
      // 同一张卡的流式/终态改写。
      if (mergeKind && mergeOn) {
        // R2682/R2702：重新堆叠时用新链的起点计数（默认 1，重试项自带 n 则保留）；
        // 普通新卡 = 1。也兼容“重试项带着计数重新进入”的路径。
        const seedCount = restackCount > 0 ? restackCount : titleMergeCount(outText)
        titleMergeChains.set(chatID, { sid: sess, kind: mergeKind, key, id: r.id, count: seedCount, fallback: r.fallback === true })
      } else {
        titleMergeChains.delete(chatID)
      }
      noteHash()
      savePersistedState()
      lastPushAt = new Date().toISOString()
      if (sess) {
        lastRealPush.set(sess, Date.now())
        touchActivity(sess)
      }
      // 只有最新回复保留按钮：新回复落地即扒掉上一条同会话回复的键
      if (kb && r.fallback !== true) await trackReplyButtons(sess, chatID, r.id, kb, key)
      // R1728：投递成功 → 刷新桥侧最后投递时间戳（静默断流 watchdog 用）
      lastProtoSendAt = Date.now()
      await log("info", `proto send ok (${sanitizeLog(key)}) msg=${r.id} len=${outText.length} h=${h ? h.slice(0, 8) : "-"}`)
    } else if (dv.delivered) {
      // R1802：**TG 已接受、用户已收到**，只是没回 message_id → 我方无法锚定这张卡（不能
      // protoMap.set、不能挂按钮）。绝不能 rollback（会把已送达当未投递再走重试/降级），
      // 也不能不刷新 lastProtoSendAt（否则 R1728 watchdog 基线被污染成误报）。
      // 注意文案：**不用 error 级**——原实现在这里记 `proto send sent` 且级别为 error，
      // 造成"措辞说成功、级别说失败"，任何按级别或按关键字的判据都会读错一边。
      // R2673：没有 message_id 就无法作为合并锚点 → 断开链条。
      titleMergeChains.delete(chatID)
      noteHash()
      savePersistedState()
      lastPushAt = new Date().toISOString()
      if (sess) touchActivity(sess)
      lastProtoSendAt = Date.now()
      await log("warn", `proto send degraded (${sanitizeLog(key)}) no message_id, 无法锚定卡片: ${dv.why}`)
    } else {
      rollback()
      if (r.r === "retry") scheduleProtoRetry(key, chatID, outText, kb, silent, 0, false, r.status === 429 ? 5_000 : PROTO_RETRY_QUICK_MS)
      // R431：retry 是可自愈的瞬时状态（成功另行 info），error 级会被巡检误读成故障
      // （D8 曾把 26 条正常重试全计成「错误」）；永久失败（drop）仍保持 error。
      // R2609：带上 desc，才能一眼区分"本地闸门 deferred"与"真实 Telegram 429"。
      await log(r.r === "retry" ? "warn" : "error", `proto send ${r.r} (${sanitizeLog(key)}) len=${outText.length} status=${r.status ?? 0} retry_after=${r.retryAfter ?? 0}s${r.desc ? ` desc=${sanitizeLog(r.desc).slice(0, 80)}` : ""}`)
    }
  }

  // R1607：shell 提升到后台 → 在「原来消息」（执行中卡片）末尾追加一行提示。
  // 用户指令：「在shell提升到后台时，在原来消息末尾增加一行提示」。
  // _v2compat 的 bg-watch promote 成功后调全局钩子 __oc_bg_promoted_hooks__（fn(sid, evId)）。
  // R1609：只编辑"新鲜"卡（runningAt 距今 ≤ 阈值）；R1610：改精确 key 定位（evId），不再扫描。
  const PROMOTED_HINT_FRESH_MS =
    Number(process.env.TG_PROMOTED_HINT_FRESH_MS ?? "") || HINT_FRESH_MS_DEFAULT
  const noteShellPromoted = async (sid: string, callID?: string): Promise<void> => {
    try {
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      const chat = pushChatResolve()
      if (!chat) return
      // R1610：只编辑**被 promote 的那个调用**的卡（精确 key），不再扫描 protoMap。
      // 实证背景：①扫描+「第一个新鲜 running 卡」启发式会把提示追加到错误的历史卡
      // （12:57:44 事件：被 promote 的是 call_df3a407…，提示却落到 12:56:38 的 call_39205af 卡 msg=14220）；
      // ②protoMap 累积了数百条 runningAt>0 的历史卡，一次扫卡打出 470 行 warn 日志洪泛。
      // 钩子现在由 bg-watch 携带 evId（watch key 第三段，v2 为 call_XXX、TUI 为 call_function_XXX），
      // 与桥推卡用的 :input 键同名 → 精确命中；找不到就干净跳过，绝不猜测改别的卡。
      if (!callID) {
        await log("info", `shell promoted hint: no callID provided (sid=${String(sid).slice(0, 12)}) skip`)
        return
      }
      const exactKey = `${sid}:tool:${callID}:input`
      const rec = protoMap.get(exactKey)
      if (!rec || Number(rec?.runningAt ?? 0) <= 0) {
        await log("info", `shell promoted hint: promoted tool card not found (sid=${String(sid).slice(0, 12)}, key=${sanitizeLog(exactKey).slice(0, 70)}) skip`)
        return
      }
      // 兜底新鲜度（正常情况被 promote 的卡必为本进程数秒内所推；防御跨代残留同名卡）
      if (!isFreshRunningCard(rec, Date.now(), PROMOTED_HINT_FRESH_MS)) {
        await log("warn", `shell promoted hint: promoted card stale (key=${sanitizeLog(exactKey).slice(0, 70)}) skip`)
        return
      }
      const msgId = rec.id
      if (!(msgId > 0)) {
        await log("warn", `shell promoted hint: card has no msg id (key=${sanitizeLog(exactKey).slice(0, 60)})`)
        return
      }
      const base = rec.text ?? ""
      // 去重：已带 ⏫ / 「已转入后台」就不再追加（promote 可能多次触发），
      // 文案与追加逻辑在纯函数模块（bg-hint.ts，可单测）
      if (hasShellBgHint(base)) {
        await log("info", `shell promoted hint: already hinted (key=${sanitizeLog(exactKey).slice(0, 60)}) skip`)
        return
      }
      const newText = appendShellBgHint(base)
      if (newText === base) return
      const r = await editTextRaw(chat, msgId, newText, undefined, rec.fallback === true)
      if (r.r === "sent") {
        protoMap.set(exactKey, { ...rec, text: newText })
        savePersistedState()
        await log("info", `shell promoted hint appended (key=${sanitizeLog(exactKey).slice(0, 60)}) msg=${msgId}`)
      } else if (r.r === "retry") {
        await log("warn", `shell promoted hint retry needed (key=${sanitizeLog(exactKey).slice(0, 60)})`)
      }
    } catch (err) {
      await log("warn", `shell promoted hint failed: ${sanitizeLog(String(err)).slice(0, 120)}`)
    }
  }

  // 注册到全局钩子：同进程多 bot 实例各自注册（每个实例只改自己 protoMap 里的卡）。
  // 旧 generation 的闭包经 GEN_KEY 检查不再触网；上限防热重载无限累积。
  {
    const G = globalThis as any
    const key = "__oc_bg_promoted_hooks__"
    const arr = Array.isArray(G[key]) ? G[key] : (G[key] = [])
    arr.push({ fn: noteShellPromoted })
    if (arr.length > 16) arr.splice(0, arr.length - 16)
  }

  const fenceSafe = (s: string): string => String(s ?? "").replace(/```/g, "'''")
  const partTime = (p: any): number => {
    const t = Number(p?.time?.created ?? p?.info?.time?.created ?? 0)
    return Number.isFinite(t) && t > 0 ? t : 0
  }
  const ptitle = (base: string, p: any, m?: any, sid = ""): string => {
    const ts = partTime(p) || partTime(m)
    const s = ts ? fmtClock(ts) : ""
    return `${base}${s ? ` · ${s}` : ""}${ctxSuffix(sid)}`
  }
  const protoBlock = (title: string, body: string): string => renderProtoBlock(title, body)

  const pushQuestionCard = async (sessionID: string, chatID: string, callID: string, st: any): Promise<void> => {
    const qs = (st?.input as any)?.questions
    if (!Array.isArray(qs) || qs.length === 0) return
    const nm = clean(sessionNameOf(sessionID) || sessionID.slice(0, 12), 30)
    const lines: string[] = [`<b>❓ 询问</b> · ${htmlEsc(nm)}`]
    const kb: unknown[][] = []
    for (const q of qs) {
      const qq = String(q?.question ?? "").trim()
      if (qq) lines.push(`\n${htmlEsc(qq)}`)
      const opts = Array.isArray(q?.options) ? q.options : []
      const flatOpts: unknown[] = []
      opts.forEach((o: any, i: number) => {
        const label = String(o?.label ?? "").trim()
        if (!label) return
        const desc = String(o?.description ?? "").trim()
        lines.push(`${i + 1}. ${htmlEsc(label)}${desc ? ` — ${htmlEsc(desc)}` : ""}`)
        if (flatOpts.length < 6) flatOpts.push({ text: `${i + 1}. ${label.slice(0, 20)}`, callback_data: makeQ(sessionID, label) })
      })
      for (let r = 0; r < flatOpts.length; r += 2) kb.push(flatOpts.slice(r, r + 2))
    }
    lines.push(`\n直接回复序号或内容即可（手机可直接回）；也可点「✏️ 自己写答案」后直接发文字。`)
    lines.push(
      `<i>注意：本宿主没有"回答询问"的接口 —— 按钮与文字都只能作为**新消息**发进会话，` +
        `不一定结束这次询问。要真正结束它，请在 TUI 里回答，或点「⏹ 停止」中断该回合。</i>`,
    )
    // 「✏️ 自己写答案」：本宿主无法真正"回答询问"，所以这个按钮**不假装能结束**，
    // 只明确告诉用户接下来怎么做（直接发文字）。用户反馈"没有输入自己答案的选项"。
    const freeKey = { text: "✏️ 自己写答案", callback_data: `qfree:${sessionID}` }
    // 中断出口要说清作用：这个宿主**没有"回答询问"接口**，唯一能结束这次询问的
    // 办法就是中断当前回合（用户反馈"点按钮只是注入，不能结束问题对会话的占用"）。
    const stopKey = { text: "⏹ 中断并释放会话", callback_data: `stop:a:${sessionID}` }
    // ⚠️ 每一行都必须是数组。写成 [stopKey, freeKey, ...kb]（元素是对象）会被预检判成
    // "第 1 行不是数组"，整张卡**退回纯文本、按钮全丢** —— 这正是用户看到"没有选项"的原因。
    const qkb: unknown[][] | undefined = kb.length > 0
      ? haltedSet.has(sessionID)
        ? [[freeKey], ...kb]
        : [[stopKey], [freeKey], ...kb]
      : (haltedSet.has(sessionID) ? undefined : [[{ text: "⏹ 停止", callback_data: `stop:a:${sessionID}` }]])
    const body = lines.join("\n")
    // ① key 必须随问题内容变化：key 固定时，第二次提问会变成对上一张卡片的**编辑**，
    //    Telegram 编辑不产生通知 → 手机上完全看不到 → 会话卡死等回答。
    // ② 主 Bot 限流时这张卡会走备用 Bot，而备用 Bot 会剥掉 reply_markup（无按钮），
    //    所以提前把“无按钮、直接回复序号/文字”写进正文。
    const degraded = Date.now() < floodGate.floodUntil || Date.now() < floodGate.fallbackUntil
    const keyId = callID || hashText(body).slice(0, 10)
    const finalBody = degraded
      ? `${body}\n\n⚠️ 主 Bot 正在限流，本卡由备用 Bot 代发（无按钮）：直接回复序号或文字即可回答。`
      : body
    await protoSend(`${sessionID}:ask:${keyId}`, chatID, finalBody, true, false, "", qkb)
  }

  const sessionTag = (sid: string): string => clean(sessionNameOf(sid) || sid.slice(0, 12), 28)
  /**
   * R1054：本实例**负责过**的会话集合。
   * 为什么需要：front 的认领条件是 `!fixedTarget || fixedTarget === msgSid || !frontSessionID`，
   * 未钉选时 `!fixedTarget` **单独就成立** → **全局事件流里任何一个会话的 user 消息**
   * 都能抢走本 bot 的 front。而 `ctx.session` 的事件是**广播给所有桥实例**的，
   * 于是两个 bot 互抢 front → 各自把对方的会话推进自己的聊天（实测串台 126 次/窗口）。
   * 判据选在 `protoPushAssistantMessage` 入口记录：那是"本 bot 真的要投递这个会话"的时刻，
   * 与 `shouldPush()` 的既有责任判定**同源**，不引入第二套语义。
   */
  const ownSessions = new Set<string>()
  const noteOwnSession = (sid: string): void => {
    // R1856：真 LRU（重复投递会刷新位置），见 touchOwnSession。
    touchOwnSession(ownSessions, sid, 24)
  }

  /**
   * 压缩摘要专用卡片：标题是「🗜 会话压缩」，不是「💬 回复」。
   * 只在 /compaction 或显式 /replay 时调用；自动路径只发压缩通知，不推摘要。
   */
  const pushCompactionCard = async (sessionID: string, chatID: string, m: any, force = false): Promise<void> => {
    const info = m?.info ?? m
    const cards = compactionCards({
      status: String(info?.compactionStatus ?? info?.status ?? "unknown"),
      reason: String(info?.compactionReason ?? info?.reason ?? ""),
      error: String(info?.compactionError ?? ""),
      summary: String(info?.compactionSummary ?? (typeof info?.summary === "string" ? info.summary : "")),
    })
    const msgKey = String(info?.id ?? m?.id ?? "c").slice(0, 20)
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]!
      const title = ptitle(card.title, m, m, sessionID)
      const body = fenceSafe(mdTableToHtml(mdBoldToHtml(card.body)))
      await protoSend(`${sessionID}:compaction:${msgKey}:${i}`, chatID, protoBlock(title, body), true, undefined, undefined, undefined, force)
    }
  }

  // R2739：aborted 也可能来自宿主 managed-service 重启（13:59 实测连续三次）。
  // 这类回合的错误卡应显示「服务重启，已自动恢复」，而不是「生成失败」。
  // 只在 aborted 错误上调用（很少），读一次会话尾部；失败按“不是重启”处理。
  const sessionRestartNoticeNear = async (sessionID: string, at: number): Promise<boolean> => {
    try {
      const res = await client.session.messages({ path: { id: sessionID } })
      return restartNoticeNear((res as any)?.data ?? [], at)
    } catch {
      return false
    }
  }

  const protoPushAssistantMessage = async (sessionID: string, chatID: string, m: any, force = false, mode: 'full' | 'text' = 'full', backfill = false): Promise<void> => {
    noteOwnSession(sessionID)   // R1054：走到这里 = 本 bot 真的要投递这个会话
    // v2 语义：压缩不是 assistant 消息。调用方可能把压缩行混进消息列表（/replay、
    // /compaction），这里统一改走专用卡片，绝不生成「💬 回复」。
    if (isCompactionMessage(m)) {
      await pushCompactionCard(sessionID, chatID, m, force)
      return
    }
    const msgKey = String(m?.id ?? m?.info?.id ?? "m").slice(0, 20)
    // R276：补推（catchup 补扫 R1827）的时间-顺序一致性修复。catchup 最多在消息完成后
    // ~25s 才补推，期间事件路径可能已把**更新的**卡片推到前面；补推卡若仍标注旧事件时刻，
    // 用户就看到「签署时间与发送顺序不相符」（运营者实报）。判据：本实例已有更晚的发送
    // （lastProtoSendAt > 本消息完成时刻）⇒ 聊天流时钟会倒挂。此时标题时钟改用**本次补推
    // 时刻**、并把原时刻放进「补发 …」括注：时钟随发送顺序单调，且读者知道这是补发而非实时。
    const doneAt = Number(m?.time?.completed ?? m?.info?.time?.completed ?? m?.time?.created ?? m?.info?.time?.created ?? 0)
    const backfillLate = backfill && doneAt > 0 && lastProtoSendAt > doneAt
    const backfillClock = backfillLate ? fmtClock(Date.now()) : ""
    // R-2026-10-19：迟到时长（毫秒）。≥ LATE_NOTE_MIN_MS 才显示「（补发 …）」括注；以下仍改写时钟。
    const lateMs = backfillLate ? Date.now() - doneAt : 0
    const lateNote = lateMs >= LATE_NOTE_MIN_MS
    // 验证锚点（R276）：触发「补发时刻」改写时留一行日志，下一代可直接 grep 'backfill-late'
    // 核对（无此行则"已修复"与"没触发过"完全同形，无法验证）。
    if (backfillLate) void log("info", `backfill-late (${sanitizeLog(sessionID).slice(0, 12)} msg=${msgKey} 补=${backfillClock} 原=${fmtClock(doneAt)} late=${Math.round(lateMs / 1000)}s${lateNote ? " note" : ""})`)
    const lateTitle = (base: string, p: any): string =>
      lateNote
        ? `${base} · ${backfillClock}（补发 ${fmtClock(partTime(p) || doneAt)}）${ctxSuffix(sessionID)}`
        : `${base} · ${backfillClock}${ctxSuffix(sessionID)}`
    // 附加镜像档：标题前加会话名，避免多会话正文混淆。
    const tag = mode === 'text' ? `📌 ${sessionTag(sessionID)}` : ''
    let idx = 0
    for (const p of partsOf(m)) {
      const t = p?.type
      const pIdx = idx++
      if (t === "reasoning") {
        if (mode !== 'full') continue
        const txt = String(p.text ?? "").trim()
        const fm = filt("think")
        if (txt && !isInternalLog(txt) && fm > 0) {
          const body = fm === 1 ? "" : fenceSafe(txt)
          const tTitle = backfillLate ? lateTitle("🧠 思考", p) : ptitle("🧠 思考", p, m, sessionID)
          await protoSend(`${sessionID}:thinking:${msgKey}:${pIdx}`, chatID, protoBlock(tTitle, body), true, undefined, undefined, undefined, force)
        }
      } else if (t === "text") {
        const txt = String(p.text ?? "").trim()
        const rm0 = filt("reply")
        if (txt && !isInternalLog(txt) && rm0 > 0) {
          const rnd = extractRound(txt)
          if (rnd) {
            lastRound.set(sessionID, rnd)
            savePersistedState()
          }
          const rbody = rm0 === 1 ? "" : fenceSafe(mdTableToHtml(mdBoldToHtml(txt)))
          const base = tag ? `${tag} · 💬 回复` : "💬 回复"
          const mTitle = backfillLate ? lateTitle(base, p) : ptitle(base, p, m, sessionID)
          await protoSend(`${sessionID}:message:${msgKey}:${pIdx}`, chatID, protoBlock(mTitle, rbody), true, undefined, undefined, undefined, force)
        }
      } else if (t === "tool") {
        const st = p?.state ?? {}
        const status = String(st.status ?? "?")
        const callID = callOf(p)
        const toolName = clean(p?.tool ?? "tool", 40)
        if (toolName === "question") {
          // 询问卡片任何档位都必须送达（agent 点名要人）
          await pushQuestionCard(sessionID, chatID, callID, st)
          continue
        }
        if (mode !== 'full') continue
        const title = st.title ? clean(String(st.title), 80) : ""
        const TOOL_OUT_FULL = 30000
        const TOOL_PREVIEW_LINES = 15
        const TOOL_PREVIEW_CHARS = 800
        const DIV = "━━━━━━━━━━━━━━━"
        const dispName = toolName.charAt(0).toUpperCase() + toolName.slice(1)
        const isShell = toolName === "shell" || toolName === "bash"
        const toolClock = fmtClock(partTime(p) || partTime(m)) || fmtClock(Date.now())
        // 标注为「开始」：这个时刻是工具 part 的创建时刻，长命令下与 Telegram 显示的
        // 发送时刻会差几分钟（用户报"标记时间与实际发送时间相差3分钟"）。不标注就像错位。
        const header = `<b>🔧 ${htmlEsc(dispName)} 执行 · 开始 ${toolClock}${htmlEsc(ctxSuffix(sessionID))}</b>`
        const codeBlock = (lang: string, code: string): string =>
          `<blockquote><pre><code${lang ? ` class="language-${lang}"` : ""}>${htmlEsc(code)}</code></pre></blockquote>`
        const foldPreview = (text: string): { preview: string; folded: boolean; more: string } => {
          const ls = text.split("\n")
          if (ls.length > TOOL_PREVIEW_LINES) {
            return { preview: ls.slice(0, TOOL_PREVIEW_LINES).join("\n"), folded: true, more: `其余 ${ls.length - TOOL_PREVIEW_LINES} 行` }
          }
          if (text.length > TOOL_PREVIEW_CHARS) {
            let cut = text.slice(0, TOOL_PREVIEW_CHARS)
            const nl = cut.lastIndexOf("\n")
            if (nl > TOOL_PREVIEW_CHARS * 0.5) cut = cut.slice(0, nl)
            return { preview: cut, folded: true, more: `其余约 ${text.length - cut.length} 字` }
          }
          return { preview: text, folded: false, more: "" }
        }
        const errStr = st.error != null && String(st.error) !== "" ? String(st.error) : ""
        let tailExit: number | null = null
        const statusLine = (): string => {
          const exit = st.metadata?.exit ?? tailExit
          const exitS = exit != null ? ` (exit ${exit})` : ""
          return toolStatusLabel(status, exit)
        }
        const editInfo = toolName === "edit" ? parseEditInput(st.input ?? st.input_text ?? st.arguments ?? st.args) : null
        const editRendered = editInfo ? editDiff(editInfo.oldS, editInfo.newS) : null
        const editFl = editInfo ? editDiff(editInfo.oldS, editInfo.newS, 100000) : null
        const inputZone = (full: boolean): { html: string; folded: boolean } => {
          if (editRendered && editInfo) {
            const er = full && editFl ? editFl : editRendered
            const fileLine = `file: ${clean(editInfo.path || title, 80) || "(unknown)"} (+${er.plus} −${er.minus})`
            // 要点只在 diff 被截断时保留：短 diff 全文可见，再贴摘要就是重复
            const keyLines = !full && editRendered.omitted > 0 && er.key.length > 0 ? `\n${er.key.join("\n")}` : ""
            const quote = `<blockquote>${htmlEsc(fileLine + keyLines)}</blockquote>`
            return { html: `${quote}\n📥 变更\n${codeBlock("diff", er.text)}`, folded: !full && editRendered.omitted > 0 }
          }
          const raw = st.input ?? st.input_text ?? st.arguments ?? st.args
          if (raw == null || (typeof raw === "string" && raw.trim() === "")) return { html: "", folded: false }
          let text = ""
          let lang = ""
          if (isShell) {
            if (typeof raw === "string") { text = raw; lang = "bash" }
            else if (typeof raw === "object") {
              const c = (raw as any).command ?? (raw as any).cmd
              if (typeof c === "string") { text = c; lang = "bash" }
            }
          }
          if (!text) {
            text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)
            lang = typeof raw === "object" ? "json" : ""
          }
          const label = isShell ? "📥 命令" : "📥 参数"
          if (full) return { html: `${label}\n${codeBlock(lang, text.slice(0, TOOL_OUT_FULL))}`, folded: false }
          const f = foldPreview(text)
          return { html: `${label}\n${codeBlock(lang, f.preview)}`, folded: f.folded }
        }
        const outputZone = (full: boolean): { html: string; folded: boolean; hasOutput: boolean } => {
          const o = st.output
          let jan = o == null || o === "" ? "" : typeof o === "string" ? o : JSON.stringify(o, null, 2)
          if (isShell) {
            const se = stripExitTail(jan)
            jan = se.text
            if (se.exit != null) tailExit = se.exit
          }
          if (jan.trim() === "") {
            if (errStr) return { html: `📤 输出\n${codeBlock("", errStr.slice(0, 800))}`, folded: false, hasOutput: false }
            return { html: "(no output)", folded: false, hasOutput: false }
          }
          const lang = detectOutLang(toolName, jan)
          if (full) return { html: `📤 输出\n${codeBlock(lang, jan.slice(0, TOOL_OUT_FULL))}`, folded: false, hasOutput: true }
          const f = foldPreview(jan)
          let preview = f.preview
          let folded = f.folded
          const sl = stripInternalLogs(preview)
          if (sl.stripped > 0) {
            preview = sl.text
            folded = true
          }
          return { html: `📤 输出\n${codeBlock(lang, preview)}`, folded, hasOutput: true }
        }
        const mkInput = (): { main: string; fullMain: string; folded: boolean } => {
          const pv = inputZone(false)
          const main = `${header}\n\n${pv.html}\n\n<blockquote>⏳ 执行中…</blockquote>`
          if (!pv.folded) return { main, fullMain: main, folded: false }
          const fl = inputZone(true)
          return { main, fullMain: `${header}\n\n${fl.html}\n\n<blockquote>⏳ 执行中…</blockquote>`, folded: true }
        }
        const mkCombined = (): { main: string; fullMain: string; folded: boolean } => {
          const pvIn = inputZone(false)
          const out = outputZone(false)
          const errQ = errStr && out.hasOutput ? `\n<blockquote>${htmlEsc(clean(errStr, 200))}</blockquote>` : ""
          const body = [pvIn.html, out.html, errQ].filter(Boolean).join("\n\n")
          const main = `${header}\n\n${body}\n\n${DIV}\n${statusLine()}`
          const folded = pvIn.folded || out.folded
          if (!folded) return { main, fullMain: main, folded: false }
          const flIn = inputZone(true)
          const flOut = outputZone(true)
          const fullBody = [flIn.html, flOut.html, errQ].filter(Boolean).join("\n\n")
          return { main, fullMain: `${header}\n\n${fullBody}\n\n${DIV}\n${statusLine()}`, folded: true }
        }
        if (status === "running" || status === "pending") {
          // 记住"进入 running 的时刻"（落盘）：看门狗与重启对账都靠它
          {
            const rk = `${sessionID}:tool:${callID}:input`
            const prev = protoMap.get(rk)
            if (prev) protoMap.set(rk, { ...prev, runningAt: prev.runningAt ?? Date.now() })
          }
          // 登记进入 running 的时刻：宿主若再也不发事件，看门狗会把"执行中"改成
          // "状态未知"，避免手机上永远显示进行中。
          const tm = filt("tool")
          if (tm > 0) {
            const ri = mkInput()
            const body = tm === 1 ? header : ri.main
            const full = tm === 1 ? header : ri.fullMain
            await protoSend(`${sessionID}:tool:${callID}:input`, chatID, body, true, tm === 2 && ri.folded, full, undefined, force)
            // **只在真的推送成功后才登记**：protoSend 不返回 id，从它写入 protoMap 的
            // 记录里回读。此前登记发生在 `if (tm > 0)` 之前，被过滤掉的工具（tm=0）
            // 也会被看门狗跟踪 → 没有任何卡片可改写，只能反复记"unrepairable"噪声。
            {
              const inKeyR = `${sessionID}:tool:${callID}:input`
              const sentIn = protoMap.get(inKeyR)
              if (sentIn && sentIn.id > 0) {
                staleCardIdx.set(`${sessionID}:tool:${callID}`, {
                  id: sentIn.id,
                  fallback: sentIn.fallback === true,
                  born: Date.now(),
                })
                staleToolBorn.set(inKeyR, Date.now())
                // ⚠️ runningAt 必须**落盘**，而且**首次** running 事件也要写。
                // 上面那段 `if (prev)` 只在 key 已存在时写 runningAt，而首次事件时 key 还不存在
                // → runningAt 恒为 0 → 落盘记录里没有它 → 桥一热重载，内存跟踪集合清空，
                // 重启恢复路径 `if (!rec.runningAt) continue` 直接跳过 → 卡片**永久**停在
                // "执行中"（用户引用了 15:19:08 那张；当时 07:19:47 恰好有一次热重载）。
                if (!sentIn.runningAt) protoMap.set(inKeyR, { ...sentIn, runningAt: Date.now() })
                const dropped = capStaleCardIdx()
                if (dropped > 0) await log("info", `stale card index over cap (${STALE_CARD_IDX_MAX}); dropped ${dropped} oldest`)
                // 立刻落盘：否则本次登记的恢复信息在下次重启前只存在于内存
                savePersistedState()
              }
            }
          }
        } else if (status === "completed" || status === "error") {
          staleToolBorn.delete(`${sessionID}:tool:${callID}:input`)
          staleCardIdx.delete(`${sessionID}:tool:${callID}`)
          {
            const rk2 = `${sessionID}:tool:${callID}:input`
            const prev2 = protoMap.get(rk2)
            if (prev2 && prev2.runningAt) protoMap.set(rk2, { ...prev2, runningAt: 0 })
          }
          const tm = filt("tool")
          if (tm > 0) {
            const inKey = `${sessionID}:tool:${callID}:input`
            const outKey = `${sessionID}:tool:${callID}`
            const prevIn = protoMap.get(inKey)
            if (prevIn) {
              protoMap.delete(inKey)
              if (!protoMap.has(outKey)) protoMap.set(outKey, { id: prevIn.id, text: "" })
            }
            const { main, fullMain, folded } = mkCombined()
            const useHeadline = tm === 1
            const outBody = useHeadline ? header : main
            const outFull = useHeadline ? header : fullMain
            await protoSend(outKey, chatID, outBody, true, !useHeadline && folded, outFull, undefined, force)
            protoMap.delete(`${outKey}:cont`)
          }
        }
      } else if (t === "step-finish" || t === "step_finish") {
        const sm = filt("status")
        if (sm === 0) continue
        const reason = String(p?.state?.reason ?? p?.reason ?? "completed")
        const stepN = String(p?.state?.step ?? p?.step ?? "")
        const toks = p?.state?.tokens ?? p?.tokens
        const cost = p?.state?.cost ?? p?.cost
        const lines = [`reason: ${reason}`]
        const rnd = lastRound.get(sessionID)
        if (rnd) lines.push(`round: ${rnd}`)
        if (stepN && stepN !== "undefined") lines.push(`step: ${stepN}`)
        if (typeof toks === "number") {
          const tin = p?.state?.tin
          const tout = p?.state?.tout
          const trea = p?.state?.trea
          lines.push(typeof tin === "number" && typeof tout === "number" ? `tokens: ${toks} (in ${tin}/out ${tout}/rea ${typeof trea === "number" ? trea : 0})` : `tokens: ${toks}`)
        }
        if (typeof cost === "number") lines.push(`cost: $${cost.toFixed(4)}`)
        lines.push("status: ✅")
        const statusTitle = ptitle("✅ 完成", p, m, sessionID)
        const statusBody = sm === 1 ? "" : lines.join("\n")
        await protoSend(`${sessionID}:status`, chatID, protoBlock(statusTitle, statusBody), true, undefined, undefined, undefined, force)
        await completeBar(sessionID)
      }
    }
    // R2369（用户实报「没有发送报错信息（错误原因）比如说 速率限制」）：
    // assistant 行上的 `error`（provider 限流/配额/传输错误；v2 形状 `{type,message}`）
    // 此前**从不**渲染 —— 本函数只遍历 parts（text/reasoning/tool/step-finish），
    // 而报错回合常常 parts=0（实测 assistant 行 keys 含 error、content 为空）→ 用户零提示。
    // 这里补一张独立报错卡：key 稳定（同一条消息只一张），protoSend 自带去重/改写；
    // 不走任何 filter（用户明确要报错原因），也不被限流脱载（只脱 thinking/tool/status）。
    const mErr = (m as any)?.info?.error ?? (m as any)?.error ?? null
    if (mErr) {
      const eType = typeof mErr === "object" && mErr ? String((mErr as any)?.type ?? "") : ""
      const eMsg = typeof mErr === "string" ? mErr : String((mErr as any)?.message ?? "")
      const eText = (eMsg || (eType ? "" : JSON.stringify(mErr))).slice(0, 900)
      // R942：不再在这里切代理节点（节点级切换不改变源站看到的客户端 IP，额度照样被卡）。
      // 改为在报错卡里**显示本轮出口**——运营者一眼能看出是不是同一个出口在反复失败，
      // 处置是「结束本轮 → relay 起新 run → 新 run 重新挑出口代理」。
      const mAt = Number((m as any)?.info?.time?.completed ?? (m as any)?.time?.completed ?? (m as any)?.info?.time?.created ?? 0)
      // R2739：aborted + 附近有 synthetic restart 通知 = 服务重启，不是生成失败。
      const aborted = /^(aborted|messageabortederror)$/i.test(eType) || /step interrupted/i.test(eMsg)
      const restartCaused = aborted && (await sessionRestartNoticeNear(sessionID, mAt))
      const title = restartCaused ? "🔄 服务重启，已自动恢复" : `❌ 生成失败${eType ? ` · ${eType}` : ""}`
      const body = restartCaused
        ? "宿主服务自检失败后重启，打断了在途回合；已自动续跑。"
        : [eType && !eMsg ? eType : "", eText].filter(Boolean).join("\n") || "(无错误详情)"
      const ep = exitProxySummary()
      // R942：认出 opencode 的免费额度提示，给运营者一条**可执行**的结论
      // （额度按出口 IP 计 ⇒ 换出口 = 换额度），而不是一句干巴巴的"生成失败"。
      const quotaHit = !restartCaused && /free usage limit|usage limit reached|connect a provider|switch models|\b429\b|rate[\s_-]?limit|provider\.quota|\bquota\b/i.test(
        `${eType} ${eText}`,
      )
      // R2520：与 CI 启动通知使用同一个 `exit proxy:` 格式（kind/upstream/local/egress/direct），
      // 不再把本地代理写成“本轮出口”。
      const epLine = restartCaused || ep.includes("none") ? "" : `（${ep}）`
      const quotaLine = quotaHit
        ? "\n↻ 免费额度/限流：本轮结束后由 workflow 起新 run，新 run 重挑出口代理（新出口 IP ⇒ 新额度）"
        : ""
      const body2 = `${body}${epLine}${quotaLine}`
      await protoSend(`${sessionID}:error:${msgKey}`, chatID, protoBlock(ptitle(title, m, m, sessionID), body2), true, undefined, undefined, undefined, force)
    }
  }

  const lastStopNotify = new Map<string, number>()
  const lastRealPush = new Map<string, number>()
  let lastPushAt = ""
  let eventCount = 0
  // R1565：已发过「本轮完成/输出结束」短提示的 (session:msgId)，同一条消息只发一次。
  const turnEndNotified = new Set<string>()
  const fetchTail = async (sessionID: string, n: number): Promise<any[] | null> => {
    try {
      const res = await client.session.messages({ path: { id: sessionID } })
      const arr = res.data ?? []
      if (!Array.isArray(arr) || arr.length === 0) return null
      return arr.slice(-Math.max(1, n))
    } catch {
      return null
    }
  }

  const isPrimaryPush = (sessionID: string): boolean => {
    if (fixedTarget) return sessionID === fixedTarget
    const front = frontSessionID || persistedFront
    if (front) return sessionID === front
    // R1876：front 为空 → 只有主实例兜底。此前 `return true` 让**每个**空 front 的实例都把
    // 全局事件流里的任意会话当作自己的主目标 → 多 Bot 并存时跨 Bot 全量串台/重复
    //（实测会互抢 front 推错聊天）。与 ownsAsk 的"主实例兜底"同源。
    return unownedFrontOwner(QUEUE_CARD_OWNER)
  }
  const isWatched = (sessionID: string): boolean => watchedSessions.has(sessionID)
  // 询问（question）必须**只有一个** Bot 负责。
  // 旧逻辑让询问绕过 shouldPush（`shouldPush(...) || needAsk`），那在"单 Bot + 备用兜底"
  // 时代是对的：备用是"主 Bot 发不出去时的备胎"。现在有两个**都完整可用**的 Bot，
  // 两边各发一张询问卡、各注入一次答案 —— 正是"两个 Bot 都回同一条消息"和
  // "同一条指令触发两次"的共同来源。
  // 规则：自己的目标/镜像会话由自己负责；都不负责时由**主实例**兜底（保证有人问）。
  const ownsAsk = (sessionID: string): boolean =>
    isPrimaryPush(sessionID) || isWatched(sessionID) || QUEUE_CARD_OWNER
  // 切换会话时把旧目标留下来继续镜像（返回展示文案，空串=没加）
  const keepWatched = (prev: string): string => {
    if (!prev || isPrimaryPush(prev) || isWatched(prev)) return ""
    if (watchedSessions.size >= WATCH_MAX) return ""
    watchedSessions.add(prev)
    return `${sessionTag(prev)} (${prev.slice(0, 12)})`
  }
  // 主目标 = 全量镜像（思考/状态/工具/正文）；附加镜像 = 只发最终正文，
  // 标题带会话名。这样多会话同时在跑也不会把 TG 打到 429。
  const pushModeFor = (sessionID: string): 'full' | 'text' => (isPrimaryPush(sessionID) ? 'full' : 'text')
  const shouldPush = (sessionID: string): boolean => isPrimaryPush(sessionID) || isWatched(sessionID)

  const unpinPinnedBar = async (chatID: string, reason: string): Promise<boolean> => {
    const bar = pinnedBar.get(chatID)
    if (!bar) return true
    const r = await tgFetch("unpinChatMessage", { chat_id: Number(chatID) || chatID, message_id: bar.msgID })
    if (!r.ok && r.status !== 400 && r.status !== 403) {
      await log("info", `pinned bar clear deferred (${reason}, chat=${sanitizeLog(chatID)}, status=${r.status ?? "?"})`)
      return false
    }
    pinnedBar.delete(chatID)
    savePersistedState()
    await log("info", `pinned bar cleared (${reason}, chat=${sanitizeLog(chatID)})`)
    return true
  }
  const clearPinnedBars = async (reason: string): Promise<void> => {
    for (const chatID of [...pinnedBar.keys()]) await unpinPinnedBar(chatID, reason)
  }
  // ⏹ 停止的**诚实性守卫**：interrupt 返回成功 ≠ 那一回合真的结束了。
  // 实测（R998，用户报「另一个会话显示在运行却没有输出」）：宿主那一回合卡在等一个 question
  // 的回答；interrupt 调完**没报错**，但回合始终不完成 → opencode 自己的队列里 4 条一直发不出去，
  // 而桥却回报"已中断"。和今天修的 deleteMessage 假成功是同一族错误：**没人验证就报成功**。
  // 探测口径：最后一条 assistant 消息是否已 completed。卡住时它永远没有 completed。
  // 刻意不复用 turnActuallyIdle：它每次判否都会打一行 idle check 日志，用在停止路径上会刷屏。
  const verifyTurnEnded = async (sid: string, budgetMs: number): Promise<boolean> => {
    const deadline = Date.now() + budgetMs
    for (;;) {
      try {
        const res = await client.session.messages({ path: { id: sid } })
        // ⚠️ `rows` 为空有**两种**含义，兼容层把两者混在一起（messages 读失败时
        // catch 后返回 `{ data: [] }`）：会话本来就没有消息 / 这次读失败了。
        // 这里**故意**把空数组判成"回合未结束"（保守）：宁可如实回报"stop 未确认"，
        // 也不能把一次读失败当成"已中断"—— 那又是一次假成功。
        // 参照：泵的空闲判定 turnActuallyIdle 走的是同一套"空 → not idle"的保守口径，
        // 所以兼容层吞错**不会**导致往活着的回合里注入。
        const rows = Array.isArray(res?.data) ? res.data : []
        let lastAssistant: any = null
        for (const m of rows) if (!isCompactionMessage(m) && m?.info?.role === "assistant") lastAssistant = m
        if (lastAssistant?.info?.time?.completed) return true
      } catch {
        // 探测本身失败**绝不能当成功**（否则这里就是新的一条假成功路径）
      }
      if (Date.now() >= deadline) return false
      await new Promise((r) => setTimeout(r, 900))
    }
  }
  const doStop = async (target: string): Promise<string> => {
    // ⚠️ 这里**只中断当前回合**，绝不写全局循环总闸。
    // 旧实现调了 persistLoopStop()，而 loop-ctl.json 是**两个会话共用**的 → 用户在询问卡上
    // 点一次「⏹ 中断并释放会话」想释放那个会话，结果**两个会话的自动循环一起被关掉**
    // （用户报"又不会自动循环了"；总闸 reason=manual stop ses_sanitized03 就是这么来的）。
    // 语义分离：停"一个回合"用中断；停"自动循环"只有 `/loop stop` 一条路。
    await clearPinnedBars(`stop ${target.slice(0, 12)}`)
    if (haltedSet.has(target)) return `[tg-bridge] stopped ${target.slice(0, 12)}（已停止，无运行中回合；自动循环不受影响）`
    const fn = (client as any)?.session?.interrupt
    if (typeof fn !== "function") return "[tg-bridge] stop unavailable (compat too old)"
    try {
      await fn.call((client as any).session, { path: { id: target } })
    } catch (err) {
      return `[tg-bridge] stop failed: ${sanitizeLog(err).slice(0, 200)}`
    }
    // 确认前不报成功。预算 3.6s：回调路径不能卡太久 —— Telegram 的 answerCallbackQuery
    // 约 10s 就过期，卡住的话用户看到的是一个永远转圈的按钮。
    if (!(await verifyTurnEnded(target, 3_600))) {
      // 补一次 interrupt，再后台复查（只记日志，不二次打扰用户）。
      try {
        await fn.call((client as any).session, { path: { id: target } })
      } catch {
        /* 第二次失败由后台复查统一反映 */
      }
      setTimeout(() => {
        // 世代守卫：这个定时器的句柄没保存 → 永远不会被 clear，只能靠守卫让自己哑火。
        // 不加的后果不是浪费唤醒，而是**旧实例在重载后仍往共享日志写一行** `stop recheck …`，
        // 报告一个已经由新实例接管的状态 —— 而这行是我 R998 自己加的，审计才发现（R1006）。
        if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
        void (async () => {
          const ok = await verifyTurnEnded(target, 4_000)
          const sid12 = sanitizeLog(target).slice(0, 12)
          void log(
            "info",
            ok
              ? `stop recheck ended (sid=${sid12}；中断最终生效)`
              : `stop recheck NOT ended (sid=${sid12}；回合仍未完成 → 该会话 opencode 自己的队列不会清空，需在宿主侧按 Esc)`
          )
        })()
      }, 6_000)
      // 刻意**不**写 haltedSet：没停成就不能装作停了，否则 ⏹ 会从卡上消失（L3115-3118
      // 按 halted 决定是否画停止键），用户连再按一次的机会都没有。
      return "[tg-bridge] stop 未确认：已发出中断，但该回合仍未完成（可能在等一个提问的回答）。opencode 自己的队列不会自动清空；请在 opencode 侧按 Esc 中断该回合，或给该会话发一条新消息。"
    }
    haltedSet.add(target)
    noteHaltArm(target) // R2500：重新停机须抹除旧解除条目，否则会被它吃掉
    savePersistedState()
    // R1107：⏹ 成功后该会话进入 halted —— auto-continue 读取 halted 数组后不再驱动该会话。
    // 这是**逐会话**暂停：共享总闸没动，其它会话/Bot 的循环不受影响；用户发新消息
    //（pump 投递成功清除 halted）或 /loop start 可恢复该会话循环。
    return `[tg-bridge] stopped ${target.slice(0, 12)}（已中断该回合，并暂停该会话自动循环；新消息或 /loop start 恢复，其它会话不受影响）`
  }
  const retireBar = async (chatID: string): Promise<void> => {
    await unpinPinnedBar(chatID, "retire")
  }
  const completeBar = async (sessionID: string): Promise<void> => {
    for (const [chatID, bar] of [...pinnedBar.entries()]) {
      if (bar.sid === sessionID) await unpinPinnedBar(chatID, "complete")
    }
  }
  const replyCtxOf = (m: any): string => {
    const r = m?.reply_to_message
    if (!r) return ""
    const t = typeof r.text === "string" ? r.text : typeof r.caption === "string" ? r.caption : ""
    return clean(t, 200)
  }
  // ⚠️ 这里**故意只有**队列泵这一个注入出口。曾经的 `injectText`（直连 doPrompt、
  // allowStopped=true、绕开空闲等待）已删除：它是死代码，却带着"往活着的回合里硬塞"
  // 的能力，而且顺手 haltedSet.delete() → 一次重构就能把 R1000 刚修掉的
  // "AI 没结束就注入"重新引回来。要"立刻注入"的语义请走队列并把 injectMode 设为相应值，
  // 不要新写直注函数。
  const doPrompt = async (target: string, text: string, ctx: string, allowStopped = false): Promise<string> => {
    if (loopStopped() && !allowStopped) return `⏹ 循环已停（本 Bot=${sanitizeLog(BOT_LABEL)} 暂停注入；/loop start 恢复，其它 Bot 不受影响）`
    const startedAt = Date.now()
    const wasAlreadyStopped = loopStopped()
    // R2660：适配层现在真的把 delivery 透传给宿主（以前被丢掉，两者都退化成 steer）。
    // 这里保留用户选择的语义：idle = 确认回合结束后再入队（queue）；now = 立即插入（steer）。
    // 自动循环与 429 续跑则固定 queue（它们不该插进活回合）。
    const delivery: "queue" | "steer" = injectMode === "idle" ? "queue" : "steer"
    try {
      await client.session.promptAsync({
        path: { id: target },
        body: { parts: [{ type: "text", text: `[TG user message]${ctx ? ` (回复引用：${ctx})` : ""} ${text}` }], resume: true, delivery },
      })
      const stopDuringPrompt = loopStopped() && (!wasAlreadyStopped || loopStopTimestamp() > startedAt)
      if (stopDuringPrompt) {
        try {
          await (client.session as any).interrupt?.({ path: { id: target } })
        } catch {
          /* best-effort */
        }
        return "⏹ 循环已停（注入期间收到停止）"
      }
      busyTurn.add(target)
      if (busyTurn.size > 200) {
        const fk = busyTurn.values().next()
        if (!fk.done) busyTurn.delete(fk.value)
      }
    } catch (err) {
      return `注入失败：${sanitizeLog(err).slice(0, 200)}`
    }
    return ""
  }
  // 清除队列置顶条：取消置顶并把那条消息**编辑成「队列已空」后保留复用**，
  // 不再删除 —— 用户要求“队列消息始终只有一个”。只有 Telegram 明确成功/消息已不存在
  // 才认为清理完成；429/网络失败保留 ID，下一轮继续尝试。
  const clearQueuePinCard = async (chat: string, reason: string): Promise<boolean> => {
    const current = queuePin.get(chat)
    const ids = planQueuePinCleanup(current, queuePinHist)
    if (ids.length === 0) return true
    let cleared = true
    for (const id of ids) {
      // ⚠️ 用户反馈"置顶消息越堆越多 / 不会按注入数量清空"。根因就在这个循环里，两条：
      // ① 取消置顶曾被 `queuePinOn.get(chat) && current === id` 卡住 → **历史 id 永远不发 unpin**，
      //    于是每次新队列卡钉上去，旧的那条就一直留在置顶里（`queue pin cleared` 只清了当前那条，
      //    所以日志看起来"清了"，实际在堆积）。
      //    现在对**每个** id 都尝试取消；400/403 按本文件既有约定视为"已不可钉/已取消"。
      const r = await tgFetch("unpinChatMessage", { chat_id: Number(chat) || chat, message_id: id })
      if (!r.ok && r.status !== 400 && r.status !== 403) {
        cleared = false
        continue
      }
      if (current === id) queuePinOn.set(chat, false)
      if (current === id) {
        // R1420：排空/停止时把卡**删除**，不再保留「队列已空（复用）」残留消息。
        // 用户明确反馈：残留卡带着括号注释，误导为「还有 1 条在队列」，且永远躺在聊天里。
        // 删除失败仍按「清理未完成」处置（保留 hist 下轮重试）；400/403 视为已不可见。
        const d = await tgFetch("deleteMessage", { chat_id: Number(chat) || chat, message_id: id })
        if (d.ok || d.status === 400 || d.status === 403) {
          queuePin.delete(chat)
          queuePinOn.delete(chat)
          qpinEmptyShownFor.delete(chat)
        } else {
          cleared = false
          await log("info", `queue pin delete failed (current mid=${id}, status=${d.status ?? "network"}); 保留记录下轮重试`)
        }
      } else {
        // 历史遗留的旧卡（换代前建的）直接删掉，避免又出现第二条队列消息
        const d = await tgFetch("deleteMessage", { chat_id: Number(chat) || chat, message_id: id })
        // ⚠️ 此前**完全不检查** deleteMessage 的结果：删失败也被当作成功 →
        // `cleared` 仍为 true → 那个 id 被移出 queuePinHist → **我们把它忘了，永远不再重试** →
        // 置顶就永久留在聊天里（用户反馈"不会按注入数量清空"的第二条根因）。
        // 现在：400/403 视为"已不可见"（本文件既有约定）；其余失败 → 保留在 queuePinHist 里下轮重试。
        if (!d.ok && d.status !== 400 && d.status !== 403) {
          cleared = false
          await log(
            "info",
            `queue pin delete failed (mid=${id}, status=${d.status ?? "network"}); 保留记录下轮重试`,
          )
        }
      }
    }
    if (!cleared) {
      await log("info", `queue pin clear deferred (${reason}, ids=${ids.length})`)
      return false
    }
    // 只在**确实处理完**时移除历史记录：deleteMessage 失败（网络/限流）时必须保留，
    // 否则下次就找不到这张卡了。400/403 视为"已不可见"（被删或不再归我们）才算完。
    for (let i = queuePinHist.length - 1; i >= 0; i--) {
      const hid = queuePinHist[i]!
      if (current === hid) continue
      if (!ids.includes(hid)) continue
      if (cleared) queuePinHist.splice(i, 1)
    }
    lastQPinCount = 0
    lastQPinText = ""
    lastQPinStatusAt = 0
    savePersistedState()
    await log("info", `queue pin cleared (${reason}, msgs=${ids.length}, deleted)`)
    return true
  }
  // R1420：状态推导（供置顶卡首行展示）。
  // 语义：loopStopped→已取消；否则看 front 会话最后一条 assistant 消息——
  //   info.time.completed 有值=已终态，再查其 part.state.status==="error" 区分“完成/错误”；
  //   无 completed（或读失败/无消息）→ 保守标“进行中”（与 turnActuallyIdle 同口径）。
  const qpinStatusFor = async (sid: string): Promise<string> => {
    if (loopStopped()) return "⏸ 已取消（循环停止）"
    try {
      const res = await client.session.messages({ path: { id: sid } })
      const rows = Array.isArray(res?.data) ? res.data : []
      let lastAssistant: any = null
      for (let i = rows.length - 1; i >= 0; i--) {
        if (isCompactionMessage(rows[i])) continue
        if (rows[i]?.info?.role === "assistant") {
          lastAssistant = rows[i]
          break
        }
      }
      if (!lastAssistant) return "⏳ 进行中"
      if (!(Number(lastAssistant?.info?.time?.completed ?? 0) > 0)) return "⏳ 进行中"
      const parts = partsOf(lastAssistant)
      for (let i = parts.length - 1; i >= 0; i--) {
        const stt = String((parts[i] as any)?.state?.status ?? "")
        if (stt === "error") return "❌ 错误"
        if (stt === "completed") break
      }
      return "✅ 完成"
    } catch {
      return "⏳ 进行中"
    }
  }
  // 队列置顶条：有积压置顶一条显示条数（只改原文不重发），排空即取消置顶并删除
  const refreshQueuePin = async (): Promise<void> => {
    // 队列置顶卡归属策略（R1091 起）：默认只由主 Bot 建/编辑一张卡（旧行为）；
    // 开启 TG_SELF_QUEUE_PIN 后（默认开）各实例自建/自管一张自己的卡 —— Telegram
    // 不允许编辑其它 Bot 发出的消息，但自己的消息完全可以编辑/置顶/清卡。
    // QUEUE_CARD_OWNER 语义不受影响（ownsAsk/scopeOwn 仍以它判主实例）。
    if (!QUEUE_CARD_OWNER && !ALLOW_SELF_QUEUE_PIN) {
    // 非 owner 直接返回是**静默**的 → 日志里看不出"为什么这个 Bot 不建队列置顶"。
    // 队列置顶的归属是每 Bot 配置（注册表 queueCardOwner），必须能从日志确认。
    if (!queueOwnerSkipLogged) {
      queueOwnerSkipLogged = true
      await log(
        "info",
        `queue card owner=false (本实例不建/不编辑队列置顶卡; 由注册表 queueCardOwner=false 指定; 队列置顶卡只由一个 Bot 拥有，否则同一聊天会出现两条并互相 400)`,
      )
    }
    // ⚠️ 非 owner **也必须清理自己历史上钉过的卡**。
    // owner 门的作用是"别让两个 Bot 各建一张卡互相 400"，它该限制的是**建卡/改卡**，
    // 不该连带限制**取消置顶** —— 否则一个"曾经当过 owner、后来失去归属"的 Bot
    // 会把它自己钉的置顶永远留在聊天里（用户反馈"置顶消息越堆越多"；
    // 备用侧的 qpinhist 里就留着一条 8306，而它永远不会去清）。
    // 幂等性：clearQueuePinCard 成功后会清空 queuePinHist → 后续调用直接跳过，不会反复打 API。
    const cleanChat = pushChatResolve()
    if (cleanChat && (queuePinHist.length > 0 || queuePin.get(cleanChat) !== undefined)) {
      await clearQueuePinCard(cleanChat, "not card owner")
    }
    return
  }
    if (qpinBusy) {
      qpinDirty = true
      return
    }
    // 最小间隔：距上次触网不足 QPIN_MIN_INTERVAL_MS 就不碰 Telegram，只记脏稍后再来。
    const sinceWork = Date.now() - qpinLastWorkAt
    if (qpinLastWorkAt > 0 && sinceWork < QPIN_MIN_INTERVAL_MS) {
      qpinDirty = true
      return
    }
    qpinBusy = true
    qpinLastWorkAt = Date.now()
    try {
      // 停止后不再创建/更新队列卡片，但必须把已经存在的卡片清掉；
      // 否则 refreshQueuePin 直接 return 会留下永久置顶。
      if (loopStopped()) {
        const chat = pushChatResolve()
        if (chat) await clearQueuePinCard(chat, "loop stopped")
        return
      }
      // 即使正在限流，已排空的置顶条也必须先清理；否则 stale qpin 会永久残留。
      const preN = pinQueue.length + outQueue.length
      if (preN === 0) {
        const chat = pushChatResolve()
        const cur = chat ? queuePin.get(chat) : undefined
        // 已经**成功**把这张卡写成"队列已空"就不再重复编辑（幂等）。
        // 注意：只有 clearQueuePinCard 真的成功才记录。之前是无条件记录，于是
        // "编辑失败"也被记成"已显示空态" → 那张卡永远停在旧计数（用户报：注入已空、
        // 置顶仍显示三条）。失败就不记，下一拍（≥3s）自动重试。
        if (chat && cur !== undefined && qpinEmptyShownFor.get(chat) === cur) return
        if (chat) {
          const ok = await clearQueuePinCard(chat, "drained")
          if (ok && cur !== undefined) qpinEmptyShownFor.set(chat, cur)
          else if (!ok) await log("info", `queue pin empty-state retry next tick (chat=${sanitizeLog(chat)})`)
        }
        return
      }
      // 限流期间不做置顶条探测；否则每次 save 都会触发一轮无效 Telegram 请求。
      // ⚠️ 用户反馈「不会按照注入的数量清空」。计数更新的另外两条节流分支
    //   （qpinBusy、QPIN_MIN_INTERVAL_MS）都会置 qpinDirty=true 以便重试，
    //   **唯独这里直接 return** → 落在限流窗口里的那次计数更新被静默丢弃、无人重试，
    //   卡上数字就与实际注入数对不上（排空清理那条路在限流判断之前，所以"清空"正常）。
    if (Date.now() < floodGate.floodUntil) {
      qpinDirty = true
      return
    }
      for (;;) {
        qpinDirty = false
        const nPin = pinQueue.length
        const nOut = outQueue.length
        const n = nPin + nOut
        const chat = pushChatResolve()
        if (!chat) return
        const mid = queuePin.get(chat)
        if (n === 0) {
          await clearQueuePinCard(chat, "drained")
          return
        }
        if (mid !== undefined) {
          // 复用上一轮保留的队列消息：重新置顶 + 改回计数文案（始终只有这一条）
          if (!queuePinOn.get(chat)) {
            try {
              await tgFetch("pinChatMessage", { chat_id: Number(chat) || chat, message_id: mid, disable_notification: true })
              queuePinOn.set(chat, true)
              await log("info", `queue pin re-pinned (mid=${mid})`)
            } catch (err) {
              // 置顶失败**不阻塞**计数更新（对），但必须留痕：否则用户在聊天里看不到队列置顶，
              // 而日志里也什么都没有 —— 正是"置顶消息不会清除/不出现"这类反馈最难查的形态。
              // queuePinOn 不置位 → 下一轮会重试，属自愈。
              await log("error", `queue pin FAILED (mid=${mid}): ${sanitizeLog(err).slice(0, 120)} — 下一轮重试`)
            }
          }
          const now = Date.now()
          // R2574（D7）：原先这里按条数去重（n === lastQPinCount → return），队列条数
          // 不变时连状态行都不重算 → 卡上「进行中/完成/错误」永久停在旧值。现在条数
          // 不变也按 TTL 重算状态；是否真正触网编辑交给文案比较 + 5s 节流。
          const countChanged = n !== lastQPinCount
          if (
            !queuePinStatusDue({
              count: n,
              lastCount: lastQPinCount,
              now,
              lastStatusAt: lastQPinStatusAt,
              ttlMs: QPIN_STATUS_TTL_MS,
            })
          )
            return
          const statusLine = await qpinStatusFor((fixedTarget ?? frontSessionID ?? persistedFront) ?? "")
          const nextText = queuePinCardText(statusLine, nPin, nOut)
          const decision = queuePinEditDecision({
            text: nextText,
            lastText: lastQPinText,
            now,
            lastEditAt: lastQPinEdit,
            minEditMs: 5000,
          })
          if (decision === "skip") {
            // 文案一字不差：屏上已是最新，记录状态采样时间即可（避免每拍重复算）。
            lastQPinCount = n
            lastQPinStatusAt = now
            return
          }
          // ⚠️ 与 R988 的限流分支同一类缺陷：节流早退不置 qpinDirty → 更新被丢弃
          // （lastQPinText/lastQPinStatusAt 只在成功时写，故下次刷新能自愈；没有下次刷新
          // 就一直停在旧状态）。defer 必须显式安排下一拍。
          if (decision === "defer") {
            qpinDirty = true
            return
          }
          const r = await editTextRaw(chat, mid, nextText)
          if (r.r === "sent") {
            lastQPinEdit = now
            lastQPinCount = n
            lastQPinStatusAt = now
            lastQPinText = nextText
            // 条数没变却发生了编辑 = 只有状态行变化（进行中→完成/错误）。留一行证据，
            // 否则运营者只能看到卡变了、日志里却查不到是谁在刷新。
            if (!countChanged) {
              await log(
                "info",
                `queue pin status refreshed (mid=${mid}, n=${n}, status=${sanitizeLog(statusLine).slice(0, 24)})`,
              )
            }
          } else {
            const st = (r as { status?: number }).status ?? 0
            const transient = st === 0 || st === 429 || st >= 500
            await log(transient ? "warn" : "error", `queue pin edit failed (mid=${mid}, r=${r.r}, status=${st || "?"})`)
          }
          return
        }
        try {
          const statusLine = await qpinStatusFor((fixedTarget ?? frontSessionID ?? persistedFront) ?? "")
          const text = queuePinCardText(statusLine, nPin, nOut)
          const r = await tgFetch("sendMessage", {
            chat_id: Number(chat) || chat,
            text,
            disable_notification: true,
          })
          if (r.ok && r.id) {
            queuePin.set(chat, r.id)
            queuePinOn.set(chat, true)
            if (!queuePinHist.includes(r.id)) queuePinHist.push(r.id)
            while (queuePinHist.length > 12) queuePinHist.shift()
            lastQPinCount = n
            lastQPinEdit = Date.now()
            lastQPinStatusAt = lastQPinEdit
            lastQPinText = text
            savePersistedState()
            try {
              await tgFetch("pinChatMessage", { chat_id: Number(chat) || chat, message_id: r.id, disable_notification: true })
            } catch {
              /* best-effort */
            }
            await log("info", `queue pin created (n=${n})`)
          } else {
            const st = r.status ?? 0
            const transient = st === 0 || st === 429 || st >= 500
            await log(transient ? "warn" : "error", `queue pin create failed (status=${st || "?"})`)
          }
        } catch {
          /* best-effort */
        }
        if (!qpinDirty) return
      }
    } finally {
      qpinBusy = false
      if (qpinDirty) {
        qpinDirty = false
        // 必须延后到最小间隔之后：立即重跑就是那个 ~450ms 的自激循环。
        setTimeout(() => {
          void refreshQueuePin()
        }, QPIN_MIN_INTERVAL_MS)
      }
    }
  }
  // R2575：环境还原会把 tg-chats-*.json 回滚到 release 快照，但 Telegram 侧的
  // 置顶消息不会跟着回滚 —— 于是出现「聊天里还钉着队列卡，qpin/qpinhist 却为空」。
  // 30s 拍在 queuePin.size===0 时直接 return，永远不会发现这条孤儿卡，卡上条数
  // 就停在旧值（运营者报「隔壁置顶的队列消息怎么没有更新」）。
  // 拿到 poll 所有权后只对**私聊**清理一次：私聊里置顶必然是本 Bot 发的；群聊可能
  // 属于其他 Bot，不能抢。Telegram 只返回最新一条置顶，历史叠卡要删一张再看下一张；
  // 清完后若队列非空，交给 refreshQueuePin 重建一张计数正确的卡。
  const reconcileQueuePinCard = async (): Promise<void> => {
    if (qpinReconciled) return
    const chat = pushChatResolve()
    if (!chat) return
    const now = Date.now()
    if (qpinReconcileAt > 0 && now - qpinReconcileAt < 60_000) return
    qpinReconcileAt = now
    if (!/^\d+$/.test(chat) || Number(chat) <= 0) {
      // 群聊（负 id）或尚未解析成数字的别名：不认领。别名留到下一拍再试。
      if (/^-\d+$/.test(chat)) qpinReconciled = true
      return
    }
    const removed: number[] = []
    let settled = false
    try {
      for (let i = 0; i < 8; i++) {
        const probe = await readPinnedMessage(chat)
        if (!probe.ok) {
          await log("info", `queue pin reconcile probe status=${probe.status ?? 0}; retry in 60s`)
          return
        }
        const mid = probe.mid
        if (!(mid && mid > 0) || !isQueuePinCardText(probe.text)) {
          settled = true
          break
        }
        const u = await tgFetch("unpinChatMessage", { chat_id: Number(chat) || chat, message_id: mid })
        if (!u.ok && u.status !== 400 && u.status !== 403) return
        const d = await tgFetch("deleteMessage", { chat_id: Number(chat) || chat, message_id: mid })
        if (!d.ok && d.status !== 400 && d.status !== 403) return
        removed.push(mid)
      }
      // 只有确认「最新置顶不是队列卡」才算对账完成；删到 8 张上限或中途瞬时失败
      // 都保持未完成，60s 后再继续清剩余的叠卡。
      if (settled) qpinReconciled = true
      if (removed.length === 0) return
      const cur = queuePin.get(chat)
      for (let i = queuePinHist.length - 1; i >= 0; i--) {
        if (removed.includes(queuePinHist[i]!)) queuePinHist.splice(i, 1)
      }
      if (cur !== undefined && removed.includes(cur)) {
        queuePin.delete(chat)
        queuePinOn.delete(chat)
        qpinEmptyShownFor.delete(chat)
      }
      lastQPinCount = 0
      lastQPinText = ""
      lastQPinStatusAt = 0
      savePersistedState()
      await log("info", `queue pin reconciled (removed=${removed.length}, mids=${removed.join(",")}, settled=${settled})`)
      if (pinQueue.length + outQueue.length > 0) void refreshQueuePin()
    } catch (err) {
      await log("info", `queue pin reconcile probe failed: ${sanitizeLog(err).slice(0, 120)}`)
    }
  }
  queuePinRequest = () => {
    void refreshQueuePin()
  }
  // R2574（D7）：置顶队列卡以前只在 save/队列变化时刷新；条数不变时状态行会长期不更新。
  // 30s 拍让「进行中→完成/错误」在不改条数的窗口里也能落到卡上（refreshQueuePin 自带
  // 3s 最小工作间隔 + 5s 编辑节流，不会因此打爆 Telegram）。
  setInterval(() => {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    if (queuePin.size === 0 && pinQueue.length === 0 && outQueue.length === 0) return
    void refreshQueuePin()
  }, QPIN_STATUS_TTL_MS)
  // 置顶注入队列泵：同会话串行，逐条提示；失败停泵队首保留（/flush 重试 /dropq 清掉）
  // 空闲判定的静默期：AI 可能**长时间不输出**，或正处于"两轮输出之间"（上一轮已
  // completed、下一轮还没落盘/还没开始流式）。只看"最后一条 assistant 是否 completed"
  // 会把这个空档判成空闲 → 注入落进正在跑的回合。要求"最近 N 毫秒无新事件"作为兜底。
  const IDLE_SETTLE_MS = 10_000
  const turnActuallyIdle = async (sid: string): Promise<boolean> => {
    try {
      const res = await client.session.messages({ path: { id: sid } })
      const rows = Array.isArray(res?.data) ? res.data : []
      sortRowsByCreatedTime(rows) // R208：序归一化（seq 跨进程重计，行序 ≠ 时序）
      const noIdle = (why: string): boolean => {
        void log("info", `idle check: not idle (${why}, sid=${sanitizeLog(sid).slice(0, 12)})`)
        return false
      }
      // R2232：判据抽到 _v2compat.idleVerdict —— 与 auto-continue 的循环注入共用同一份，
      // 防两侧漂移。这里只补两件本路径特有的事：① 事件静默期入参（lastActivity）；② busyTurn 兜底。
      const iv = idleVerdict({ rows, now: Date.now(), lastEventTs: lastActivity.get(sid) ?? 0, eventSettleMs: IDLE_SETTLE_MS })
      if (iv.idle) {
        busyTurn.delete(sid)
        return true
      }
      // 无助手：空会话按既有口径（无 busy 标记即视为空闲）；有行但无助手 = 回合刚开始，不插。
      if (iv.why === "no-assistant") {
        return rows.length > 0 ? !busyTurn.has(sid) : noIdle("最后一条 assistant 未完成")
      }
      return noIdle(iv.why)
    } catch {
      // 状态查询失败时保持等待，不能为了绕过 API 故障而提前注入。
      return false
    }
  }
  const pumpInject = async (sid: string): Promise<void> => {
    if (pumping.has(sid)) return
    pumping.add(sid)
    try {
      reconcilePinQueue()
      const stoppedAt = loopStopped() ? loopStopTimestamp() : 0
      const firstEligible = pinQueue.findIndex((qq) => qq.sid === sid && (!stoppedAt || qq.ts > stoppedAt))
      if (firstEligible < 0) {
        if (stoppedAt) await log("info", `pinject held: queued before stop (sid=${sanitizeLog(sid).slice(0, 12)})`)
        return
      }
      const chat0 = pinQueue[firstEligible]?.chat ?? ""
      try {
        await tgFetch("sendChatAction", { chat_id: Number(chat0) || chat0, action: "typing" })
      } catch {
        /* best-effort */
      }
      await retireBar(chat0)
      let done = 0
      const sentThisPump = new Set<string>()
      for (;;) {
        const stopAt = loopStopped() ? loopStopTimestamp() : 0
        const idx = pinQueue.findIndex((qq) => qq.sid === sid && (!stopAt || qq.ts > stopAt))
        if (idx < 0) {
          if (stopAt && pinQueue.some((qq) => qq.sid === sid)) {
            await log("info", `pinject stop gate: remaining items predate stop (sid=${sanitizeLog(sid).slice(0, 12)})`)
          }
          break
        }
        // 代际 + owner 双门控：reload churn 期旧实例泵到这里就停，不与新实例重复注入
        if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) {
          await log("info", `pinject gen ${myGen} superseded, pump stops (sid=${sanitizeLog(sid).slice(0, 12)})`)
          break
        }
        if (!amPollOwner(pollInstanceId, "tg")) break
        const item = pinQueue[idx]!
        const left = pinQueue.filter((qq) => qq.sid === sid && (!stopAt || qq.ts > stopAt)).length
        // 完成插入模式只认“回合确实完成”的信号。没有 30 秒无输出兜底，
        // 避免长工具/思考回合尚未结束时把队列内容插进去。
        if (injectMode === "idle") {
          // R1106: busyTurn 是事件流快速信号，但事件流缺失（回合由非事件流路径发起/
          // 上报滞后）时为空 ≠ 空闲 —— 此前 `while (busyTurn.has(sid))` 会跳过等待直接注入，
          // 与 queueAndPump 的提示（busyTurn 空时仍查 turnActuallyIdle 兜底）矛盾：
          // 提示「回合后自动注入」实际却立即注入。busyTurn 空时先用权威判定兜底。
          let shouldIdleWait = busyTurn.has(sid)
          if (!shouldIdleWait) shouldIdleWait = !(await turnActuallyIdle(sid))
          while (shouldIdleWait) {
            if (loopStopped() && item.ts <= loopStopTimestamp()) break
            if (await turnActuallyIdle(sid)) break
            await new Promise((r) => setTimeout(r, IDLE_POLL_MS))
            if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen || !amPollOwner(pollInstanceId, "tg")) break
          }
          if (loopStopped() && item.ts <= loopStopTimestamp()) {
            await log("info", `pinject stop gate: idle wait cancelled (sid=${sanitizeLog(sid).slice(0, 12)})`)
            break
          }
          // 等完复核：等待期间可能已被循环搭便车取走，对账后不在即跳过（防重发）
          reconcilePinQueue()
          const currentIdx = pinQueue.findIndex((qq) => qq === item)
          if (currentIdx < 0) {
            await log("info", `pinject item carried by loop, skip (sid=${sanitizeLog(sid).slice(0, 12)})`)
            continue
          }
          // 同泵内同文跳过（重载恢复＋用户重发造成的孪生条只发一次）
          if (sentThisPump.has(`${item.text} ${item.ctx}`)) {
            pinQueue.splice(currentIdx, 1)
            savePersistedState()
            await log("info", `pinject dup skip in same pump run (sid=${sanitizeLog(sid).slice(0, 12)})`)
            continue
          }
        }
        // 认领/发 prompt 之前**再确认一次所有权**。
        // 此前只在 for(;;) 循环开头查代号与租约，而 doPrompt 之前还有 idle 等待
        // （injectMode=idle 时可等数分钟）—— 期间实例可能已被热重载取代。那样会出现：
        // 已被取代的实例照样发出 prompt（用户看到消息被执行），但它的 savePersistedState
        // 会因 isLiveWriter() 为假而**跳过** → 认领没落盘 → 下一个实例加载后重复注入
        // （实测同一探针被注入 3 次）。这里把校验挪到认领之前，让"认领+发起"对实例所有权原子。
        if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen || !amPollOwner(pollInstanceId, "tg")) {
          await log("info", `pinject abort before prompt (instance superseded or lost lease, sid=${sanitizeLog(sid).slice(0, 12)})`)
          break
        }
        // 先认领再注入：把条目从队列里取出并**立刻落盘**，然后才发起 prompt。
        // 此前是"注入成功后才移除"，于是：注入途中崩溃/实例被换代 → 文件里条目还在
        // → 下一个实例加载后再次注入。实测同一探针被注入 3 次（两个 Bot 各一次 + 换代后又一次）。
        // 语义选择：宁可极端情况下**丢一条**（用户看得到队列少了），也不要**重复注入**
        // （用户看到同一个要求被执行多遍）。
        {
          const claimIdx = pinQueue.findIndex((qq) => qq === item)
          if (claimIdx >= 0) {
            pinQueue.splice(claimIdx, 1)
            pinInFlight.push(item) // 注入期间不在 pinqueue 里 → 崩溃/换代不会被重放
            savePersistedState()
          }
        }
        const beforePromptStop = loopStopped() ? loopStopTimestamp() : 0
        if (beforePromptStop && item.ts <= beforePromptStop) break
        // 快车道静默：即时注入不刷 💉，只在排队等待时提示
        if (Date.now() - item.ts > 3000 || left > 1) {
          await reply(item.chat, `💉 正在注入（${done + 1}/${done + left}）→ ${sid.slice(0, 12)}`)
        }
        const allowStopped = Boolean(beforePromptStop && item.ts > beforePromptStop)
        const err = await doPrompt(sid, item.text, item.ctx, allowStopped)
        if (err) {
          // 失败要**放回队列**（用户可见、可重试），同时清掉 in-flight 标记
          const ifIdx2 = pinInFlight.findIndex((qq) => qq.id === item.id)
          if (ifIdx2 >= 0) pinInFlight.splice(ifIdx2, 1)
          if (!pinQueue.some((qq) => qq.id === item.id)) pinQueue.unshift(item)
          savePersistedState()
          await reply(item.chat, `❌ 注入失败已停下（队首保留，/flush 重试 /dropq 清掉）：${err}`)
          await log("error", `pinject failed sid=${sanitizeLog(sid).slice(0, 12)}: ${sanitizeLog(err).slice(0, 120)}`)
          break
        }
        sentThisPump.add(`${item.text} ${item.ctx}`)
        // 注入成功此前**没有任何日志**（只有给用户的回复），导致"同一条被注入两次"
        // 这类问题在日志里完全看不出来。补一条：会话 / 队列位置 / 长度 / 来源无法得知，
        // 但足以回答"注入了几次、什么时候"。
        await log("info", `pinject delivered (sid=${sanitizeLog(sid).slice(0, 12)}, pos=${pinQueue.filter((qq) => qq.sid === sid).indexOf(item) + 1}, len=${item.text.length})`)
        const removeIdx = pinQueue.findIndex((qq) => qq === item)
        if (removeIdx >= 0) pinQueue.splice(removeIdx, 1)
        const ifIdx = pinInFlight.findIndex((qq) => qq.id === item.id)
        if (ifIdx >= 0) pinInFlight.splice(ifIdx, 1)
        done++
        lastInject.set(sid, item.text)
        if (lastInject.size > 50) {
          const k = lastInject.keys().next().value
          if (k !== undefined) lastInject.delete(k)
        }
        // R2500：无条件登记解除（本 Bot 未必是写入停机的那一个 —— 清了自己的集合也白搭，
        // 真正卡住并集的是别的 Bot 状态文件里的那条）。同时清本地集合与落盘。
        haltedSet.delete(sid)
        noteHaltRelease([sid])
        savePersistedState()
        lastStopNotify.delete(sid)
        lastRealPush.set(sid, Date.now())
        // 用户消息完成后继续自动循环；不再写 120 秒 loopskip 暂停标记。
        savePersistedState()
        // 一次泵只注入一条。多条挤在同一个回合间隙里会互相踩：busyTurn 还没来得及
        // 标记 busy，第二、三条就已经发出去了（用户看到“同时注入多条”）。剩下的
        // 等下一次 idle 事件再泵，保证严格一个回合一条。
        const remain = pinQueue.filter((qq) => qq.sid === sid).length
        if (remain > 0) {
          await reply(chat0, `✅ 已注入 1 条，剩余 ${remain} 条待注入（每个回合间隙一条）`)
        }
        break
      }
      if (done > 1 && !pinQueue.some((qq) => qq.sid === sid)) {
        await reply(chat0, `✅ 注入队列清空（共 ${done} 条 → ${sid.slice(0, 12)}）`)
      }
    } finally {
      pumping.delete(sid)
    }
  }
  const queueAndPump = async (chatID: string, target: string, text: string, ctx: string): Promise<void> => {
    if (pinQueue.length >= PINQ_MAX) {
      await reply(chatID, `📌 注入队列已满（${PINQ_MAX} 条上限，先 /dropq 清掉）`)
      return
    }
    // 连击去重：同会话 10 秒内相同内容不重复入队（手机端双击/弱网重发只进一次）
    const lastPin = [...pinQueue].reverse().find((qq) => qq.sid === target)
    if (lastPin && lastPin.text === text && Date.now() - lastPin.ts < 10_000) {
      await reply(chatID, `📌 相同内容已在队列中，不重复加入 → ${target.slice(0, 12)}`)
      return
    }
    pinQueue.push({ id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, sid: target, text, ctx, chat: chatID, ts: Date.now(), tgMid: Number(currentInbound?.msgID ?? 0) })
    savePersistedState()
    const pos = pinQueue.filter((qq) => qq.sid === target).length
    // 发送前最后判断（②）：水位已超用户阈值 → 提示先压缩，不拦注入
    const cu = ctxUsage.get(target)
    const overTh = cu && windowKnown(cu.modelID, cu.providerID) ? ctxTotal(cu) / windowFor(cu.modelID, cu.providerID) >= compactPrefs.threshold : false
    // 注入时机提示必须说真话：busyTurn 会被 turnActuallyIdle 提前清掉，单看它会把
    // “正在跑”说成“空闲”。这里用与泵同源的判定（读最后一条 assistant 是否 completed）。
    let injectNote = ""
    if (injectMode === "idle") {
      const reallyIdle = busyTurn.has(target) ? false : await turnActuallyIdle(target)
      injectNote = reallyIdle ? "（当前空闲，立即注入）" : "（本轮进行中，结束后注入）"
    } else {
      injectNote = "（立即：不等待回合结束）"
    }
    await reply(chatID, `📌 已加入注入队列 → ${target.slice(0, 12)}（第 ${pos} 位；/queue 查看，/dropq 取消）${overTh ? "（⚠️ ctx 超阈值，建议 /compact）" : ""}${injectNote}`)
    await log("info", `pinject queued sid=${sanitizeLog(target).slice(0, 12)} pos=${pos} len=${text.length}`)
    void pumpInject(target)
  }


  /** 机器人注册表（与 plugins/tg-bridge-v2.ts 的 REGISTRY_PATH 保持一致）。 */
  const BOT_REGISTRY_PATH = `REDACTED_ROOT/.config/opencode/tg-bots.json`
  const BOT_ENV_DIR = `REDACTED_ROOT/.config/opencode`
  const MAX_BOTS = 8
  const TG_TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/

  /** 调 getMe 验 token。**只把 token 发给 Telegram 官方 API**（它本来就属于那里）。 */
  const verifyBotToken = async (token: string): Promise<{ ok: boolean; username?: string; desc?: string }> => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
        method: "GET",
        signal: AbortSignal.timeout(15000),
      })
      const j = (await res.json().catch(() => null)) as any
      if (res.ok && j?.ok) return { ok: true, username: String(j?.result?.username ?? "") }
      return { ok: false, desc: String(j?.description ?? `HTTP ${res.status}`).slice(0, 120) }
    } catch (err) {
      return { ok: false, desc: sanitizeLog(err).slice(0, 120) }
    }
  }

  /** 追加一个 Bot 到注册表（原子写；不改动其它条目）。 */
  const registerBot = (
    id: string,
    label: string,
    newBotToken: string,
    targetChat: string,
  ): { ok: boolean; desc?: string } => {
    let j: any = { bots: [] }
    try {
      const raw = readFileSync(BOT_REGISTRY_PATH, "utf8")
      const parsed = JSON.parse(raw) as any
      if (parsed && Array.isArray(parsed.bots)) j = parsed
    } catch {
      /* 文件不存在 = 还没有 Bot；下面会新建 */
    }
    if (j.bots.length >= MAX_BOTS) return { ok: false, desc: `已达上限 ${MAX_BOTS} 个` }
    if (j.bots.some((b: any) => b?.id === id)) return { ok: false, desc: `id ${id} 已被占用` }

    // env 文件先写：注册表是"索引"，env 才是"内容"；反过来会出现索引指向空文件。
    const envPath = `${BOT_ENV_DIR}/tg-${id}.env`
    const envBody = `TG_BOT_TOKEN=${newBotToken}\nTG_ALLOWED_CHAT=${targetChat}\nTG_PUSH_CHAT=${targetChat}\n`
    try {
      // R1852：凭据文件也要**原子写**（tmp+rename）。旧实现裸 writeFileSync：中途崩溃会留下
      // **半截 token** 的 env → 新 Bot 加载失败，且残片本身是敏感文件。原子写保证加载器
      // 见到的要么是完整旧内容、要么是完整新内容，绝不半截。
      atomicWrite(envPath, envBody, 0o600)
    } catch (err) {
      return { ok: false, desc: `写 env 失败：${sanitizeLog(err).slice(0, 80)}` }
    }

    // ⚠️ `queueCardOwner: false` **必须显式写**（R1048）：判据侧是
    // `b.get("queueCardOwner", True)` —— **缺字段默认 True**。
    // 少写这个字段会让新 Bot 也成为队列置顶卡的 owner，而 Telegram 不允许
    // 跨 Bot 编辑同一条消息 → 同一聊天出现两条队列卡。
    // 这个 bug 由 tests/state-integrity.test.py 的「队列置顶卡只有一个 Bot 拥有」抓到
    //（是我 R1047 的 /addbot 造成的 —— 备用 Bot 的条目里本来就有这个字段，我漏抄了）。
    j.bots.push({ id, label, envFile: envPath, noFallback: true, queueCardOwner: false })
    const tmp = `${BOT_REGISTRY_PATH}.tmp-${process.pid}`
    try {
      writeFileSync(tmp, `${JSON.stringify(j, null, 2)}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
      renameSync(tmp, BOT_REGISTRY_PATH)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        /* best-effort */
      }
      // R1852：注册表写失败 → 回滚刚写的 env，别在磁盘上留一个"登记失败却含真 token"的
      // 孤儿凭据文件（用户以为没登记成功，token 却已落盘）。
      try {
        unlinkSync(envPath)
      } catch {
        /* best-effort */
      }
      return { ok: false, desc: `写注册表失败：${sanitizeLog(err).slice(0, 80)}` }
    }
    return { ok: true }
  }

  /**
   * 触发桥侧重载：追加注释改入口文件 mtime → 宿主重新 import 入口 → 入口按
   * v2lib 源文件 mtime 重新快照并动态 import 新实例（generation gating 接管）。
   *
   * R1906 修正：入口真实路径是 `<config>/opencode/plugins/tg-bridge-v2.ts`
   * （`REDACTED_ROOT/.config/opencode/plugins/…`），此前误写成
   * `REDACTED_ROOT/.opencode/plugins/…`（该目录不存在）→ `/addbot` 的重载
   * 常年静默失败（appendFileSync 抛 ENOENT 被吞成"失败：…"）。
   */
  const triggerBridgeReload = (): string => {
    const entry = `REDACTED_ROOT/.config/opencode/plugins/tg-bridge-v2.ts`
    const note = `\n// addbot reload ${new Date().toISOString()}\n`
    try {
      appendFileSync(entry, note, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
      return entry
    } catch (err) {
      return `失败：${sanitizeLog(err).slice(0, 80)}`
    }
  }

  /**
   * `/addbot <token> [chatId] [标签…]`
   * chatId 省略时用**当前会话**。
   */
  const handleAddBot = async (
    args: string[],
    chatID: string,
    opts?: { deferReload?: boolean },
  ): Promise<void> => {
    const tokenForNewBot = (args[0] ?? "").trim()
    if (!tokenForNewBot) {
      await reply(
        chatID,
        [
          "用法：/addbot &lt;token&gt; [chatId] [标签]",
          "",
          "· token —— BotFather 给的 token（形如 123456:ABC…）",
          "· chatId —— 允许对话的 chat；省略就用当前会话",
          "· 标签 —— 可选，给人看的名字",
          "",
          "例：/addbot 123456:ABC… 123456789 第三个",
          "",
          "⚠️ 登记完还要你**手动把新机器人拉进这个会话**（机器人无法自己加人）。",
          "⚠️ token 请先在 BotFather 用 /revoke 作废旧的再换新的 —— 贴到聊天里的等于泄露。",
        ].join("\n"),
      )
      return
    }
    if (!TG_TOKEN_RE.test(tokenForNewBot)) {
      await reply(
        chatID,
        "❌ token 格式不对。应是 BotFather 给的 数字:字母数字（冒号前 6–12 位数字，冒号后 ≥30 位）。",
      )
      return
    }
    // 一个 token 只能有一个轮询者：重复登记会让两个实例抢 getUpdates（409），
    // 后登记的那个永远收不到消息（2026-10-23 bot4 实况）。先查全部已有 env。
    try {
      for (const f of readdirSync(BOT_ENV_DIR)) {
        if (!/^tg(-bot[a-z0-9_-]+)?\.env$/i.test(f)) continue
        const p = `${BOT_ENV_DIR}/${f}`
        let tok = ""
        try {
          for (const line of readFileSync(p, "utf8").split("\n")) {
            if (line.startsWith("TG_BOT_TOKEN=")) {
              tok = line.slice("TG_BOT_TOKEN=".length).trim()
              break
            }
          }
        } catch {
          continue
        }
        if (tok && tok === tokenForNewBot) {
          await reply(
            chatID,
            `❌ 这个 token 已经被 <code>${htmlEsc(f)}</code> 使用。\n` +
              "同一个 Bot 只能有一个轮询者：再登记会和它抢消息（409），两边都收不全。\n" +
              "请在 BotFather 为**另一个**机器人取 token 后再登记。",
          )
          return
        }
      }
    } catch {
      /* 目录读不到：交给下面正常流程 */
    }
    const targetChat = (args[1] ?? "").trim().replace(/^@/, "") || String(chatID).replace(/^@/, "")
    // R2512：显式标签优先；否则用 getMe 的 @username（运营者要求用户可见名直接用用户名，
    // 不写“批量 n”/时间戳这类内部代号）。username 要验真后才拿到，故默认值在 verify 之后补。
    const explicitLabel = (args.slice(2).join(" ") || "").trim()

    // 验真：失败就不碰注册表（不留僵尸条目）
    const v = await verifyBotToken(tokenForNewBot)
    if (!v.ok) {
      await reply(chatID, `❌ token 无效，Telegram 拒绝：${v.desc ?? "未知错误"}\n（注册表未改动）`)
      return
    }
    const label = explicitLabel || (v.username ? `@${v.username}` : `Bot ${fmtTime(Date.now())}`)

    // 取第一个空闲 id（沿用既有的 primary/alt，从 bot3 起）
    let id = ""
    try {
      const j = JSON.parse(readFileSync(BOT_REGISTRY_PATH, "utf8")) as any
      const used = new Set((Array.isArray(j?.bots) ? j.bots : []).map((b: any) => String(b?.id ?? "")))
      for (let n = 3; n <= MAX_BOTS + 4; n++) {
        if (!used.has(`bot${n}`)) {
          id = `bot${n}`
          break
        }
      }
    } catch {
      id = "bot3"
    }
    if (!id) {
      await reply(chatID, "❌ 找不到可用的 id（bot3… 都 occupied 了）")
      return
    }

    const reg = registerBot(id, label.slice(0, 40), tokenForNewBot, targetChat)
    if (!reg.ok) {
      await reply(chatID, `❌ 登记失败：${reg.desc ?? ""}`)
      return
    }
    // R2539: /addbots registers N bots in one message. Reloading per bot makes the
    // entry re-import N times (generation churn, repeated plugin loads, and N
    // overlapping polls). Batch mode defers and triggers exactly one reload.
    const entry = opts?.deferReload ? "" : triggerBridgeReload()
    // ⚠️ 这一段**不含 token**：回执只给 id / @username / 后续步骤。
    await reply(
      chatID,
      [
        `✅ 已登记 ${id}${v.username ? `（@${v.username}）` : ""}`,
        `· 标签：${label}`,
        `· 允许会话：${targetChat}`,
        `· ${opts?.deferReload ? "批次结束后统一触发桥侧重载" : `已触发桥侧重载：${entry.split("/").pop() ?? entry}`}`,
        "",
        "还差一步（我做不了）：请把这个新机器人拉进目标会话，它才能收到消息。",
        `若 1–2 分钟内没看到它的 plugin loaded (bot=${id}…，说明没起来，把 /info 发我看。`,
      ].join("\n"),
    )
    await log("info", `addbot registered id=${id} username=${v.username ? "@" + v.username : "?"} chat=${sanitizeLog(targetChat).slice(0, 16)} (token 未记录)`)
  }


  /** 循环会话名单（与 auto-continue 的 LOOP_SESSIONS_PATH 一致）。 */
  const LOOP_SESSIONS_FILE = `REDACTED_ROOT/.config/opencode/loop-sessions.json`
  /** 显式关闭的会话（`/loop off`）—— 必须独立于正向名单，见 auto-continue 里的原因。 */
  const LOOP_OFF_FILE = `REDACTED_ROOT/.config/opencode/loop-sessions-off.json`

  const readIdList = (path: string): string[] => {
    try {
      const arr = JSON.parse(readFileSync(path, "utf8"))
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string" && x.startsWith("ses_")) : []
    } catch {
      return []
    }
  }
  const writeIdList = (path: string, ids: string[]): string => {
    const tmp = `${path}.tmp-${process.pid}`
    try {
      writeFileSync(tmp, JSON.stringify([...new Set(ids)].slice(-16)), { encoding: "utf8", mode: PRIVATE_FILE_MODE })
      renameSync(tmp, path)
      return ""
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        /* best-effort */
      }
      return sanitizeLog(err).slice(0, 80)
    }
  }

  /**
   * R2671：本会话的自动循环是否真的会继续。
   *
   * `loopStopped()` 只读 loop-ctl（全局/单 Bot 闸）；`/loop off` 写在独立的
   * loop-sessions-off.json（会话级否定清单），auto-continue 以它为准。R2672 起
   * note 不再等观察窗，本判据只决定文案/按钮（自动继续 vs 直接询问）。
   * 每次现读，`/loop off` 立即生效。
   */
  const sessionLoopActive = (sessionID: string): boolean =>
    turnEndLoopActive({
      gateStopped: loopStopped(),
      sessionLoopOff: readIdList(LOOP_OFF_FILE).includes(sessionID),
      // ⏹ 按过 /stop 的会话由 auto-continue 的 halted 名单拦住；note 要如实询问
      // 是否恢复，按「继续循环」会同时清 halted（见 resumeSessionLoop）。
      sessionHalted: haltedSet.has(sessionID),
    })

  /**
   * R2678：本会话是否登记为自动循环目标。
   *
   * `sessionLoopActive` 只回答「会不会被闸/off/halt 拦住」，不检查正向名单；
   * 状态卡必须用这个函数，否则 Bot 前台会话未登记（loop=no）时仍显示
   * 「▶ 循环运行中」，与 auto-continue 的 `loop=no -> skip` 日志矛盾。
   */
  const sessionLoopRegistered = (sessionID: string): boolean =>
    readIdList(LOOP_SESSIONS_FILE).includes(sessionID) && !readIdList(LOOP_OFF_FILE).includes(sessionID)

  /**
   * 写会话级循环名单（R2672 从 handleLoopScope 抽出，命令与 note 按钮共用）。
   *
   * 返回非空 = 写入失败原因。on 时把 target 从否定名单移除并加入正向名单；
   * off 时反过来。两边都保留"最后写入的 16 条"（与 auto-continue 的 cap 一致）。
   */
  const writeLoopScope = (target: string, on: boolean): string => {
    const list = readIdList(LOOP_SESSIONS_FILE)
    const off = readIdList(LOOP_OFF_FILE)
    if (on) {
      const e1 = writeIdList(LOOP_OFF_FILE, off.filter((x) => x !== target))
      const e2 = writeIdList(LOOP_SESSIONS_FILE, [...list.filter((x) => x !== target), target])
      return e1 || e2
    }
    const e1 = writeIdList(LOOP_OFF_FILE, [...off.filter((x) => x !== target), target])
    const e2 = writeIdList(LOOP_SESSIONS_FILE, list.filter((x) => x !== target))
    return e1 || e2
  }

  /**
   * R2672：note 的「🔁 继续循环」= 真正的会话级恢复。
   *
   * 与 `/loop on` 的区别：`/loop on` 只写会话名单，**不清 Bot 闸** —— 如果循环是
   * 被 `/loop stop` / 守卫 / AI 软闸停的，光写名单 auto-continue 仍会 skip。用户在
   * note 上亲手点「继续循环」就是明确确认，因此这里同时：
   *   ① 会话加入正向名单、移出 /loop off 否定名单；
   *   ② 清本 Bot 软闸（clearLoopStop；`/loop stop all` 的用户硬闸仍保留）；
   *   ③ 解除 /stop 的会话 halt；
   *   ④ 立即催 auto-continue 评估，不必等 ≤60s 兜底 tick。
   */
  const resumeSessionLoop = (sid: string): { err: string; gateStopped: boolean; nudged: boolean } => {
    const err = writeLoopScope(sid, true)
    if (err) return { err, gateStopped: false, nudged: false }
    clearLoopStop()
    haltedSet.delete(sid)
    noteHaltRelease([sid])
    savePersistedState()
    // gateStopped 仍为 true = 顶层是 by="user" 的硬闸（/loop stop all），只能由
    // /loop start all 恢复。如实回报，不让用户以为按钮没生效。
    return { err: "", gateStopped: loopStopped(), nudged: nudgeAutoContinue(sid) }
  }

  /**
   * `/loop on` / `/loop off` —— **只管当前会话**。
   *
   * 为什么要单独做（2026-09-28 用户反馈"自动循环没了"）：
   *  · 循环会话的登记原本**只能靠消息里带标记词**（`筛查循环` / `[STATUS:` / 合成 prompt），
   *    所以新会话（尤其是新 Bot 的新会话）常常**不被登记** → 日志里表现为
   *    `eval begin … loop=no -> skip`，用户看到的就是"自动循环没了"。
   *  · `/loop start` 只清**全局闸**（loop-ctl.json），**不会**给会话打标记 —— 试过了，不管用。
   *  · 全局闸**刻意保留**在 `/loop stop`（任一 Bot 停全都停，跨 Bot 才有意义）。
   *  · `off` 必须写**独立否定清单**：auto-continue 的 persistLoopSessions 会把
   *    `currentLoopTargets()`（各 Bot 的 front/pinned）**重新并回**正向名单，
   *    所以"从正向名单删掉"对当前 front **无效**，下一次落盘又回来。
   */
  const refreshing = new Set<string>()
  const editKb = async (chatID: string, msgID: number, kb: unknown[][]): Promise<boolean> => {
    try {
      const r = await tgFetch("editMessageReplyMarkup", { chat_id: Number(chatID) || chatID, message_id: msgID, reply_markup: { inline_keyboard: kb } })
      return r.ok
    } catch {
      return false
    }
  }
  const refreshExpired = async (cchat: string, fid: string, cbMsgID: number): Promise<string> => {
    // 内存仓丢了（重启/逐出）但持久化定位还在：强制重推整条消息（绕过去重），
    // 把被点的旧按钮换指到新 fid。返回 toast 文案。
    if (refreshing.has(fid)) return "刷新中…"
    const loc = fullKeyStore.get(fid)
    if (!loc) {
      await log("info", `cb refresh miss (no mapping for ${sanitizeLog(fid)})`)
      return "记录已清理，发 /reload N 重看"
    }
    refreshing.add(fid)
    try {
      await log("info", `cb refresh try (fid=${sanitizeLog(fid)} key=${sanitizeLog(loc.key).slice(0, 60)})`)
      const res = await client.session.messages({ path: { id: loc.sid } })
      const arr = Array.isArray(res?.data) ? res.data : []
      const kparts = loc.key.split(":")
      let hit: any = null
      if (kparts[1] === "tool") {
        let callID = kparts.slice(2).join(":")
        callID = callID.replace(/:(input|cont)$/, "")
        for (const m of arr) {
          const ps = (m?.parts ?? []) as any[]
          if (Array.isArray(ps) && ps.some((p: any) => p?.type === "tool" && String(p?.callID ?? p?.id ?? "") === callID)) {
            hit = m
            break
          }
        }
      } else if (kparts[1] === "message") {
        const mk = kparts[2] ?? ""
        hit = mk ? (arr.find((m: any) => String(m?.id ?? m?.info?.id ?? "").startsWith(mk)) ?? null) : null
      }
      if (!hit) {
        await log("info", `cb refresh nohit (fid=${sanitizeLog(fid)})`)
        return "记录已清理，发 /reload N 重看"
      }
      await protoPushAssistantMessage(loc.sid, String(cchat), hit, true)
      let newFid = ""
      for (const [k2, v2] of [...fullKeyStore.entries()]) {
        if (v2.sid === loc.sid && v2.key === loc.key && k2 !== fid) newFid = k2
      }
      if (newFid && cbMsgID) {
        const isToolKey = kparts[1] === "tool"
        const rows: unknown[][] = isToolKey
          ? [[{ text: "📄 看完整版", callback_data: `full:${newFid}` }]]
          : [[{ text: "⏹ 停止", callback_data: "stop" }, { text: "🔄 重试", callback_data: "retry" }], [{ text: "📄 看完整版", callback_data: `full:${newFid}` }]]
        if (await editKb(cchat, cbMsgID, rows)) {
          await log("info", `cb refresh repointed (fid=${sanitizeLog(fid)} -> ${sanitizeLog(newFid)})`)
          return "已刷新，请再点一次"
        }
      }
      await log("info", `cb refresh repushed-nobutton (fid=${sanitizeLog(fid)})`)
      return "已刷新但按钮更新失败，请重新进入"
    } catch (err) {
      await log("error", `cb refresh threw (fid=${sanitizeLog(fid)}): ${sanitizeLog(err).slice(0, 120)}`)
      return "刷新失败"
    } finally {
      refreshing.delete(fid)
    }
  }

  // R2706：过滤/压缩页正文 + 按钮已上收到 tg-menus；偏好仍用桥内同一份可变对象/现读 getter。
  const { filterMenu, filtLine } = createFilterViews({
    filt,
    compactPrefs,
    deliveryMode: () => injectMode,
    titleMerge: () => titleMergeOn,
  })

  // ── 单一按钮菜单 ──────────────────────────────────────────────
  // 目标：命令数量收敛到手机上一屏可点。命令本身全部保留（文本备用），
  // 但日常操作只需要点菜单；R2637 起所有页面/动作都编辑**同一条**菜单消息。
  // R2704：各页说明文案已上收到 tg-menu-text；运行期状态用 getter 注入（保持现读）。
  const menuText = createMenuText({
    sanitizeLog,
    fmtTime,
    botID: () => BOT_ID,
    botLabel: () => BOT_LABEL,
    version: () => VERSION,
    statePath: () => STATE_PATH,
    selfMute: () => selfMute,
    paused: () => pausedMode,
    target: () => fixedTarget ?? frontSessionID ?? persistedFront,
    sessionTag,
    sessionStateLabel,
    rolloverOn429: () => rolloverOn429,
    cardOps: () => readCardOps(BOT_ID).enabled,
    filt,
    compactPrefs,
    watchedSessions,
    pinLen: () => pinQueue.length,
    outLen: () => outQueue.length,
    deliveryMode: () => injectMode,
    filterMenu,
    loopGateInfo,
    bgShape: () => bgApiLabel(bgApiShape(client)),
    watchMax: WATCH_MAX,
  })
  // 薄包装：把运行期状态喂给模块级的真定义（测试直接调 buildMenuKeyboard）
  // 后台提升的最近尝试时间（会话级，用于整体自动配置的冷却）与最近一次"为什么没动"的日志节流。
  const bgLastAttempt = new Map<string, number>()
  let bgLastWhyLogAt = 0
  const menuKeyboard = (view: string): unknown[][] => {
    // 守卫开关每次渲染现读（文件很小、只在开菜单时读），不做缓存：
    // 缓存会让刚点完按钮再开菜单看到旧状态，正是「改了没生效」的观感来源。
    // R2662：会话级循环状态与当前目标只在这里算（模块级构造器拿不到闭包变量）。
    const scopeTarget = fixedTarget ?? frontSessionID ?? persistedFront
    const loopScope: "on" | "off" | "none" = !scopeTarget
      ? "none"
      : readIdList(LOOP_OFF_FILE).includes(scopeTarget)
        ? "off"
        : "on"
    return buildMenuKeyboard(view, {
      paused: pausedMode,
      stopped: loopStopped(),
      selfmute: selfMute,
      guard: readGuardForBot(BOT_ID),
      bgAuto: readBg().enabled,
      bgShellAuto: readBg().shellPromo !== false,
      bgPromoteMs: readBg().promoteMs,
      // R719：压缩通知开关（用户新增选项）
      cnotice: compactPrefs.notice,
      // R2626：每次渲染现读，点完按钮立即看到新状态。
      quotaRecover: readQuotaRecover().mode,
      // R2650：每 Bot 独立开关，点完立即刷新按钮文案。
      rollover429: rolloverOn429,
      // R2728/R2729/R2732：全局通知 + 置顶自愈共用本 Bot 的开关，每次渲染现读。
      cardOps: readCardOps(BOT_ID).enabled,
      // R2659/R2663：注入模式与自定义文案全局共享，每次渲染现读（点完按钮立即看到新状态）。
      injectMode: readLoopInjectMode(),
      injectCustom: readLoopInjectCustom(),
      // R2674：仅标题合并开关是 per-Bot 状态；点完按钮立即看到新状态。
      titleMerge: titleMergeOn,
      // R2662：会话级循环开/关与镜像选择页的“当前目标”过滤。
      loopScope,
      primaryID: scopeTarget,
    })
  }
  // R1646：每个 chat 当前打开的菜单视图（root/子页）。ma 动作执行后「原地刷新」当前视图，
  // 而不是拽回根页 —— 用户明确要"点按钮不回到主菜单"。sync 时保持与 card 一致。
  const menuViewNow = new Map<string, string>()
  // R2637：菜单锚点 = 每个 chat 唯一那条菜单消息。所有页面/动作刷新都编辑它；
  // 只有锚点丢失（被删/超过可编辑期限）才新发一条。点击旧菜单卡时顺带删掉旧卡，
  // 保证界面上最终只剩一条菜单。model/think 的页码也按 chat 记住。
  const menuPageNow = new Map<string, number>()
  const menuAnchorID = (chat: string): number => {
    const rec = protoMap.get(`menu:${chat}`)
    const id = Number(rec?.id ?? 0)
    return Number.isFinite(id) && id > 0 ? id : 0
  }
  const menuAnchorSet = (chat: string, id: number, text: string): void => {
    if (id > 0) protoMap.set(`menu:${chat}`, { id, text, fallback: false })
  }
  const menuDeleteMsg = async (chat: string, mid: number): Promise<void> => {
    if (!(mid > 0)) return
    try {
      const r = await tgFetch("deleteMessage", { chat_id: Number(chat) || chat, message_id: mid })
      if (!r.ok) await log("info", `menu old card delete skipped (mid=${mid}, status=${r.status ?? 0})`)
    } catch {
      /* best-effort：旧卡可能已超期/已删 */
    }
  }
  const menuBackOnly = (): unknown[][] => [[{ text: "⬅️ 返回", callback_data: "m:root" }]]
  /** 模型页：拉取清单/当前模型，按钮里的「关闭」改成回主菜单。 */
  const renderModelMenuView = async (cchat: string, page?: number): Promise<{ text: string; kb: unknown[][] }> => {
    const target = fixedTarget ?? (await activeFront())
    const cached = modelMenuCache.get(cchat)
    const list = cached && Date.now() - cached.ts < 90_000 ? cached.list : await modelHttpList()
    if (!target) return { text: "<b>🤖 选择模型</b>\n\n无法解析目标会话（没有任何已知会话）", kb: menuBackOnly() }
    if (list.length === 0) return { text: "<b>🤖 选择模型</b>\n\n❌ 拉取模型列表失败（宿主 HttpApi GET /api/model 不可用）", kb: menuBackOnly() }
    const sesNow = await modelHttpSession(target)
    const curKey = sesNow ? `${sesNow.providerID}/${sesNow.id}` : ""
    modelMenuCache.set(cchat, { list, ts: Date.now() })
    const p = Number.isFinite(Number(page)) ? Math.max(0, Number(page)) : (menuPageNow.get(cchat) ?? 0)
    menuPageNow.set(cchat, p)
    const kb = buildModelKeyboard(list, p, curKey).map((row) =>
      row.map((btn) => {
        const d = String((btn as any)?.callback_data ?? "")
        return d === "mdl:close" ? { text: "⬅️ 返回", callback_data: "m:root" } : btn
      }),
    )
    return { text: modelMenuText(curKey, list), kb }
  }
  /** 思考深度页：与模型页同构，按钮里的「关闭」改成回主菜单。 */
  const renderThinkMenuView = async (cchat: string): Promise<{ text: string; kb: unknown[][] }> => {
    const target = fixedTarget ?? (await activeFront())
    if (!target) return { text: "<b>🧠 思考深度</b>\n\n无法解析目标会话（没有任何已知会话）", kb: menuBackOnly() }
    const list = await modelHttpList()
    if (list.length === 0) return { text: "<b>🧠 思考深度</b>\n\n❌ 拉取模型列表失败（宿主 HttpApi GET /api/model 不可用）", kb: menuBackOnly() }
    const sesNow = await modelHttpSession(target)
    if (!sesNow) return { text: "<b>🧠 思考深度</b>\n\n❌ 读不到该会话的当前模型（宿主 HttpApi GET /api/session 不可用）", kb: menuBackOnly() }
    const entry = list.find((m) => m.id === sesNow.id && m.providerID === sesNow.providerID)
    const vs = variantListOf(entry)
    const curVar = String(sesNow.variant ?? THINK_DEFAULT)
    const label = entry?.display ?? `${sesNow.providerID}/${sesNow.id}`
    thinkMenuCache.set(cchat, { vs, label, id: sesNow.id, providerID: sesNow.providerID, ts: Date.now() })
    const kb = buildThinkKeyboard(vs, curVar).map((row) =>
      row.map((btn) => {
        const d = String((btn as any)?.callback_data ?? "")
        return d === "thk:close" ? { text: "⬅️ 返回", callback_data: "m:root" } : btn
      }),
    )
    return { text: thinkMenuText(curVar, vs, label), kb }
  }
  /**
   * 菜单显示的**唯一入口**。R2640（运营者："memu 应该是一个命令弹一个，不要复用"）：
   * - 命令入口传 `freshCard`，每次 `/menu`/`/memu` 新发一张卡，绝不复用旧卡；
   * - 按钮回调编辑**被点击的那张卡**（没有的话编辑锚点），因此旧卡仍能原地翻页；
   * - 瞬时失败（429/5xx/网络）在非 freshCard 模式下绝不新发，否则又会出现两条菜单。
   */
  const showMenuView = async (
    cchat: string,
    view: string,
    opts: { clickedMid?: number; page?: number; note?: string; freshCard?: boolean } = {},
  ): Promise<boolean> => {
    const v = (MENU_VIEWS as readonly string[]).includes(view) ? view : "root"
    let rendered: { text: string; kb: unknown[][] }
    if (v === "model") rendered = await renderModelMenuView(cchat, opts.page)
    else if (v === "think") rendered = await renderThinkMenuView(cchat)
    else rendered = { text: menuText(v), kb: menuKeyboard(v) }
    // 动作回执不另发一条（否则又多一条消息）：直接追加在所渲染页面末尾。
    if (opts.note) rendered = { text: `${rendered.text}\n\n${opts.note}`, kb: rendered.kb }
    const clicked = Number(opts.clickedMid ?? 0) || 0
    // R2640: the command path asks for a new card; callbacks edit the card
    // the user actually tapped (fall back to the per-chat anchor).
    const anchor = opts.freshCard ? 0 : menuAnchorID(cchat)
    let mid = opts.freshCard ? 0 : clicked || anchor
    let r: { r: "sent" | "retry" | "drop"; id?: number; status?: number; desc?: string; same?: boolean } =
      mid > 0 ? await editTextRaw(cchat, mid, rendered.text, rendered.kb, false) : { r: "retry", status: 0 }
    let created = false
    if (r.r !== "sent") {
      const permanent = r.status === 400 || r.status === 403 || r.status === 404
      if (opts.freshCard || !anchor || permanent) {
        if (!opts.freshCard && anchor && permanent) await menuDeleteMsg(cchat, anchor)
        const sent = await sendTextRaw(cchat, rendered.text, rendered.kb, false)
        const verdict = protoDeliveryVerdict(sent)
        if (!verdict.delivered || !sent.id) {
          await log("warn", `menu send failed (chat=${sanitizeLog(cchat)}, view=${v}, r=${sent.r}, status=${sent.status ?? 0})`)
          return false
        }
        mid = sent.id
        created = true
      } else {
        await log("warn", `menu edit deferred (chat=${sanitizeLog(cchat)}, view=${v}, msg=${anchor}, status=${r.status ?? 0}, r=${r.r})`)
        return false
      }
    }
    menuViewNow.set(cchat, v)
    menuAnchorSet(cchat, mid, rendered.text)
    if (created) savePersistedState()
    // 旧菜单卡被点击时，内容已渲染到该卡自身（mid==clicked），这里仅兼容极端情况。
    if (clicked > 0 && clicked !== mid) await menuDeleteMsg(cchat, clicked)
    if (opts.freshCard && created) await log("info", `menu sent as new card (chat=${sanitizeLog(cchat)}, view=${v}, msg=${mid})`)
    else await log("info", `menu ${created ? "sent" : "edited"} in place (chat=${sanitizeLog(cchat)}, view=${v}, msg=${mid})`)
    return true
  }
  // R2452（用户「增加一个让ai修改标题的按钮」）：同一会话只允许一个标题生成在飞，
  // 防止连点造成多次 /generate 与多次 PATCH 竞态。
  const aiTitleBusy = new Set<string>()

  // ── R2231 模型选择：宿主直连 + 选择器缓存 ─────────────────────────────
  // 复用 R1881/R1399 的同源凭证（service.json + Basic encode("opencode:"+pw)）。
  // 所有宿主往返带显式 15s 超时（与文件内其它网络调用一致，避免半边僵死卡住命令应答）。
  const modelHttp = async (path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: any }> => {
    try {
      const { url, password: pw } = await hostServiceReg()
      if (!url || !pw) return { ok: false, status: 0, body: { error: "宿主 HttpApi 凭证不可用（service.json 缺 url/password 且无 OPENCODE_PASSWORD）" } }
      const token = Buffer.from(`opencode:${pw}`, "utf8").toString("base64")
      const headers: Record<string, string> = { Authorization: `Basic ${token}`, ...((init?.headers as Record<string, string>) ?? {}) }
      if (init?.method && init.method !== "GET") headers["Content-Type"] = "application/json"
      const r = await fetch(`${url}${path}`, {
        ...(init ?? {}),
        headers,
        signal: AbortSignal.timeout(15_000),
      })
      const raw = await r.text().catch(() => "")
      let body: any = null
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
      return { ok: r.ok, status: r.status, body }
    } catch (err) {
      return { ok: false, status: 0, body: { error: String(err).slice(0, 120) } }
    }
  }
  /** GET /api/model → 可选模型表（过滤+排序交给纯函数）。空表=直连不可用/无模型。 */
  const modelHttpList = async (): Promise<ModelEntry[]> => modelListEntries((await modelHttp("/api/model")).body)
  /** GET /api/session/{sid} → 当前模型 ref（{id, providerID}），取不到返回 null。 */
  const modelHttpSession = async (sid: string): Promise<{ id: string; providerID: string; variant?: string } | null> => {
    const b = (await modelHttp(`/api/session/${encodeURIComponent(sid)}`)).body
    // R2369（用户实报「当前模型不显示」）：HttpApi 所有响应都带 `{data: ...}` 信封
    // （实测 `GET /api/session/<id>` → `{data:{id,model:{id,providerID,variant},...}}`）。
    // 旧写法只看 `b.model ?? b` → 永远取不到 → `curKey=""` → 选择器恒显示「当前：未知」、
    // `/model <名称>` 也失去"当前 provider"这一消歧依据。必须先剥一层 `data`。
    const root = (b && typeof b === "object" ? ((b as any).data ?? b) : null) as any
    const m = (root && typeof root === "object" ? (root.model ?? root) : null) as any
    if (m && typeof m.id === "string" && typeof m.providerID === "string") {
      return { id: m.id, providerID: m.providerID, variant: typeof m.variant === "string" ? m.variant : undefined }
    }
    return null
  }
  /** POST /api/session/{sid}/model → 204 表示切换成功。
   *  R201：`variant` 可选 = 思考深度档位。⚠️ 宿主对 variant **不校验**（实测传 "zzz"
   *  也回 204 并真的存进会话）⇒ 只许传来自 `GET /api/model` 清单里的值。 */
  const modelHttpSet = async (sid: string, ref: { id: string; providerID: string; variant?: string }): Promise<{ ok: boolean; status: number; body: any }> =>
    modelHttp(`/api/session/${encodeURIComponent(sid)}/model`, {
      method: "POST",
      body: JSON.stringify({ model: ref }),
    })
  /**
   * R2658（运营者："开新会话时模型默认沿用当前设置，而不是不指定"）：
   * 新建会话（/new、/migrate、429 换会话）原来只传 title，宿主回落到**全局默认**
   * 模型 —— 用户当前选的 provider/model/variant（含思考深度）在换会话后就丢了。
   * 创建成功后立刻把来源会话的 model 写进新会话（POST /api/session/{id}/model）。
   * 读不到来源模型（老会话 model=null / HttpApi 不可用）时不阻断创建，只记日志。
   */
  const inheritSessionModel = async (nid: string, srcSid: string): Promise<boolean> => {
    if (!nid || !srcSid || nid === srcSid) return false
    const ref = await modelHttpSession(srcSid)
    if (!ref) {
      await log(
        "info",
        `new session model inherit skipped (new=${sanitizeLog(nid).slice(0, 12)} src=${sanitizeLog(srcSid).slice(0, 12)}): source model unavailable`,
      )
      return false
    }
    const r = await modelHttpSet(nid, ref)
    if (!r.ok) {
      await log(
        "warn",
        `new session model inherit failed (new=${sanitizeLog(nid).slice(0, 12)} src=${sanitizeLog(srcSid).slice(0, 12)} status=${r.status})`,
      )
      return false
    }
    await log(
      "info",
      `new session model inherited (new=${sanitizeLog(nid).slice(0, 12)} src=${sanitizeLog(srcSid).slice(0, 12)} model=${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""})`,
    )
    return true
  }
  /** 选择器缩略缓存（每个 chat 一份，90s TTL）：按钮回调按下标解析模型，无需把长 id 塞进 64B 的 callback_data。 */
  const modelMenuCache = new Map<string, { list: ModelEntry[]; ts: number }>()
  /** R201：思考深度选择器缓存（同 modelMenuCache 的理由：callback_data 只有 64B）。 */
  const thinkMenuCache = new Map<string, { vs: ThinkVariant[]; label: string; id: string; providerID: string; ts: number }>()
  // R2709：/revert 的三段式 API 语义、错误映射与文案已上收；桥只解析目标会话并转发回复。
  const revertCmd = createRevertCommand({
    modelHttp,
    fmtTime,
    clean,
    safeCut,
    sanitizeLog,
    log,
    loopStopped,
    readIdList,
    loopSessionsFile: LOOP_SESSIONS_FILE,
    commandArg,
  })
  // R2712：推送/队列命令上收；队列数组/发送函数用实时引用注入，保存仍走桥的单一状态出口。
  const pushCmd = createPushCommands({
    setPaused: (v) => {
      pausedMode = v
    },
    injectMode: () => injectMode,
    setInjectMode: (v) => {
      injectMode = v
    },
    saveState: savePersistedState,
    pinQueue,
    outQueue,
    flushQueue,
    pumpInject: (sid) => {
      void pumpInject(sid)
    },
    listPlaceholder,
    deleteMessage: async (chat, messageID) => {
      try {
        await tgFetch("deleteMessage", { chat_id: Number(chat) || chat, message_id: messageID })
      } catch {
        /* best-effort */
      }
    },
    fmtTime,
    clean,
    sanitizeLog,
    commandArg,
  })
  // R2713：会话列表命令上收；缓存/活动表用实时引用，选择登记仍写回桥的 pendingSelect。
  const sessionList = createSessionListCommands({
    refreshTitles: refreshSessionTitles,
    resetFrontOverride: () => {
      activeFrontOverride = ""
    },
    sessions: () => cachedSessionList,
    fixedTarget: () => fixedTarget,
    activeFront,
    nextSelectGen: () => ++selectGen,
    lastActivity,
    activeWindowMs: ACTIVE_WINDOW_MS,
    setPendingSelect: (cid, value) => pendingSelect.set(cid, value),
    clean,
    now: () => Date.now(),
  })
  // R2715：模型/思考深度命令上收；HTTP、菜单跳转与选择器缓存都由桥注入。
  const modelCmd = createModelCommands({
    target: async () => fixedTarget ?? (await activeFront()),
    modelList: () => modelHttpList(),
    modelSession: (sid) => modelHttpSession(sid),
    modelSet: (sid, body) => modelHttpSet(sid, body as { id: string; providerID: string; variant?: string }),
    resolveModelRef,
    sessionTag,
    clean,
    commandArg,
    cacheModel: (cid, list) => modelMenuCache.set(cid, { list, ts: Date.now() }),
    cacheThink: (cid, value) => thinkMenuCache.set(cid, { ...value, ts: Date.now() }),
    showMenu: (cid, view) => showMenuView(cid, view),
  })
  // R2717：/proxy 上收；出口状态视图与“结束本轮”动作由桥注入。
  const proxyCmd = createProxyCommands({
    botLabel: () => BOT_LABEL,
    readExitProxy,
    exitProxyBrief,
    exitProxyPanel,
    exitProxySummary,
    isExitProxyActive,
    endRunForNewExit,
    fmtIsoTime,
    sanitizeLog,
    commandArg,
    reply,
  })
  // R2718：/config 上收；配置清单的实时状态全部用 getter 注入。
  const configCmd = createConfigCommands({
    botId: BOT_ID,
    botLabel: () => BOT_LABEL,
    version: VERSION,
    statePath: STATE_PATH,
    target: () => fixedTarget ?? frontSessionID ?? persistedFront,
    sessionTag,
    selfMute: () => selfMute,
    pausedMode: () => pausedMode,
    titleMergeOn: () => titleMergeOn,
    pinQueueLen: () => pinQueue.length,
    outQueueLen: () => outQueue.length,
    readGuard: () => readGuardForBot(BOT_ID),
    readBg: () => readBg(),
    readLoopCtl: () => readLoopCtl(),
    readBots: () => {
      try {
        const j = JSON.parse(readFileSync(`REDACTED_ROOT/.config/opencode/tg-bots.json`, "utf8")) as any
        return Array.isArray(j?.bots) ? j.bots : []
      } catch {
        return null
      }
    },
    readInvalidBots: () => readInvalidBotDetails(),
    invalidBotReasonLabel,
    botDisplayName,
    readLoopInjectMode,
    loopInjectModeShortLabel,
    readQuotaRecover,
    exitProxyBrief,
    isExitProxyActive,
    readExitProxy,
    exitProxyStatePath: EXIT_PROXY_STATE_PATH,
    fmtIsoTime,
    sanitizeLog,
    reply,
  })
  // R2719：/background 上收；宿主 client、HTTP 兜底与提升尝试记账由桥注入。
  const backgroundCmd = createBackgroundCommands({
    botEnvVar: BG_ENV_VAR,
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
    target: async () => fixedTarget ?? (await activeFront()),
    noteAttempt: (sid) => bgLastAttempt.set(sid, Date.now()),
    sanitizeLog,
    commandArg,
    reply,
  })
  // R2720：/autoguard 上收；本 Bot 的守卫读写与最近触发记录由桥注入。
  const autoguardCmd = createAutoguardCommands({
    botId: BOT_ID,
    botLabel: () => BOT_LABEL,
    readGuard: () => readGuardForBot(BOT_ID),
    readLastTrip: () => readGuardLastTripForBot(BOT_ID),
    writeGuard: (cfg) => writeGuardForBot(BOT_ID, cfg as any),
    parseGuardArg,
    fmtTime,
    sanitizeLog,
    commandArg,
    reply,
  })
  // R2721：/loop 的注入文案子命令上收；启停与状态仍在桥内。
  const loopInjectCmd = createLoopInjectCommands({
    readMode: readLoopInjectMode,
    readCustom: readLoopInjectCustom,
    writeMode: writeLoopInjectMode,
    writeCustom: writeLoopInjectCustom,
    modeLabel: loopInjectModeLabel,
    customPreview: loopInjectCustomPreview,
    placeholders: LOOP_INJECT_PLACEHOLDERS,
    customMax: LOOP_INJECT_CUSTOM_MAX,
    htmlEsc,
    reply,
  })
  // R2722：/loop 启停与状态上收；逐会话名单、闸文件、halt 与本 Bot 状态视图由桥注入。
  const loopCmd = createLoopCommands({
    botLabel: () => BOT_LABEL,
    target: async () => fixedTarget ?? (await activeFront()),
    sessionTag,
    writeLoopScope,
    log,
    sanitizeLog,
    persistLoopStop,
    clearLoopStop,
    writeLoopCtl,
    readLoopCtl,
    doStop,
    selfFront: () => fixedTarget ?? frontSessionID ?? persistedFront,
    releaseHalt: (sid) => {
      haltedSet.delete(sid)
      noteHaltRelease([sid])
      savePersistedState()
    },
    resumePumps: () => {
      for (const sid of new Set(pinQueue.map((qq) => qq.sid))) void pumpInject(sid)
      void refreshQueuePin()
    },
    botDisplayName,
    injectCmd: loopInjectCmd,
    readInjectMode: readLoopInjectMode,
    readInjectCustom: readLoopInjectCustom,
    injectModeLabel: loopInjectModeLabel,
    refreshSessionTitles,
    stateFiles: () => globSync(`REDACTED_ROOT/.config/opencode/tg-chats*.json`),
    readJson: (path) => JSON.parse(readFileSync(path, "utf8")),
    stickyLoopSessions: () => {
      const set = new Set<string>()
      try {
        const arr = JSON.parse(readFileSync(`REDACTED_ROOT/.config/opencode/loop-sessions.json`, "utf8"))
        if (Array.isArray(arr)) for (const x of arr) if (typeof x === "string") set.add(x)
      } catch {
        /* 无粘性文件 = 尚未识别 */
      }
      return set
    },
    lastRoundOf: (sid) => lastRound.get(sid),
    lastActivityOf: (sid) => lastActivity.get(sid),
    cachedSession: (sid) => cachedSessionList.find((x) => x.id === sid),
    outcomeLabel,
    now: () => Date.now(),
    commandArg,
    reply,
  })
  // R2723：/replay /reload 上收；取尾/协议推送/回执由桥注入。
  const replayCmd = createReplayCommands({
    target: async () => (fixedTarget && fixedTarget.length > 0 ? fixedTarget : await activeFront()),
    fetchTail,
    pushMessage: (sid, chatID, m) => protoPushAssistantMessage(sid, chatID, m),
    commandArg,
    reply,
  })
  // R2724：/new /fork 上收；宿主创建/切换/循环名单由桥注入，切换语义与 /use 同一份。
  const newForkCmd = createNewForkCommands({
    target: async () => fixedTarget ?? (await activeFront()),
    inheritFrom: async () => fixedTarget || persistedFront || frontSessionID || (await activeFront()),
    createSession:
      typeof (client as any)?.session?.createSession === "function"
        ? (opts) => (client as any).session.createSession(opts)
        : null,
    inheritModel: (nid, src) => inheritSessionModel(nid, src),
    forkSessionByID: (sid, before) => forkSessionByID(sid, before),
    switchTarget: (sid) => {
      fixedTarget = sid
      persistedFront = sid
      frontSessionID = sid
      savePersistedState()
    },
    loopLists: () => ({ list: readIdList(LOOP_SESSIONS_FILE), off: readIdList(LOOP_OFF_FILE) }),
    appendLoopSession: (sid) => writeIdList(LOOP_SESSIONS_FILE, [...readIdList(LOOP_SESSIONS_FILE), sid]),
    clean,
    sanitizeLog,
    log,
    commandArg,
    reply,
  })
  // R2725：/migrate 上收；宿主创建/摘要注入/自动化记账由桥注入。
  const migrateCmd = createMigrateCommands({
    target: async () => fixedTarget ?? (await activeFront()),
    createSession:
      typeof (client as any)?.session?.createSession === "function"
        ? (opts) => (client as any).session.createSession(opts)
        : null,
    fetchTail,
    partsOf,
    inheritModel: (nid, src) => inheritSessionModel(nid, src),
    doPrompt,
    automationStart,
    automationEnd,
    sanitizeLog,
    log,
    reply,
  })
  const handleCallback = async (cq: any): Promise<void> => {
    try {
    const data = String(cq?.data ?? "")
    const qid = String(cq?.id ?? "")
    const cchat = cq?.message?.chat ? chatTarget(cq.message.chat) : ""
    await log("info", `cb recv (chat=${sanitizeLog(cchat)}, data=${sanitizeLog(data).slice(0, 40)})`)
    const answer = async (t?: string): Promise<void> => {
      if (!qid) return
      // 只重试一次、间隔 1.2s：answerCallback 迟迟不到，Telegram 会让按钮一直转圈，
      // 用户看到的就是"按钮点了没反应"。重试成本极低。
      // R1865：瞬时/确定性分流复用 R1842 的 isTransientStripFailure（0/undefined/429/5xx 为瞬时）。
      // 旧内联判据 `r.status !== 0 && r.status !== 429 && r.status < 500` 与它等价，但
      // **瞬时重试与终态失败都记 error** —— 与 sendMessage/editTextRaw 的"瞬时只记 info（will retry）"
      // 不一致，也与 R1861（getUpdates 5xx 归 routine）同族：服务端抖一下就把"近 N 分钟 0 error"
      // 健康信号打脏。瞬时耗尽会随用户下次点击自愈 → warn；确定性 4xx 才是真 error。
      let lastStatus: number | undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) await new Promise((r2) => setTimeout(r2, 1200))
          const r = await tgFetch("answerCallbackQuery", t ? { callback_query_id: qid, text: t.slice(0, 190) } : { callback_query_id: qid })
          if (r.ok) return
          lastStatus = r.status
          if (!isTransientStripFailure(r.status)) break
          await log("info", `answerCallback retry (attempt=${attempt + 1}, data=${sanitizeLog(data).slice(0, 30)}, status=${r.status ?? "?"})`)
        } catch {
          /* best-effort */
        }
      }
      await log(isTransientStripFailure(lastStatus) ? "warn" : "error", `answerCallback failed (data=${sanitizeLog(data).slice(0, 30)})`)
    }
    if (!data || !cchat) {
      await answer()
      return
    }
    const parts = data.split(":")
    // R2672：turn-end note 的循环按钮。必须真正驱动会话级循环状态（不是只弹 toast）：
    //   te:on:<sid>  = 会话加入循环 + 清本 Bot 软闸 + 解除 halt + 立即催 auto-continue；
    //   te:off:<sid> = /loop off（只关本会话，不中断任何回合）。
    // callback_data 带 sid：用户切了前台后再点旧 note，也只作用于提示所指的会话。
    if (parts[0] === "te") {
      const act = parts[1] ?? ""
      const sid = parts.slice(2).join(":")
      const mid = Number(cq?.message?.message_id ?? 0)
      if (!sid.startsWith("ses_")) {
        await answer("会话无效")
        return
      }
      if (act === "on") {
        const r = resumeSessionLoop(sid)
        if (r.err) {
          await answer("写入失败，未能开启")
          await log("error", `turn-end loop on failed sid=${sanitizeLog(sid).slice(0, 14)}: ${r.err}`)
          return
        }
        const text = r.gateStopped
          ? "⚠️ 本会话已开；全局循环闸仍停着（需 /loop start all）"
          : "✅ 已继续本会话自动循环"
        await answer(r.gateStopped ? "全局闸仍停着，需 /loop start all" : "已继续循环")
        if (mid) void editTextRaw(cchat, mid, text, [])
        await log(
          "info",
          `turn-end loop on sid=${sanitizeLog(sid).slice(0, 14)} gateStopped=${r.gateStopped} nudged=${r.nudged}`,
        )
        return
      }
      if (act === "off") {
        const err = writeLoopScope(sid, false)
        if (err) {
          await answer("写入失败，未能停止")
          await log("error", `turn-end loop off failed sid=${sanitizeLog(sid).slice(0, 14)}: ${err}`)
          return
        }
        await answer("已停止本会话循环")
        if (mid) void editTextRaw(cchat, mid, "⏸ 已停止本会话自动循环", [])
        await log("info", `turn-end loop off sid=${sanitizeLog(sid).slice(0, 14)}`)
        return
      }
      await answer("未知动作")
      return
    }
    // ── 单一按钮菜单：所有功能从这里进入（命令保留为文本备用） ──
    if (parts[0] === "m") {
      const view = parts[1] ?? "root"
      const mid = Number(cq?.message?.message_id ?? 0)
      // R2637：所有菜单页共用同一个锚点消息；点旧卡时渲染到锚点并删除旧卡。
      const ok = await showMenuView(cchat, view, { clickedMid: mid })
      await answer(ok ? "菜单" : "稍后重试")
      return
    }
    if (parts[0] === "title" && parts[1] === "ai") {
      // 用户要求：在循环卡/循环菜单增加「让 AI 修改标题」按钮。
      // 宿主 /generate 只根据当前会话上下文生成临时文本（不写历史），随后桥接用
      // PATCH /api/session/{id} 真正落标题；循环标记 [LOOP]/[LOOP:OFF] 原样保留。
      const target = fixedTarget ?? (await activeFront())
      if (!target) {
        await answer("未找到目标会话")
        await reply(cchat, "⚠️ 找不到当前会话，无法改标题。")
        return
      }
      if (aiTitleBusy.has(target)) {
        await answer("AI 正在生成标题…")
        return
      }
      await answer("AI 正在生成标题…")
      aiTitleBusy.add(target)
      try {
        const curTitle = sessionNameOf(target) || ""
        const gen = await modelHttp(`/api/session/${encodeURIComponent(target)}/generate`, {
          method: "POST",
          body: JSON.stringify({ prompt: AI_TITLE_PROMPT }),
        })
        if (!gen.ok) {
          const why = clean(
            String((gen.body as any)?.error ?? (gen.body as any)?.data?.error ?? gen.body ?? ""),
            160,
          )
          await reply(
            cchat,
            `⚠️ AI 生成标题失败（HTTP ${gen.status || "网络错误"}）${why ? `：${htmlEsc(why)}` : ""}`,
          )
          return
        }
        const root = (gen.body && typeof gen.body === "object" ? ((gen.body as any).data ?? gen.body) : gen.body) as any
        const rawTitle = typeof root === "string" ? root : String(root?.text ?? "")
        const base = sanitizeAiTitle(rawTitle)
        if (!base) {
          await reply(cchat, "⚠️ AI 没有返回可用标题，请再点一次。")
          return
        }
        const oldMark = (curTitle.match(/\[LOOP(?::OFF)?\]/g) ?? []).pop() ?? ""
        const mark = oldMark || (loopGateInfo().stopped ? "[LOOP:OFF]" : "[LOOP]")
        const finalTitle = `${base}${mark ? ` ${mark}` : ""}`
        const patch = await modelHttp(`/api/session/${encodeURIComponent(target)}`, {
          method: "PATCH",
          body: JSON.stringify({ title: finalTitle }),
        })
        if (!patch.ok) {
          const why = clean(
            String((patch.body as any)?.error ?? (patch.body as any)?.data?.error ?? patch.body ?? ""),
            160,
          )
          await reply(
            cchat,
            `⚠️ 标题写入失败（HTTP ${patch.status || "网络错误"}）${why ? `：${htmlEsc(why)}` : ""}`,
          )
          return
        }
        sessionTitleCache.set(target, finalTitle)
        void refreshSessionTitles()
        void renameBotToSession(target)
        // 若按钮来自置顶卡，立即回写卡片（会话名/标题可见）；来自菜单则保留菜单原样，
        // 由命令回复告知结果，避免把菜单卡误编辑成状态卡。
        const st = readInjectCardState(BOT_ID)
        const mid = Number(cq?.message?.message_id ?? 0)
        if (mid && st.msgID === mid) {
          const cardText = injectCardText({
            bot: BOT_LABEL,
            lastAt: st.lastAt || Date.now(),
            kind: st.lastKind,
            sid: st.lastSid || target,
            count: st.count,
            avgGapMs: st.avgGapMs,
            gate: loopGateInfo(),
            sessionLoopOff: !sessionLoopRegistered(target),
            now: Date.now(),
            session: sessionTag(target),
            sessionState: sessionStateLabel(target),
            queue: outQueue.length,
            pinQueue: pinQueue.length,
            paused: pausedMode,
            pinned: st.pinOk,
          })
          try {
            await editTextRaw(cchat, mid, cardText, injectCardKeyboard(), false)
          } catch {
            /* 卡片回写失败不阻断标题结果通知 */
          }
        }
        await reply(cchat, `✅ AI 已修改会话标题：<b>${htmlEsc(finalTitle)}</b>`)
      } catch (err) {
        await log("warn", `ai title failed (sid=${target.slice(0, 12)}): ${sanitizeLog(err).slice(0, 120)}`)
        await reply(cchat, "⚠️ AI 改标题失败，请稍后重试。")
      } finally {
        aiTitleBusy.delete(target)
      }
      return
    }
    if (parts[0] === "ma") {
      // 菜单动作：等价于执行对应命令，复用既有处理逻辑
      const act = parts[1] ?? ""
      const arg = parts.slice(2).join(":")
      const map = MENU_ACTION_TEXT
      const cmdText = map[act]
      if (!cmdText) {
        await answer("未知动作")
        return
      }
      const mid = Number(cq?.message?.message_id ?? 0)
      // 合成一条“来自本 chat 的文本消息”喂给既有处理链：命令逻辑只有一份，
      // 菜单与文本命令行为完全一致（不会两套实现走偏）。
      const chatIDNum = Number(cchat)
      if (Number.isFinite(chatIDNum) && chatIDNum > 0) {
        await handleUpdateInner(
          {
            update_id: -Date.now(), // 负数：永不与真实 update_id 冲突
            message: {
              message_id: Number(cq?.message?.message_id ?? 0),
              chat: { id: chatIDNum, type: "private" },
              from: { id: chatIDNum, is_bot: false },
              text: `${cmdText}${arg ? ` ${arg}` : ""}`,
              date: Math.floor(Date.now() / 1000),
            },
          },
          { synthetic: true }, // 合成：不进真实去重环（见 handleUpdateInner 注释）
        )
      } else {
        await reply(cchat, `⚠️ 菜单动作需要在 numeric chat 里执行（当前 chat=${sanitizeLog(cchat)}）`)
      }
      // R2637：动作本身可能已经打开菜单页（/quiet → 推送过滤页，/model、/think →
      // 菜单内的选择器）。这些动作不再二次刷新，避免同一拍编辑两次。
      const SUBMENU_ACTIONS = new Set(["quiet", "model", "think"])
      if (mid && !SUBMENU_ACTIONS.has(act)) {
        // 执行完**原地刷新当前视图**（用户所在子页），渲染到唯一菜单锚点；
        // 若用户点的是旧菜单卡，showMenuView 会删掉旧卡收敛成一条。
        const curView = menuViewNow.get(cchat) ?? "root"
        await showMenuView(cchat, curView, { clickedMid: mid })
      } else if (mid) {
        await log("info", `menu action opened submenu (act=${act})`)
      }
      await answer("已执行")
      return
    }
    if (parts[0] === "mdl") {
      // R2231 模型选择器按钮：set:<idx> 按下标切模型；refresh 重拉；pg:<n> 翻页；
      // nop=页码占位；close=收掉选择器消息。（选择器由 /model 命令或根菜单 🤖 模型 打开。）
      const sub = parts[1] ?? ""
      const mid = Number(cq?.message?.message_id ?? 0)
      // R2637：从菜单进入时，选择器就是菜单锚点；所有翻页/切换直接编辑锚点。
      // 旧版独立选择器卡（mid≠锚点）仍走原路径，避免历史按钮失效。
      const viaMenu = mid > 0 && mid === menuAnchorID(cchat)
      if (sub === "close") {
        await answer("已关闭")
        if (viaMenu) {
          await showMenuView(cchat, "root", { clickedMid: mid })
          return
        }
        if (mid) {
          try {
            const r = await tgFetch("deleteMessage", { chat_id: Number(cchat) || cchat, message_id: mid })
            if (!r.ok) await editTextRaw(cchat, mid, modelMenuText("", []), [], false)
          } catch {
            try {
              await editTextRaw(cchat, mid, modelMenuText("", []), [], false)
            } catch {
              /* best-effort */
            }
          }
        }
        return
      }
      if (sub === "nop") {
        await answer("…")
        return
      }
      const cached = modelMenuCache.get(cchat)
      const list = cached && Date.now() - cached.ts < 90_000 ? cached.list : await modelHttpList()
      if (list.length === 0) {
        await answer("模型列表不可用")
        if (viaMenu) {
          await showMenuView(cchat, "model", { clickedMid: mid })
          return
        }
        if (mid) await editTextRaw(cchat, mid, "❌ 拉取模型列表失败（宿主 HttpApi GET /api/model 不可用）", [], false)
        return
      }
      const target = fixedTarget ?? (await activeFront())
      if (!target) {
        await answer("无法解析目标会话")
        if (viaMenu) await showMenuView(cchat, "model", { clickedMid: mid })
        return
      }
      const sesNow = await modelHttpSession(target)
      const curKey = sesNow ? `${sesNow.providerID}/${sesNow.id}` : ""
      if (sub === "set") {
        const idx = Number(parts[2] ?? "-1")
        const hit = list[idx]
        if (!hit) {
          await answer("模型不存在")
          return
        }
        const res = await modelHttpSet(target, { id: hit.id, providerID: hit.providerID })
        if (!res.ok) {
          await answer(`切换失败 ${res.status}`)
          const why = typeof res.body === "object" && res.body ? String(res.body.error ?? "") || String(res.body) : String(res.body)
          const note = `❌ 切换失败（HTTP ${res.status}）：${htmlEsc(clean(why, 120))}`
          if (viaMenu) {
            await showMenuView(cchat, "model", { clickedMid: mid, note })
            return
          }
          if (mid) await editTextRaw(cchat, mid, note, [], false)
          return
        }
        await answer(`已切换 ${hit.display}`)
        modelMenuCache.set(cchat, { list, ts: Date.now() })
        if (viaMenu) {
          await showMenuView(cchat, "model", {
            clickedMid: mid,
            page: 0,
            note: `✅ 已切换 → <b>${htmlEsc(hit.display)}</b>（下次生成生效）`,
          })
          return
        }
        const ses2 = await modelHttpSession(target)
        const cur2 = ses2 ? `${ses2.providerID}/${ses2.id}` : curKey
        const text2 = `${modelMenuText(cur2, list)}\n✅ 已切换 → <b>${htmlEsc(hit.display)}</b>（下次生成生效）`
        if (mid) {
          const r = await editTextRaw(cchat, mid, text2, buildModelKeyboard(list, 0, cur2), false)
          if (r.r !== "sent") await sendTextRaw(cchat, text2, buildModelKeyboard(list, 0, cur2), false)
        }
        return
      }
      if (sub === "pg") {
        const page = Math.max(0, Number(parts[2] ?? "0") || 0)
        await answer("已翻页")
        modelMenuCache.set(cchat, { list, ts: Date.now() })
        if (viaMenu) {
          await showMenuView(cchat, "model", { clickedMid: mid, page })
          return
        }
        const t = modelMenuText(curKey, list)
        const kb = buildModelKeyboard(list, page, curKey)
        // 编辑失败（如文案被 TG 判非法）不能静默不动 —— 退化为新发一条，保证翻页可见。
        const r = mid ? await editTextRaw(cchat, mid, t, kb, false) : { r: "retry" as const }
        if (r.r !== "sent") await sendTextRaw(cchat, t, kb, false)
        return
      }
      if (sub === "refresh") {
        await answer("已刷新")
        if (viaMenu) {
          // 强制丢弃 90s 缓存，showMenuView 会重新 GET /api/model。
          modelMenuCache.delete(cchat)
          await showMenuView(cchat, "model", { clickedMid: mid, page: 0, note: "🔄 已刷新" })
          return
        }
        const fresh = await modelHttpList()
        const list2 = fresh.length > 0 ? fresh : list
        const ses2 = await modelHttpSession(target)
        const cur2 = ses2 ? `${ses2.providerID}/${ses2.id}` : curKey
        modelMenuCache.set(cchat, { list: list2, ts: Date.now() })
        const t = modelMenuText(cur2, list2)
        const kb = buildModelKeyboard(list2, 0, cur2)
        const r = mid ? await editTextRaw(cchat, mid, t, kb, false) : { r: "retry" as const }
        if (r.r !== "sent") await sendTextRaw(cchat, t, kb, false)
        return
      }
      await answer("未知按钮")
      return
    }
    if (parts[0] === "thk") {
      // R201 思考深度选择器按钮：set:<idx> 切档；refresh 重拉模型清单；close 收掉消息。
      // （选择器由 /think 命令或根菜单 🧠 思考深度 打开。）
      const sub = parts[1] ?? ""
      const mid = Number(cq?.message?.message_id ?? 0)
      // R2637：从菜单进入时选择器就是菜单锚点；切档/刷新/返回都编辑同一条消息。
      const viaMenu = mid > 0 && mid === menuAnchorID(cchat)
      if (sub === "close") {
        await answer("已关闭")
        if (viaMenu) {
          await showMenuView(cchat, "root", { clickedMid: mid })
          return
        }
        if (mid) {
          try {
            const r = await tgFetch("deleteMessage", { chat_id: Number(cchat) || cchat, message_id: mid })
            if (!r.ok) await editTextRaw(cchat, mid, thinkMenuText("", [], ""), [], false)
          } catch {
            /* best-effort */
          }
        }
        return
      }
      const tTarget = fixedTarget ?? (await activeFront())
      if (!tTarget) {
        await answer("无法解析目标会话")
        if (viaMenu) await showMenuView(cchat, "think", { clickedMid: mid })
        return
      }
      const sesNow = await modelHttpSession(tTarget)
      if (!sesNow) {
        await answer("读不到当前模型")
        if (viaMenu) await showMenuView(cchat, "think", { clickedMid: mid })
        return
      }
      let cache = thinkMenuCache.get(cchat)
      if (sub === "refresh" || !cache || Date.now() - cache.ts > 90_000) {
        const fresh = await modelHttpList()
        const entry = fresh.find((m) => m.id === sesNow.id && m.providerID === sesNow.providerID)
        cache = {
          vs: variantListOf(entry),
          label: entry?.display ?? `${sesNow.providerID}/${sesNow.id}`,
          id: sesNow.id,
          providerID: sesNow.providerID,
          ts: Date.now(),
        }
        thinkMenuCache.set(cchat, cache)
        if (sub === "refresh") {
          await answer("已刷新")
          if (viaMenu) {
            await showMenuView(cchat, "think", { clickedMid: mid, note: "🔄 已刷新" })
            return
          }
          const cur = String(sesNow.variant ?? THINK_DEFAULT)
          const t2 = thinkMenuText(cur, cache.vs, cache.label)
          const kb = buildThinkKeyboard(cache.vs, cur)
          const r = mid ? await editTextRaw(cchat, mid, t2, kb, false) : { r: "retry" as const }
          if (r.r !== "sent") await sendTextRaw(cchat, t2, kb, false)
          return
        }
      }
      const hit = cache.vs[Number(parts[2] ?? "-1")]
      if (!hit) {
        await answer("档位不存在")
        return
      }
      const res = await modelHttpSet(tTarget, { id: cache.id, providerID: cache.providerID, variant: hit.id })
      if (!res.ok) {
        await answer(`切换失败 ${res.status}`)
        const why = typeof res.body === "object" && res.body ? String(res.body.error ?? "") || String(res.body) : String(res.body)
        const note = `❌ 切换失败（HTTP ${res.status}）：${htmlEsc(clean(why, 120))}`
        if (viaMenu) {
          await showMenuView(cchat, "think", { clickedMid: mid, note })
          return
        }
        if (mid) await editTextRaw(cchat, mid, note, [], false)
        return
      }
      await answer(`已切换 ${hit.id}`)
      if (viaMenu) {
        await showMenuView(cchat, "think", {
          clickedMid: mid,
          note: `✅ 已切换 → <b>${htmlEsc(thinkLabel(hit))}</b>（下次生成生效）`,
        })
        return
      }
      const text3 = `${thinkMenuText(hit.id, cache.vs, cache.label)}\n✅ 已切换 → <b>${htmlEsc(thinkLabel(hit))}</b>（下次生成生效）`
      const kb3 = buildThinkKeyboard(cache.vs, hit.id)
      if (mid) {
        const r = await editTextRaw(cchat, mid, text3, kb3, false)
        if (r.r !== "sent") await sendTextRaw(cchat, text3, kb3, false)
      }
      return
    }
    if (parts[0] === "flt") {
      const sub = parts[1] ?? ""
      const fltMid = Number(cq?.message?.message_id ?? 0)
      if (sub === "done") {
        await answer("已返回")
        // R2637：「完成」不再另发/收掉一张独立过滤卡，而是回到唯一菜单消息的推送页。
        await showMenuView(cchat, "push", { clickedMid: fltMid })
        return
      }
      if (sub === "all") {
        const v = parts[2] === "0" ? 0 : 2;
        (Object.keys(filters) as Array<"reply" | "think" | "tool" | "status">).forEach((k) => { filters[k] = v as 0 | 2 });
        savePersistedState()
      } else if (sub === "compact") {
        const which = parts[2] ?? ""
        if (which === "auto") {
          compactPrefs.auto = !compactPrefs.auto
          savePersistedState()
        } else if (which === "th") {
          const i = COMPACT_TH_STEPS.indexOf(compactPrefs.threshold as (typeof COMPACT_TH_STEPS)[number])
          compactPrefs.threshold = COMPACT_TH_STEPS[(i + 1) % COMPACT_TH_STEPS.length]!
          savePersistedState()
        } else if (which === "notice") {
          // R719：压缩通知发送开关（默认开）
          compactPrefs.notice = !compactPrefs.notice
          savePersistedState()
        } else {
          await answer("未知按钮")
          return
        }
      } else if (sub === "inject") {
        if ((parts[2] ?? "") === "mode") {
          injectMode = injectMode === "idle" ? "now" : "idle"
          savePersistedState()
        } else {
          await answer("未知按钮")
          return
        }
      } else if (sub === "merge") {
        // R2674：仅标题卡片合并开关（本 Bot 独立）。切换后立刻清空链条，
        // 避免用已积累的旧状态继续合并。状态随本 Bot 的 tg-chats 文件落盘。
        titleMergeOn = !titleMergeOn
        titleMergeChains.clear()
        savePersistedState()
      } else if (sub === "reply" || sub === "think" || sub === "tool" || sub === "status") {
        setFilt(sub, (filt(sub) + 1) % 3)
      } else {
        await answer("未知按钮")
        return
      }
      const label = sub === "compact" ? "🗜已更新" : sub === "inject" ? "💉已更新" : sub === "merge" ? "🧠已更新" : `${FILT_NAME[sub === "all" ? "reply" : sub] ?? ""}已更新`
      await answer(label)
      // R2637：过滤设置页就是菜单消息本身；旧独立过滤卡被点时收敛到锚点并删旧卡。
      await showMenuView(cchat, "pushfilt", { clickedMid: fltMid, note: label })
      await log("info", `cb filter -> ${sanitizeLog(sub)}`)
      return
    }
    if (parts[0] === "use" && parts[1] && parts[1].startsWith("ses_")) {
      const id = parts[1]
      // R1837：与文本 /use 同一不变量（R1829）—— 只接受列表里**真实存在**的会话。
      // 此前回调只校验 `ses_` 前缀：会话被删除后，早年渲染的旧按钮仍可把前台钉到死会话，
      // 表现为"切过去后消息发不出去"（正是 R1819「不能正确选择会话」的回调侧残留）。
      // 保守放行：refreshSessionTitles 失败/列表为空时 sessionIdAcceptable 返回 true，不误伤。
      const listOk = await refreshSessionTitles()
      if (!sessionIdAcceptable(id, cachedSessionList.map((s) => s.id), listOk)) {
        await answer("会话不存在")
        await reply(cchat, `❌ 会话不存在：${id.slice(0, 12)}（可能已删除；用 /sessions 查看列表）`)
        return
      }
      const prev = fixedTarget ?? frontSessionID ?? persistedFront
      fixedTarget = id
      persistedFront = id
      // R2627：显式切换必须同步内存前台。旧实现只写 fixedTarget/persistedFront，
      // 循环停止时 protoSend 仍拿旧 frontSessionID 判断，刚切过去的会话会被静默拦掉。
      frontSessionID = id
      // 切换后旧会话默认加入附加镜像：否则用户切走后就再也收不到旧会话的消息
      // （表现为“切换另一个会话后不能发送信息给我”）。只发最终正文，标题带 📌 标识。
      const keep = prev && prev !== id ? keepWatched(prev) : ""
      savePersistedState()
      // R1065：切会话继承循环登记 —— 旧前台在循环名单则新前台一并登记，
      // 否则 /use 切到新会话后 auto-continue 一直 loop=no，表现为"Bot 不主动发消息"。
      if (prev && prev !== id) {
        const loopList = readIdList(LOOP_SESSIONS_FILE)
        const loopOff = readIdList(LOOP_OFF_FILE)
        if (loopList.includes(prev) && !loopOff.includes(id) && !loopList.includes(id)) {
          const e2 = writeIdList(LOOP_SESSIONS_FILE, [...loopList, id])
          if (e2) await log("warn", `use inherit loop write failed: ${e2}`)
          else await log("info", `use inherit loop scope ${prev.slice(0, 12)} -> ${id.slice(0, 12)}`)
        }
      }
      await answer("已切换")
      const nm = sessionNameOf(id) || id.slice(0, 12)
      const keepLine = keep ? `\n📎 旧会话已加入附加镜像（只发最终正文，📌 前缀）：${keep}` : ""
      await reply(cchat, `📌 已钉选会话：${clean(nm, 40)} (${id.slice(0, 12)})${keepLine}`)
      await log("info", `cb use -> ${id.slice(0, 12)}${keep ? ` (kept ${keep})` : ""}`)
      return
    }
    if (parts[0] === "wch" && parts[1] && parts[1].startsWith("ses_")) {
      // R2662：附加镜像的按钮入口（/watch 的菜单版）。点已镜像的会话 = 取消。
      const id = parts[1]
      const listOk = await refreshSessionTitles()
      if (!sessionIdAcceptable(id, cachedSessionList.map((s) => s.id), listOk)) {
        await answer("会话不存在")
        await reply(cchat, `❌ 会话不存在：${id.slice(0, 12)}（可能已删除；用 /sessions 查看列表）`)
        return
      }
      if (watchedSessions.has(id)) {
        watchedSessions.delete(id)
        forEachProto(id, (k) => protoMap.delete(k))
        savePersistedState()
        await answer("已取消镜像")
        await log("info", `cb wch off -> ${id.slice(0, 12)}`)
      } else {
        if (isPrimaryPush(id)) {
          await answer("当前目标已全量推送")
          return
        }
        if (watchedSessions.size >= WATCH_MAX) {
          await answer(`镜像已满（${WATCH_MAX}）`)
          return
        }
        watchedSessions.add(id)
        savePersistedState()
        await answer("已加入镜像")
        await log("info", `cb wch on -> ${id.slice(0, 12)}`)
      }
      await showMenuView(cchat, "pushwatch", { clickedMid: Number(cq?.message?.message_id ?? 0) || 0 })
      return
    }
    if (parts[0] === "stop") {
      const kind = parts[1] ?? ""
      const sidArg = parts[2] ?? ""
      const fidArg = parts[3] ?? ""
      const target = sidArg && sidArg.startsWith("ses_") ? sidArg : (fixedTarget ?? (await activeFront()))
      if (!target) {
        await answer("无会话")
        return
      }
      const r = await doStop(target)
      const ok = r.startsWith("[tg-bridge] stopped")
      await answer(ok ? "已停止" : "停止失败")
      await reply(cchat, r)
      await log("info", `cb stop -> ${sanitizeLog(r).slice(0, 60)}`)
      // 点了即扒停止行：按kind重建剩余键（ask卡片选项不可重建，保留）
      const qmid = Number(cq?.message?.message_id ?? 0)
      if (ok && qmid) {
        let rows: unknown[][] | null = null
        if (kind === "m") rows = [[{ text: "🔄 重试", callback_data: "retry" }]]
        else if (kind === "t") rows = fidArg ? [[{ text: "📄 看完整版", callback_data: `full:${fidArg}` }]] : []
        else if (kind === "h" || kind === "s") rows = []
        else if (kind === "") rows = []
        if (rows !== null) {
          try {
            await tgFetch("editMessageReplyMarkup", { chat_id: Number(cchat) || cchat, message_id: qmid, reply_markup: { inline_keyboard: rows } })
          } catch {
            /* best-effort */
          }
        }
      }
      return
    }
    if (parts[0] === "retry") {
      const bar = pinnedBar.get(cchat)
      const target = (bar?.sid) ?? fixedTarget ?? (await activeFront())
      if (!target) {
        await answer("无会话")
        return
      }
      const last = lastInject.get(target)
      if (!last) {
        await answer("无可重发内容")
        return
      }
      await answer("已排队")
      await queueAndPump(cchat, target, last, "")
      await log("info", `cb retry -> ${target.slice(0, 12)} queued`)
      return
    }
    if (parts[0] === "qpin") {
      // R1871：菜单「📡 队列置顶」原先与「📋 查看队列」同绑 `ma:queue`（点哪个都只是看队列），
      // 文案承诺"置顶"却无实际动作 —— 两个并列按钮行为相同是死按钮。这里改成真实触发
      // 队列置顶卡刷新（与自动路径同一函数），并如实回报队列是否为空。
      const n = pinQueue.length + outQueue.length
      if (n === 0) {
        await answer("队列为空，无需置顶")
        return
      }
      void refreshQueuePin()
      await answer(`已请求刷新队列置顶（${n} 条）`)
      await log("info", `cb qpin -> refresh requested (queued=${n})`)
      return
    }
    if (parts[0] === "full" && parts[1]) {
      const entry = fullTextStore.get(parts[1])
      if (!entry) {
        await answer(await refreshExpired(cchat, parts[1], Number(cq?.message?.message_id ?? 0)))
        return
      }
      // ⚠️ 只有**一条装得下**才走 edit 路。`editTextRaw` 内部按 PUSH_MAX(3800) 截断，
      // 而全文可达 `TOOL_OUT_FULL = 30000` → 截断了却回你「已展开」，那是**假成功**
      // （与今晚修的 stop / 压缩通知同一族：不许把没做到的事说成做到了）。
      // 超长就落到下面的分片路，并如实说明。
      const msgID = entry.full.length <= PUSH_MAX ? Number(cq?.message?.message_id ?? 0) : 0
      if (msgID) {
        const r = await editTextRaw(cchat, msgID, entry.full, [[{ text: "✂️ 看缩略版", callback_data: `fold:${parts[1]}` }]])
        await log("info", `cb full edit ${r.r} (len=${entry.full.length})`)
        if (r.r === "sent") {
          const kk = fullKeyStore.get(parts[1])?.key
          if (kk && strippedKb.delete(kk)) savePersistedState()
          await answer("已展开")
          return
        }
      }
      // 分片路必须**主动去排版**：原文是 HTML，按 3800 切片后每片都会被 `balanceHtmlTags`
      // 逐片处理 —— 片首的落单闭标签被删、片尾的开标签被补 → 代码块跨片彻底散架。
      // 与其让用户看到一堵被撕碎的排版，不如给纯文本并**说明**为什么。
      // R1840：**只剥标签、不还原实体**。原文里的字面 `<` 本就以 `&lt;` 存储；旧实现把它
      // 还原成裸 `<` 再以 HTML parse_mode 发送 → TG 400，而降级分支的 `/<[^>]*>/g` 会把这
      // 段内容**整段删掉**（点了「看完整版」反而丢内容）。保留实体则 TG 按字面渲染 `<`，零丢失。
      const htmlToPlain = (t: string): string => t.replace(/<[^>]*>/g, "")
      const full = htmlToPlain(entry.full)
      const chunks: string[] = []
      let cur = ""
      const push = (): void => {
        if (cur) chunks.push(cur)
        cur = ""
      }
      for (const ln of full.split("\n")) {
        if (ln.length > 3800) {
          push()
          // R1840：用 safeHtmlCut 保证不把实体（`&amp;` 等）劈成两半；否则片尾 `&am`
          // 无 `<`，发送 400 时降级分支（要求含 `<`）不触发 → 该片被整片丢弃。
          for (let i = 0; i < ln.length; ) {
            const end = safeHtmlCut(ln, i, 3800)
            chunks.push(ln.slice(i, end))
            i = end
          }
          continue
        }
        if (cur && cur.length + 1 + ln.length > 3800) push()
        cur = cur ? `${cur}\n${ln}` : ln
      }
      push()
      // R1848：把"截断事实"如实告诉用户。旧实现硬 `slice(0, 10)`（≈38k 字符）却只说"分段发送"，
      // 一旦 entry.full 超过 10 片（长回复/长工具输出均可超过 TOOL_OUT_FULL=30000），第 11 片起
      // 被**静默丢弃** —— 与「看完整版」的语义、以及本模块 R1840 的「不许把没做到的事说成做到了」
      // 直接冲突。保留 10 片上限（防 TG 刷屏），但必须如实说明只发了前 N 片。
      const FULL_CHUNK_CAP = 10
      if (chunks.length > FULL_CHUNK_CAP) {
        await answer(`内容极长（共 ${chunks.length} 段），仅发送前 ${FULL_CHUNK_CAP} 段；其余请查看会话记录`)
      } else {
        await answer(`内容较长（${entry.full.length} 字），分段发送（已去掉排版以免跨片错乱）`)
      }
      for (const c of chunks.slice(0, FULL_CHUNK_CAP)) await sendQueued(cchat, c)
      return
    }
    if (parts[0] === "fold" && parts[1]) {
      const entry = fullTextStore.get(parts[1])
      if (!entry) {
        await answer(await refreshExpired(cchat, parts[1], Number(cq?.message?.message_id ?? 0)))
        return
      }
      const msgID = Number(cq?.message?.message_id ?? 0)
      if (!msgID) {
        await answer("收起失败")
        return
      }
      const r = await editTextRaw(cchat, msgID, entry.compact, [[{ text: "📄 看完整版", callback_data: `full:${parts[1]}` }]])
      if (r.r === "sent") {
        const kk = fullKeyStore.get(parts[1])?.key
        if (kk && strippedKb.delete(kk)) savePersistedState()
      }
      await answer(r.r === "sent" ? "已收起" : "消息过旧，无法收起")
      return
    }
    if (parts[0] === "qa" && parts[1]) {
      // 内联作答：`qa:<sid>|<答案>`。不依赖任何服务端状态，热重载后依然有效。
      // R1862：用 parseAskInline 重组被 `:` 拆散的答案（原 `parts[1]` 会在答案含冒号时截断）。
      const { sid, ans } = parseAskInline(data)
      if (!sid.startsWith("ses_") || !ans) {
        await answer("按钮数据已损坏，请直接发文字")
        return
      }
      await answer("已作为新消息发进会话（不会结束这次询问）")
      await queueAndPump(cchat, sid, ans, "")
      await log("info", `cb inline answer -> ${sid.slice(0, 12)} queued (as plain message, NOT a question answer)`)
      return
    }
    if (parts[0] === "qfree" && parts[1]) {
      await answer("请直接发送文字，我会把它作为你的答案发进会话；要结束这次询问请在 TUI 回答或点停止")
      await log("info", `cb qfree -> ${parts[1].slice(0, 12)} guidance only (host has no question-answer API)`)
      return
    }
    if (parts[0] === "q" && parts[1]) {
      const q = qMap.get(parts[1])
      if (!q) {
        await answer("问题已过期，直接发文字也行")
        return
      }
      qMap.delete(parts[1])
      // 如实措辞：这里**没有**"回答询问"这个动作，只是把选项作为新消息发了出去。
      // 旧文案"已作答"是误标（用户反馈"点按钮只是注入，不能结束问题对会话的占用"）。
      await answer("已作为新消息发进会话（不会结束这次询问）")
      await queueAndPump(cchat, q.sid, q.answer, "")
      await log("info", `cb answer -> ${q.sid.slice(0, 12)} queued (as plain message, NOT a question answer)`)
      return
    }
    await answer("未知按钮")
    } catch (err) {
      await log("error", `callback failed: ${sanitizeLog(err).slice(0, 160)}`)
      try {
        const qid2 = String((cq as any)?.id ?? "")
        if (qid2) await tgFetch("answerCallbackQuery", { callback_query_id: qid2, text: "处理失败" })
      } catch {
        /* ignore */
      }
    }
  }

  // R2634（运营者：“增加一个开关，在429后重新检测为200后使用fork修改当前机器人
  // 会话ID...”）：watcher 在 quota 复检返回 200 后写一个请求文件；拥有该会话的
  // 桥实例用原子 rename 认领，调用宿主 fork 复制完整历史，然后把所有指向旧 ID 的
  // 映射（front/pinned、loop-sessions、loop-ctl、loop-marker、inject-card）重映射
  // 到新 ID。除了会话 ID 外不改任何对话内容，也不重放聊天消息。
  const QUOTA_FORK_SWITCH = process.env.FORK_ON_QUOTA_200 !== "0"
  const QUOTA_FORK_MAX_AGE_MS = 10 * 60_000
  const quotaForkMine = (sid: string): boolean => {
    if (!isSessionId(sid)) return false
    if (fixedTarget === sid || persistedFront === sid || frontSessionID === sid) return true
    try {
      const j = JSON.parse(readFileSync(STATE_PATH, "utf8")) as any
      return j?.front === sid || j?.pinned === sid
    } catch {
      return false
    }
  }
  // 与 /fork 共用同一套宿主通路：_client → service.json + Basic 直连 → session.fork。
  // 抽出函数而不是复制两份，保证命令 fork 与自动 fork 的失败语义永远一致。
  const forkSessionByID = async (target: string, before?: string): Promise<{ nid: string; failure: string }> => {
    let nid = ""
    let failure = ""
    // 一旦某条通路已把请求交给宿主（拿到响应/受理），即使没解析出 id 也不再换通路，
    // 避免服务端其实已 fork 成功、这边又 fork 出第二份。
    let handled = false
    const forkBody = before ? { before } : {}
    const forkBase = (client as any)?._client
    if (typeof forkBase?.post === "function") {
      handled = true
      try {
        const r = await forkBase.post({
          url: `/api/session/${encodeURIComponent(target)}/fork`,
          body: forkBody,
        })
        const data = (r as any)?.data ?? (r as any)
        nid = String(data?.id ?? data?.sessionID ?? data?.data?.id ?? "")
        const apiErr = (r as any)?.error
        if (!nid) failure = apiErr ? sanitizeLog(apiErr?.message ?? apiErr).slice(0, 200) : "fork accepted but no session id returned"
      } catch (err) {
        handled = false
        failure = sanitizeLog(err).slice(0, 200)
        await log("warn", `fork via _client failed (sid=${sanitizeLog(target).slice(0, 12)}): ${failure}`)
      }
    }
    if (!nid && !handled) {
      try {
        const { url, password: pw } = await hostServiceReg()
        if (url && pw) {
          const token = Buffer.from(`opencode:${pw}`, "utf8").toString("base64")
          const r = await fetch(`${url}/api/session/${encodeURIComponent(target)}/fork`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Basic ${token}` },
            body: JSON.stringify(forkBody),
            signal: AbortSignal.timeout(15_000),
          })
          handled = true // 拿到 HTTP 响应 = 宿主已处理，不再走 SDK 重复 fork
          const raw = await r.text()
          if (r.ok) {
            let j: any = {}
            try {
              j = JSON.parse(raw || "{}")
            } catch {
              /* 非 JSON：下面按缺 id 处理 */
            }
            const data = j?.data ?? j
            nid = String(data?.id ?? data?.sessionID ?? data?.data?.id ?? "")
            if (!nid) failure = "fork accepted but no session id returned"
          } else {
            failure = `HTTP ${r.status}: ${safeCut(raw.replace(/\s+/g, " ").trim(), 160)}`
            await log("warn", `fork via HttpApi failed (sid=${sanitizeLog(target).slice(0, 12)}): ${failure}`)
          }
        }
      } catch (err) {
        handled = false
        failure = sanitizeLog(err).slice(0, 200)
        await log("warn", `fork via HttpApi error (sid=${sanitizeLog(target).slice(0, 12)}): ${failure}`)
      }
    }
    if (!nid && !handled) {
      const fn = (client as any)?.session?.fork
      if (typeof fn === "function") {
        try {
          const r = await fn.call((client as any).session, { sessionID: target, before })
          nid = String((r as any)?.id ?? (r as any)?.sessionID ?? (r as any)?.data?.id ?? "")
        } catch (err) {
          failure = sanitizeLog(err).slice(0, 200)
        }
      } else {
        failure = "fork API unavailable (compat too old)"
      }
    }
    return { nid, failure }
  }

  const writeQuotaForkRemap = (oldSid: string, newSid: string): boolean => {
    try {
      mkdirSync(QUOTA_FORK_REMAP_DIR, { recursive: true })
      // 每对 old→new 一个文件：兄弟 Bot 同时 fork 不同会话时不会互相覆盖。
      atomicWrite(
        `${QUOTA_FORK_REMAP_DIR}/${oldSid}.json`,
        JSON.stringify({ old: oldSid, new: newSid, ts: Date.now(), by: BOT_ID }),
        PRIVATE_FILE_MODE,
      )
      return true
    } catch (err) {
      void log("warn", `quota fork remap write failed (old=${sanitizeLog(oldSid).slice(0, 12)}): ${sanitizeLog(err).slice(0, 120)}`)
      return false
    }
  }

  const writeQuotaForkLast = (o: Record<string, unknown>): void => {
    try {
      mkdirSync(QUOTA_FORK_DIR, { recursive: true })
      atomicWrite(`${QUOTA_FORK_DIR}/last.json`, JSON.stringify({ at: Date.now(), ...o }), PRIVATE_FILE_MODE)
    } catch {
      /* best-effort */
    }
  }

  // 把磁盘上所有“机器人 → 会话”的映射从旧 ID 换成新 ID。兄弟 Bot 的桥会用
  // remap 文件同步内存；这里直接改文件，覆盖“兄弟实例恰好不在线/正在重启”的窗口。
  const remapQuotaForkFiles = (oldSid: string, newSid: string): void => {
    let stateFiles: string[] = []
    try {
      stateFiles = globSync(`REDACTED_ROOT/.config/opencode/tg-chats*.json`)
    } catch {
      stateFiles = []
    }
    for (const p of stateFiles) {
      try {
        const j = JSON.parse(readFileSync(p, "utf8")) as any
        let changed = false
        if (j?.front === oldSid) {
          j.front = newSid
          changed = true
        }
        if (j?.pinned === oldSid) {
          j.pinned = newSid
          changed = true
        }
        if (Array.isArray(j?.watch) && j.watch.includes(oldSid)) {
          j.watch = [...new Set(j.watch.map((x: unknown) => (x === oldSid ? newSid : x)))]
          changed = true
        }
        if (j?.bar && typeof j.bar === "object" && !Array.isArray(j.bar)) {
          for (const v of Object.values(j.bar) as any[]) {
            if (v && typeof v === "object" && v.sid === oldSid) {
              v.sid = newSid
              changed = true
            }
          }
        }
        if (Array.isArray(j?.qmap)) {
          for (const item of j.qmap) {
            if (Array.isArray(item) && item[1] && typeof item[1] === "object" && item[1].sid === oldSid) {
              item[1].sid = newSid
              changed = true
            }
          }
        }
        if (changed) atomicWrite(p, JSON.stringify(j), PRIVATE_FILE_MODE)
      } catch {
        /* 单个状态文件损坏不影响其余映射 */
      }
    }
    // 循环名单：只改明确登记过的状态。旧会话若在正向名单里，换成新 ID 后把
    // 旧 ID 放进否定名单，阻止 auto-continue 的 sticky 内存把旧会话又并回来。
    try {
      const list = readIdList(LOOP_SESSIONS_FILE)
      const off = readIdList(LOOP_OFF_FILE)
      const wasLoop = list.includes(oldSid)
      const wasOff = off.includes(oldSid)
      if (wasOff) {
        writeIdList(LOOP_OFF_FILE, [...off.filter((x) => x !== oldSid && x !== newSid), newSid])
        writeIdList(LOOP_SESSIONS_FILE, list.filter((x) => x !== oldSid && x !== newSid))
      } else if (wasLoop) {
        writeIdList(LOOP_SESSIONS_FILE, [...list.filter((x) => x !== oldSid && x !== newSid), newSid])
        writeIdList(LOOP_OFF_FILE, [...off.filter((x) => x !== oldSid && x !== newSid), oldSid])
      }
    } catch (err) {
      void log("warn", `quota fork loop list remap failed: ${sanitizeLog(err).slice(0, 120)}`)
    }
    // [LOOP] 标题标记：旧会话在标记集合里时，把标记转给新会话。
    try {
      const p = `REDACTED_ROOT/.config/opencode/loop-marker.json`
      const j = JSON.parse(readFileSync(p, "utf8")) as any
      let changed = false
      if (Array.isArray(j?.sids) && j.sids.includes(oldSid)) {
        j.sids = [...new Set(j.sids.map((x: unknown) => (x === oldSid ? newSid : x)))]
        changed = true
      } else if (j?.sid === oldSid) {
        j.sid = newSid
        changed = true
      }
      if (changed) {
        j.ts = Date.now()
        atomicWrite(p, JSON.stringify(j), PRIVATE_FILE_MODE)
      }
    } catch {
      /* 无 marker 文件 = 没有需要迁移的标题标记 */
    }
    // loop-ctl：只替换 sids 里的旧 ID；stopped/by/reason 原样保留。
    const ctl = mutateLoopCtlFile((j) => {
      if (!j.bots || typeof j.bots !== "object") return
      for (const k of Object.keys(j.bots)) {
        const e = j.bots[k]
        if (!e || typeof e !== "object" || !Array.isArray(e.sids)) continue
        if (!e.sids.includes(oldSid)) continue
        e.sids = e.sids.map((x: unknown) => (x === oldSid ? newSid : x))
      }
    })
    if (ctl === "err") void log("warn", `quota fork loop-ctl remap FAILED (old=${sanitizeLog(oldSid).slice(0, 12)})`)
    // 注入状态卡的 lastSid 只是兜底显示；一并改掉，避免卡上短暂显示旧 ID。
    let cardFiles: string[] = []
    try {
      cardFiles = globSync(`REDACTED_ROOT/.config/opencode/inject-card-*.json`)
    } catch {
      cardFiles = []
    }
    for (const p of cardFiles) {
      try {
        const j = JSON.parse(readFileSync(p, "utf8")) as any
        if (j?.lastSid !== oldSid) continue
        j.lastSid = newSid
        atomicWrite(p, JSON.stringify(j), PRIVATE_FILE_MODE)
      } catch {
        /* best-effort */
      }
    }
  }

  const applyQuotaForkRemapToMemory = (): void => {
    const maps = readQuotaForkRemaps()
    if (!maps.length) return
    let changed = false
    for (const r of maps) {
      if (fixedTarget === r.old) {
        fixedTarget = r.new
        changed = true
      }
      if (persistedFront === r.old) {
        persistedFront = r.new
        changed = true
      }
      if (frontSessionID === r.old) {
        frontSessionID = r.new
        changed = true
      }
      for (const v of pinnedBar.values()) {
        if (v.sid === r.old) {
          v.sid = r.new
          changed = true
        }
      }
      if (watchedSessions.delete(r.old)) {
        watchedSessions.add(r.new)
        changed = true
      }
      for (const v of qMap.values()) {
        if (v.sid === r.old) {
          v.sid = r.new
          changed = true
        }
      }
    }
    if (!changed) return
    savePersistedState()
    for (const r of maps) {
      void log(
        "info",
        `quota fork remap adopted (bot=${BOT_ID}, by=${r.by || "?"}): ${sanitizeLog(r.old).slice(0, 12)} -> ${sanitizeLog(r.new).slice(0, 12)}`,
      )
    }
  }

  let quotaForkBusy = false
  const processQuotaForkRequests = async (): Promise<void> => {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    // remap 先于开关判断：即使运营者刚把开关关掉，已经完成的 fork 仍必须把
    // 兄弟 Bot 的内存/磁盘映射收敛到新 ID。
    applyQuotaForkRemapToMemory()
    if (!QUOTA_FORK_SWITCH || quotaForkBusy) return
    let names: string[] = []
    try {
      names = readdirSync(QUOTA_FORK_DIR)
    } catch {
      return
    }
    const now = Date.now()
    for (const name of names.sort()) {
      if (!/^\d+-ses_[A-Za-z0-9_-]+-\d+\.json$/.test(name)) continue
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      const path = `${QUOTA_FORK_DIR}/${name}`
      let req: any = null
      try {
        req = JSON.parse(readFileSync(path, "utf8"))
      } catch {
        continue
      }
      const sid = String(req?.sid ?? "")
      const ts = Number(req?.ts ?? 0)
      if (!isSessionId(sid)) {
        try {
          unlinkSync(path)
        } catch {
          /* ignore */
        }
        continue
      }
      if (!Number.isFinite(ts) || ts <= 0 || now - ts > QUOTA_FORK_MAX_AGE_MS) {
        try {
          unlinkSync(path)
        } catch {
          /* ignore */
        }
        await log("info", `quota fork request expired (sid=${sanitizeLog(sid).slice(0, 12)}, age=${Math.round((now - ts) / 1000)}s)`)
        continue
      }
      // 只有真正拥有该会话的 Bot 才认领；同一会话被 primary/bot5 共享时，
      // 原子 rename 保证只有一个实例调用 fork。
      if (!quotaForkMine(sid)) continue
      const claimed = `${path}.claimed-${BOT_ID.replace(/[^a-z0-9_-]/gi, "_")}-${process.pid}`
      try {
        renameSync(path, claimed)
      } catch {
        continue
      }
      quotaForkBusy = true
      try {
        if (!quotaForkMine(sid)) {
          // 认领后归属变了（兄弟实例刚完成 remap）：把请求放回去，让新 owner 处理。
          try {
            renameSync(claimed, path)
          } catch {
            /* ignore */
          }
          await log("info", `quota fork request released: ${sanitizeLog(sid).slice(0, 12)} is no longer this bot's front/pinned`)
          continue
        }
        await log(
          "info",
          `quota fork begin (bot=${BOT_ID}, sid=${sanitizeLog(sid).slice(0, 12)}, upstream=${sanitizeLog(String(req?.upstream ?? "?"))}, msg_at=${sanitizeLog(String(req?.msg_at ?? "?"))}, reason=${sanitizeLog(String(req?.reason ?? "?"))})`,
        )
        await automationStart("fork", `会话：${sid.slice(0, 12)}`)
        const { nid, failure } = await forkSessionByID(sid)
        if (!nid) {
          writeQuotaForkLast({ ok: false, sid, failure: failure || "no session id returned", by: BOT_ID, request: req })
          await log("error", `quota fork failed (sid=${sanitizeLog(sid).slice(0, 12)}): ${failure || "no session id returned"}`)
          await automationEnd("fork", false, `会话 ${sid.slice(0, 12)} 保持不变；${failure || "宿主未返回新会话 ID"}`)
          const chat = pushChatResolve()
          if (chat) {
            await reply(
              chat,
              `⚠️ 429 复检返回 200，但 fork 失败：${sid.slice(0, 12)} → (无新会话)\n${failure || "宿主未返回新会话 ID"}\n会话 ID 未更改。`,
            )
          }
          continue
        }
        const remapOk = writeQuotaForkRemap(sid, nid)
        if (remapOk) {
          applyQuotaForkRemapToMemory()
        } else {
          // remap 文件写不进去（磁盘满/权限）时，至少让本实例自己收敛，避免
          // 下一次 save 把旧 front 写回文件。
          if (fixedTarget === sid) fixedTarget = nid
          if (persistedFront === sid) persistedFront = nid
          if (frontSessionID === sid) frontSessionID = nid
        }
        remapQuotaForkFiles(sid, nid)
        writeQuotaForkLast({ ok: true, sid, newSid: nid, by: BOT_ID, request: req })
        const chat = pushChatResolve()
        if (chat) {
          await reply(
            chat,
            [
              "🧬 429 复检返回 200，已 fork 当前会话",
              "会话 ID 已更改：",
              `旧 ID：${sid}`,
              `新 ID：${nid}`,
              "完整历史已复制；机器人映射与自动循环已切到新会话（除会话 ID 外没有其他改变）。",
            ].join("\n"),
          )
        }
        await log(
          "info",
          `quota fork done (bot=${BOT_ID}, old=${sanitizeLog(sid).slice(0, 12)}, new=${sanitizeLog(nid).slice(0, 12)}, egress=${sanitizeLog(String(req?.egress ?? "?"))}, msg_at=${sanitizeLog(String(req?.msg_at ?? "?"))})`,
        )
        await automationEnd("fork", true, `旧 ${sid.slice(0, 12)} → 新 ${nid.slice(0, 12)}`)
      } catch (err) {
        writeQuotaForkLast({ ok: false, sid, failure: sanitizeLog(err).slice(0, 200), by: BOT_ID, request: req })
        await log("error", `quota fork exception (sid=${sanitizeLog(sid).slice(0, 12)}): ${sanitizeLog(err).slice(0, 200)}`)
        await automationEnd("fork", false, sanitizeLog(err).slice(0, 160))
      } finally {
        quotaForkBusy = false
        try {
          unlinkSync(claimed)
        } catch {
          /* ignore */
        }
      }
    }
  }

  // R2649/R2700 (operator: "在429后自动创建新会话，切换并且注入：
  // 阅读（原会话id）对话历史，继续任务 的提示词")。
  // The workflow writes one durable request for the earliest 429 session as
  // soon as it has evidence (streak >= 1, reset to 0 after the switch).
  // Claiming with an atomic rename guarantees a shared session is rolled over
  // exactly once. Unlike R2634 (fork), this creates an
  // EMPTY session and asks it to read the old history, per the operator's wording.
  const ROLLOVER_SWITCH = process.env.ROLLOVER_ON_429 !== "0"
  let rolloverBusy = false
  let rolloverSkipLoggedAt = 0
  // A failed create is not retried in this process (no 2s hot loop / no TG spam);
  // the request is put back so the next run tries again.
  const rolloverFailed = new Set<string>()
  const createRolloverSession = async (oldSid: string): Promise<{ nid: string; failure: string }> => {
    const fn = (client as any)?.session?.createSession
    if (typeof fn !== "function") return { nid: "", failure: "createSession unavailable (compat too old)" }
    try {
      const r = await fn.call((client as any).session, { title: `续-${oldSid.slice(0, 8)}` })
      const nid = String((r as any)?.id ?? (r as any)?.sessionID ?? (r as any)?.data?.id ?? "")
      // R2658：换会话不换模型 —— 新会话沿用旧会话当前选择的模型/思考档位。
      if (nid) await inheritSessionModel(nid, oldSid)
      return nid ? { nid, failure: "" } : { nid: "", failure: "create returned no id" }
    } catch (err) {
      return { nid: "", failure: sanitizeLog(err).slice(0, 200) }
    }
  }
  const injectRolloverPrompt = async (newSid: string, oldSid: string): Promise<{ ok: boolean; failure: string }> => {
    const text = `阅读（${oldSid}）对话历史，继续任务`
    try {
      await client.session.promptAsync({
        path: { id: newSid },
        body: { parts: [{ type: "text", text }], resume: true, delivery: "queue" },
      })
      return { ok: true, failure: "" }
    } catch (err) {
      return { ok: false, failure: sanitizeLog(err).slice(0, 200) }
    }
  }
  // R2656: shared by the durable-request consumer and the manual TG button.
  // The caller owns the rolloverBusy guard. `restore` puts the claimed request
  // back when creating the new session fails (automatic path); manual requests
  // are removed by the button handler instead so a failed click cannot hot-loop.
  const rolloverSession = async (
    sid: string,
    req: any,
    restore?: () => void,
  ): Promise<{ ok: boolean; nid: string; failure: string }> => {
    const manual = req?.manual === true
    await automationStart("rollover", `旧会话：${sid.slice(0, 12)}`)
    try {
      const { nid, failure } = await createRolloverSession(sid)
      if (!nid) {
        restore?.()
        await log("error", `429 rollover create failed (old=${sanitizeLog(sid).slice(0, 12)}, manual=${manual ? "yes" : "no"}): ${failure}`)
        await automationEnd(
          "rollover",
          false,
          manual ? `旧会话 ${sid.slice(0, 12)} 保持不变；可再次点击重试` : `旧会话 ${sid.slice(0, 12)} 保持不变；下一轮重试`,
        )
        const chat = pushChatResolve()
        if (chat) {
          await reply(
            chat,
            manual
              ? `⚠️ 手动 429 换会话：新建会话失败，旧回合已停止，仍使用原会话 ${sid.slice(0, 12)}\n${failure}`
              : `⚠️ 429 换会话：新建会话失败，仍使用原会话 ${sid.slice(0, 12)}（下一轮重试）\n${failure}`,
          )
        }
        return { ok: false, nid: "", failure }
      }
      // Reuse the R2634 remap kernel: every bot/loop mapping that points at the
      // old session now points at the new one, and the old loop entry moves to
      // the off list so auto-continue's sticky set cannot pull it back.
      const remapOk = writeQuotaForkRemap(sid, nid)
      if (remapOk) {
        applyQuotaForkRemapToMemory()
      } else {
        // remap 文件写不进去（磁盘满/权限）时，至少让本实例自己收敛；只在
        // 旧 ID 确实是当前绑定目标时替换，保留用户原本的 pin/unpin 语义。
        if (fixedTarget === sid) fixedTarget = nid
        if (persistedFront === sid) persistedFront = nid
        if (frontSessionID === sid) frontSessionID = nid
      }
      remapQuotaForkFiles(sid, nid)
      savePersistedState()
      const inj = await injectRolloverPrompt(nid, sid)
      const chat = pushChatResolve()
      if (chat) {
        await reply(
          chat,
          [
            manual ? "🔄 手动 429 换会话，已创建新会话并切换" : "🔄 本轮有 429，已换新会话并切换",
            `旧 ID：${sid}`,
            `新 ID：${nid}`,
            `注入：阅读（${sid}）对话历史，继续任务`,
            inj.ok ? "提示词已排队，任务将在新会话继续。" : `⚠️ 提示词注入失败：${inj.failure}`,
          ].join("\n"),
        )
      }
      await log(
        "info",
        `429 rollover done (bot=${BOT_ID}, old=${sanitizeLog(sid).slice(0, 12)}, new=${sanitizeLog(nid).slice(0, 12)}, manual=${manual ? "yes" : "no"}, inject=${inj.ok ? "ok" : "failed"})`,
      )
      await automationEnd("rollover", inj.ok, inj.ok ? `旧 ${sid.slice(0, 12)} → 新 ${nid.slice(0, 12)}` : `已切到 ${nid.slice(0, 12)}，但提示词注入失败`)
      return { ok: inj.ok, nid, failure: inj.failure }
    } catch (err) {
      await log("error", `429 rollover exception (old=${sanitizeLog(sid).slice(0, 12)}): ${sanitizeLog(err).slice(0, 200)}`)
      await automationEnd("rollover", false, sanitizeLog(err).slice(0, 160))
      return { ok: false, nid: "", failure: sanitizeLog(err).slice(0, 200) }
    }
  }

  const processRolloverRequests = async (): Promise<void> => {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    // R2650：全局开关（repo variable）与每 Bot 开关都必须为开；关闭时请求保留，
    // 由 CI 侧跳过该 Bot，最多 24h 后自然过期。
    if (!ROLLOVER_SWITCH || !rolloverOn429 || rolloverBusy) return
    let names: string[] = []
    try {
      names = readdirSync(ROLLOVER_REQUEST_DIR)
    } catch {
      return
    }
    const now = Date.now()
    for (const name of names.sort()) {
      if (!/^ses_[A-Za-z0-9_-]+\.json$/.test(name)) continue
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      const path = `${ROLLOVER_REQUEST_DIR}/${name}`
      let req: any = null
      try {
        req = JSON.parse(readFileSync(path, "utf8"))
      } catch {
        continue
      }
      const sid = String(req?.sid ?? name.replace(/\.json$/, ""))
      const ts = Number(req?.ts ?? 0)
      const manual = req?.manual === true
      if (!isSessionId(sid)) {
        try {
          unlinkSync(path)
        } catch {
          /* ignore */
        }
        continue
      }
      if (!Number.isFinite(ts) || ts <= 0 || now - ts > ROLLOVER_REQUEST_MAX_AGE_MS) {
        try {
          unlinkSync(path)
        } catch {
          /* ignore */
        }
        await log("info", `429 rollover request expired (sid=${sanitizeLog(sid).slice(0, 12)}, age=${Math.round((now - ts) / 1000)}s)`)
        continue
      }
      // Only the bot that currently owns the session rolls it over; a shared
      // session produces one claim because rename() is atomic.
      if (!quotaForkMine(sid)) continue
      if (rolloverFailed.has(sid)) continue
      if (!manual && (loopStopped() || haltedSet.has(sid))) {
        // Respect an explicit stop (loop gate or the session's ⏹). Keep the
        // request so a later /loop start can still continue the task; log at
        // most once per 5 minutes. Manual requests are exempt: the button
        // itself stopped the old turn and the user explicitly asked to switch.
        if (now - rolloverSkipLoggedAt > 5 * 60_000) {
          rolloverSkipLoggedAt = now
          await log(
            "info",
            `429 rollover waiting: ${loopStopped() ? "loop is stopped" : "session is halted"} for ${sanitizeLog(sid).slice(0, 12)} (request kept)`,
          )
        }
        continue
      }
      const claimed = `${path}.claimed-${BOT_ID.replace(/[^a-z0-9_-]/gi, "_")}-${process.pid}`
      try {
        renameSync(path, claimed)
      } catch {
        continue
      }
      rolloverBusy = true
      try {
        if (!quotaForkMine(sid)) {
          // Ownership changed between listing and claim (a sibling remapped it).
          try {
            renameSync(claimed, path)
          } catch {
            /* ignore */
          }
          continue
        }
        await log(
          "info",
          `429 rollover begin (bot=${BOT_ID}, old=${sanitizeLog(sid).slice(0, 12)}, manual=${manual ? "yes" : "no"}, reason=${sanitizeLog(String(req?.reason ?? "?"))}, run=${sanitizeLog(String(req?.run ?? "?"))})`,
        )
        const restore = (): void => {
          rolloverFailed.add(sid)
          try {
            renameSync(claimed, path)
          } catch {
            /* best-effort: losing the request only costs a manual /new */
          }
        }
        await rolloverSession(sid, req, restore)
      } finally {
        rolloverBusy = false
        try {
          unlinkSync(claimed)
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * R2656 (operator: "为429换回合添加一个人工触发按钮，并且触发后保证旧回合为停止状态。
   * 与额度尾恢复不同时触发（排斥），优先429换会话").
   *
   * Manual rollover is deliberately two-phase:
   *   1. write the durable request first (crash recovery + cross-run marker so
   *      select-egress-step.sh suppresses quota-tail recovery for this session),
   *   2. stop AND verify the old turn, aborting without switching if the turn
   *      could not be confirmed stopped.
   * Only then create the new session and inject the continue prompt. doStop()
   * halts just this session (not the bot-wide loop), so after the remap the new
   * session can continue normally.
   */
  const manualRolloverNow = async (chatID: string): Promise<void> => {
    if (!ROLLOVER_SWITCH) {
      await reply(chatID, "[tg-bridge] 🔄 429 换会话被全局开关 ROLLOVER_ON_429=0 禁用（repo variable）")
      return
    }
    if (rolloverBusy) {
      await reply(chatID, "[tg-bridge] 🔄 已有一个 429 换会话正在进行，请稍候")
      return
    }
    const target = fixedTarget || persistedFront || frontSessionID || (await activeFront())
    if (!target || !isSessionId(target)) {
      await reply(chatID, "[tg-bridge] no session to roll over")
      return
    }
    const req = {
      sid: target,
      ts: Date.now(),
      reason: "manual",
      manual: true,
      by: BOT_ID,
      run: process.env.GITHUB_RUN_ID ?? "",
    }
    const reqPath = `${ROLLOVER_REQUEST_DIR}/${target}.json`
    try {
      mkdirSync(ROLLOVER_REQUEST_DIR, { recursive: true })
      const tmp = `${reqPath}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(req), "utf8")
      renameSync(tmp, reqPath)
    } catch (err) {
      await reply(chatID, `[tg-bridge] ⚠️ 无法写入 429 换会话请求：${sanitizeLog(err).slice(0, 200)}`)
      return
    }
    rolloverBusy = true
    try {
      // Requirement: the old turn must be stopped before switching. doStop()
      // verifies the turn actually ended; on failure we abort and drop the
      // request instead of switching under a live turn.
      const diag = await doStop(target)
      if (!diag.startsWith("[tg-bridge] stopped")) {
        try {
          unlinkSync(reqPath)
        } catch {
          /* ignore */
        }
        await reply(chatID, `[tg-bridge] ❌ 429 换会话已取消：旧回合未确认停止，不会切换会话。\n${diag}`)
        return
      }
      await reply(chatID, `[tg-bridge] ⏹ 旧回合已停止（${target.slice(0, 12)}）；开始 429 换会话…`)
      await rolloverSession(target, req)
    } finally {
      rolloverBusy = false
      // The handler is synchronous with the user; if it got this far the
      // request has been consumed (or failed once), so remove it to avoid a
      // 2s hot retry loop. A process crash before finally leaves it durable.
      try {
        unlinkSync(reqPath)
      } catch {
        /* ignore */
      }
    }
  }

  const handleUpdateInner = async (u: any, opts?: { synthetic?: boolean }): Promise<void> => {
    const uid = Number(u?.update_id ?? 0)
    if (!Number.isFinite(uid)) return
    // 合成事件（菜单按钮把动作转成文本命令再喂回来）**不进真实去重环**。
    // 原因：去重环容量有上限且会落盘，若把合成 id 也塞进去，菜单点多了会把真实
    // update_id 挤出环外（或落盘截断），Telegram 重投同一条时就会被处理第二次 ——
    // 症状正是"同一条命令触发两次"。合成事件不会被 Telegram 重投，本来就不需要去重。
    if (!opts?.synthetic) {
      if (seenUpdates.has(uid)) {
        inboundCounters.droppedDupe++
        // R1836：已见过的重投也要把 offset 推过去。否则若上个实例恰在「写 seen 之后、
        // 提交 offset 之前」崩溃/被杀（两处 savePersistedState 之间的窗口），重启后 TG 会
        // 反复重投同一条：被去重环拦下却**从不提交 offset**，直到下一条真实 update 才前进。
        // 无新消息时形成静默空转（同一条 update 被无限拉取）。推进 offset 让重投确定性终止。
        // 语义安全：uid 既已在 seenUpdates，说明此前已处理/按 R1817 约定作废，不会造成重复副作用。
        commitOffset(uid)
        return
      }
      seenUpdates.add(uid)
    }
    // 记录本 Bot 真实处理到的计数：多 Bot 场景下可作为兄弟实例的 offset 基线，
    // 用于识别"offset 被写成别的 Bot 的计数空间"这种静默丢弃全部更新的故障。
    if (uid > (lastRealUpdateId ?? 0)) {
      lastRealUpdateId = uid
      savePersistedState()
    }
    if (seenUpdates.size > SEEN_RING_MAX) {
      const arr = [...seenUpdates].slice(-SEEN_RING_KEEP)
      seenUpdates.clear()
      for (const x of arr) seenUpdates.add(x)
    }
    commitOffset(uid)
    inboundCounters.total++
    if (u?.callback_query) {
      inboundCounters.callback++
      // R1892：与文本/编辑消息共用同一条白名单闸。旧缺口：非白名单 chat 的按钮点击
      // （callback_query）照常进 handleCallback —— 等于「按钮」通道比「文字」更宽松，
      // 而 ma:* 菜单动作还能合成文本消息喂入既有命令链（L6328 合成处）→ 白名单形同虚设。
      // 现回调先过 isAllowed；非白名单 → 计数 + info 留痕 + 丢弃（不再进处理链）。
      const qchat = u.callback_query.message?.chat
      if (qchat && !isAllowed(qchat)) {
        inboundCounters.droppedCallback++
        await log(
          "info",
          `update from non-whitelisted chat=${sanitizeLog(chatTarget(qchat))} ` +
            `(id=${sanitizeLog(String(qchat?.id ?? "")).slice(0, 16)}, callback, data=${sanitizeLog(String(u.callback_query?.data ?? "")).slice(0, 24)}) ignored`,
        )
        return
      }
      currentInbound = null
      await handleCallback(u.callback_query)
      return
    }
    const msg = u?.message ?? u?.edited_message
    if (!msg) {
      inboundCounters.droppedNoMessage++
      return
    }
    // R2682：用户消息、别的 Bot 的卡也会把聊天推进到新位置。标题合并链
    // 必须知道这件事，否则会把旧卡当成“最新”继续原地改写。
    // 放在 bot-sent/allowed 过滤之前：群聊里兄弟 Bot 的卡同样算新消息；
    // 编辑事件沿用原 message_id，max 语义不会让已知位置倒退。
    // R2683：最新位置要落盘，否则重启后旧链会被误判为“仍在底部”。
    // 只对允许的 chat 落盘，避免陌生群更新造成高频写。
    if (noteLatestChatMessage(chatTarget(msg.chat), msg?.message_id) && isAllowed(msg.chat)) savePersistedState()
    // R1059：bot 自己/兄弟 bot 发到群的消息（Shell 执行卡、ctx 提醒卡、HTML 片段等）
    // 不应被当成“用户输入”收进注入队列——此前这些卡文本会排队、把真实用户消息挤后。
    // 合成菜单事件不在此列（其 from.is_bot 显式为 false，见菜单动作合成处）。
    if (msg?.from && msg.from.is_bot === true) {
      inboundCounters.droppedBot++
      await log(
        "info",
        `tg bot-sent skip (chat=${sanitizeLog(chatTarget(msg.chat))}, len=${String((msg.text ?? msg.caption ?? "")).length})`,
      )
      return
    }
    if (!isAllowed(msg.chat)) {
      inboundCounters.droppedNotAllowed++
      await log(
        "info",
        `update from non-whitelisted chat=${sanitizeLog(chatTarget(msg.chat))} ` +
          `(id=${sanitizeLog(String(msg.chat?.id ?? "")).slice(0, 16)}, ` +
          `username=${sanitizeLog(String(msg.chat?.username ?? "(none)")).slice(0, 24)}, ` +
          `allowed=[${[...allowedNorm].map((x) => x.slice(0, 16)).join(",")}], ` +
          `knownNumeric=${[...knownNumericChatIDs.entries()].map(([k, v]) => `${k.slice(0, 12)}→${v.slice(0, 12)}`).join(",").slice(0, 120)}) ignored`,
      )
      return
    }
    const numericID = /^\d+$/.test(String(msg.chat?.id ?? "")) ? String(msg.chat.id) : ""
    if (numericID && knownNumericChatIDs.get(PUSH_NORM) !== numericID) {
      knownNumericChatIDs.set(PUSH_NORM, numericID)
      const uname = msg.chat?.username ? String(msg.chat.username).replace(/^@/, "") : ""
      if (uname) knownNumericChatIDs.set(uname, numericID)
      savePersistedState()
      await log("info", `learn numeric chat (chat=${numericID})`)
    }
    const chatID = chatTarget(msg.chat)
    const inboundMsgID = Number(msg?.message_id ?? 0)
    currentInbound = Number.isFinite(inboundMsgID) && inboundMsgID > 0 ? { chat: chatID, msgID: inboundMsgID } : null
    // ROUND 19（运营者症状②「编辑不被注入」）：**编辑事件必须先留痕**。
    // 此前只有走到「入队命中 / 未命中」分支才记日志 → 「编辑根本没到达桥」与
    // 「到达但被静默返回（非文本、命令等）」在日志里无法区分，排障只能靠猜。
    // 这行保证任何 edited_message 一旦到达就必然可 grep（含 chat/message_id/是否带文本）。
    if (Boolean(u?.edited_message) || Number(msg?.edit_date ?? 0) > 0) {
      const hasText = typeof msg?.text === "string" || typeof msg?.caption === "string"
      await log(
        "info",
        `tg edited_message received (chat=${sanitizeLog(chatID)}, mid=${inboundMsgID}, hasText=${hasText})`,
      )
    }
    // R1823：群聊命令可能带 @botname 后缀；解析前先剥离，否则参数切片失配（详见 stripCmdBotSuffix）。
    const text = stripCmdBotSuffix((typeof msg.text === "string" ? msg.text : typeof msg.caption === "string" ? msg.caption : "").trim())
    let cmd = normalizeCmd(text)
    if (cmd && CMD_ALIAS[cmd]) cmd = CMD_ALIAS[cmd]
    if (!text) {
      const kind = msg.photo ? "photo" : msg.sticker ? "sticker" : msg.voice ? "voice" : msg.video ? "video" : msg.document ? "document" : msg.location ? "location" : msg.contact ? "contact" : "empty-text"
      await log("info", `tg non-text skip (chat=${sanitizeLog(chatID)}, kind=${kind})`)
      return
    }
    // 限流冷却期内的任何输入都要明确告知“本 Bot 不可用”，而不是让用户对着静默干等。
    // （备用 Bot 只是投递通道，不是完整的第二套功能；真正的双 Bot 隔离见设计讨论。）
    if (floodGate.floodUntil > Date.now()) {
      const secs = Math.max(1, Math.ceil((floodGate.floodUntil - Date.now()) / 1000))
      if (Date.now() - lastUnavailableNoticeAt > 60_000) {
        lastUnavailableNoticeAt = Date.now()
        await reply(
          chatID,
          `⚠️ 本 Bot 似不可用：Telegram 限流冷却中（约 ${secs}s）。你的输入已收到，外发内容暂由备用 Bot 代发（无按钮）。若要完整功能请稍后重试或切到备用 Bot。`
        )
        await log("info", `bot unavailable notice sent (chat=${sanitizeLog(chatID)}, cooldown=${secs}s)`)
      }
    }
    // 编辑已入队消息：原地替换队列项，而不是再追加一条（用户预期“改了就是改了”）。
    // 只有非命令文本才走这里；命令编辑按新命令重放。
    {
      const t0 = String(msg?.text ?? "").trim()
      if (t0.startsWith("/")) inboundCounters.command++
      else if (t0) inboundCounters.text++
      else inboundCounters.other++
    }
    const isEdit = Boolean(u?.edited_message) || Number(msg?.edit_date ?? 0) > 0
    if (isEdit && !text.startsWith("/") && inboundMsgID > 0) {
      const hit = pinQueue.findIndex((qq) => qq.chat === chatID && Number(qq.tgMid ?? 0) === inboundMsgID)
      if (hit >= 0) {
        const item = pinQueue[hit]!
        const before = item.text
        item.text = text
        item.ctx = replyCtxOf(msg)
        item.ts = Date.now()
        savePersistedState()
        const pos = pinQueue.filter((qq) => qq.sid === item.sid).indexOf(item) + 1
        await reply(chatID, `✏️ 已更新队列第 ${pos} 条（${before.slice(0, 20)}… → ${text.slice(0, 20)}…）→ ${item.sid.slice(0, 12)}`)
        await log("info", `pinject edited in place (sid=${sanitizeLog(item.sid).slice(0, 12)}, pos=${pos}, len=${text.length})`)
        void pumpInject(item.sid)
        return
      }
      await log("info", `tg edit has no queued item (chat=${sanitizeLog(chatID)}, mid=${inboundMsgID}); treated as new message`)
    }
    if (text && !text.startsWith("/")) {
      await log("info", `tg msg (chat=${sanitizeLog(chatID)}, len=${text.length}): ${sanitizeLog(text).slice(0, 60)}`)
    }
    // 序号直选：/sessions(或/recents)后5分钟内直接回数字，等价 /use N
    if (/^\d+$/.test(text)) {
      const sel = pendingSelect.get(chatID)
      if (sel && Date.now() - sel.ts < 5 * 60_000) {
        const idx = Number(text) - 1
        const id = sel.ids[idx]
        pendingSelect.delete(chatID)
        if (!id) {
          await reply(chatID, `❓ 超出范围（1–${sel.ids.length}），重新 /sessions 后再选`)
          return
        }
        fixedTarget = id
        persistedFront = id
        // R2627：序号直选等价 /use，必须同步内存前台（否则停循环时静默丢推）。
        frontSessionID = id
        savePersistedState()
        const nm = sessionNameOf(id) || id.slice(0, 12)
        await reply(chatID, `📌 已钉选会话：${clean(nm, 40)} (${id.slice(0, 12)})`)
        return
      }
    }
    // 回复"重来"：引用机器人消息时重发上一次注入
    if (text === "重来" && msg?.reply_to_message?.from?.is_bot) {
      const target = fixedTarget ?? (await activeFront())
      const last = target ? lastInject.get(target) : undefined
      if (!target || !last) {
        await reply(chatID, "[tg-bridge] 无可重发内容")
        return
      }
      await queueAndPump(chatID, target, last, "")
      return
    }
    const resolveSessionID = async (want: string): Promise<string> => {
      const aliasHit = aliasMap.get(want.toLowerCase())
      if (aliasHit) return aliasHit
      let id = want
      // R1821：纯数字只按**序号**解析，越界即返回原值（交由调用方判 `ses_` 前缀并报"未找到"）。
      // 此前越界序号会继续走下面的"前缀/标题包含"匹配 —— 于是 `/use 99`（仅 2 个会话）会静默钉到
      // **标题里恰好含 "99" 的任意会话**；`/watch`、`/alias`、`/sendto` 复用同一解析器，同样会选错/存错。
      // 这是用户反馈"不能正确选择会话"的又一分支（R1819 只挡了未命中的原样返回，挡不住这种"命中错目标"）。
      const numeric = /^\d+$/.test(want)
      try {
        const res = await (client as any).session.list?.({})
        const arr = res?.data ?? []
        if (Array.isArray(arr)) {
          if (numeric) {
            await refreshSessionTitles()
            const hitS = cachedSessionList[Number(want) - 1]
            if (hitS) id = hitS.id
            return id
          }
          if (id === want) {
            const hit = arr.find((s: any) => String(s?.id ?? "").startsWith(want))
            if (hit) id = String(hit.id)
          }
          if (id === want) {
            await refreshSessionTitles()
            const q = want.toLowerCase()
            const hit = cachedSessionList.find((s) => s.title && s.title.toLowerCase().includes(q))
            if (hit) id = hit.id
          }
        }
      } catch {
        /* fallback: use as-is (full id) */
      }
      return id
    }
    // R2714：/alias 依赖 per-update 的 resolveSessionID，故在本作用域建一次；表与落盘仍走桥。
    const aliasCmd = createAliasCommands({
      aliasMap,
      resolveSessionID,
      refreshTitles: refreshSessionTitles,
      knownIds: () => cachedSessionList.map((s) => s.id),
      acceptable: sessionIdAcceptable,
      saveState: savePersistedState,
      clean,
      commandArg,
    })
    if (text === "/raw" || text.startsWith("/raw ") || cmd === "raw") {
      const raw = commandArg(text)
      if (!raw) {
        await reply(chatID, "📌 用法：/raw [文本]（纯文本注入，不解析命令）")
        return
      }
      const target = fixedTarget ?? (await activeFront())
      if (!target) {
        await reply(chatID, "[tg-bridge] 无法解析目标会话")
        return
      }
      await queueAndPump(chatID, target, raw, replyCtxOf(msg))
      return
    }
    if (text === "/use" || cmd === "use" || text.startsWith("/use ")) {
      const want = commandArg(text)
      if (!want) {
        const cur = fixedTarget ?? (await activeFront())
        if (!cur) {
          await reply(chatID, "📌 用法：/use [序号|名称|前缀|ID]（如：/use 3，先 /sessions 查看列表）")
          return
        }
        const nm = sessionNameOf(cur) || cur.slice(0, 12)
        await reply(chatID, `📌 当前目标：${clean(nm, 40)} (${cur.slice(0, 12)})${fixedTarget ? "（已钉选）" : "（跟随前台）"}`)
        return
      }
      const prevUse = fixedTarget ?? frontSessionID ?? persistedFront
      const id = await resolveSessionID(want)
      // R1819：文本 /use 必须与回调 /use（L5882）同一不变量 —— 只接受真实 ses_ 目标。
      // 此前 resolveSessionID 未命中时原样返回 want（拼错的名称 / 越界序号 / 命中不到的片段），
      // 这里却无条件 fixedTarget=id → 钉到一个不存在的会话，之后消息"发不出去 / 发错会话"
      // （用户反馈"不能正确选择会话"）。未命中必须明确报错且**不改动**当前目标。
      if (!id.startsWith("ses_")) {
        await reply(chatID, `❌ 未找到匹配的会话：${clean(want, 40)}（用 /sessions 查看列表，或直接粘贴完整 ses_… ID）`)
        return
      }
      // R1829：只接受列表里**真实存在**的会话。此前仅校验 `ses_` 前缀 —— 粘贴一个
      // 已删除/不存在的完整 ID 会被静默钉选，之后消息发不出去（R1819「不能正确选择会话」的残留分支）。
      // 保守放行：refreshSessionTitles 失败/列表为空时 sessionIdAcceptable 返回 true，不误伤。
      const listOk = await refreshSessionTitles()
      if (!sessionIdAcceptable(id, cachedSessionList.map((s) => s.id), listOk)) {
        await reply(chatID, `❌ 会话不存在：${clean(want, 40)}（可能已删除；用 /sessions 查看列表）`)
        return
      }
      fixedTarget = id
      persistedFront = id
      // R2627：与回调 /use 同一不变量 —— 显式切换必须同步内存前台。
      frontSessionID = id
      savePersistedState()
      // R1065：与回调 /use 同一语义 —— 继承旧前台循环登记，避免切会话后 Bot 变哑。
      if (prevUse && prevUse !== id) {
        const loopList = readIdList(LOOP_SESSIONS_FILE)
        const loopOff = readIdList(LOOP_OFF_FILE)
        if (loopList.includes(prevUse) && !loopOff.includes(id) && !loopList.includes(id)) {
          const e2 = writeIdList(LOOP_SESSIONS_FILE, [...loopList, id])
          if (e2) await log("warn", `use inherit loop write failed: ${e2}`)
          else await log("info", `use inherit loop scope ${prevUse.slice(0, 12)} -> ${id.slice(0, 12)}`)
        }
      }
      const nm = sessionNameOf(id) || id.slice(0, 12)
      await reply(chatID, `📌 已钉选会话：${clean(nm, 40)} (${id.slice(0, 12)})`)
      return
    }
    if (text === "/botname" || text.startsWith("/botname ") || cmd === "botname") {
      const arg = commandArg(text)
      if (!arg) {
        // 只读：显示当前值（getMe 不落 token）
        try {
          const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`, { signal: AbortSignal.timeout(15000) })
          const j = (await r.json().catch(() => null)) as any
          const cur = String(j?.result?.first_name ?? "(unknown)").slice(0, 64)
          await reply(chatID, `[tg-bridge] 当前 Bot 显示名：${cur}\n用法：/botname [新名称]（自动改名为当前会话，或手动指定）`)
        } catch {
          await reply(chatID, "[tg-bridge] 查询当前名称失败（getMe 超时）")
        }
        return
      }
      if (arg.length > 64) {
        await reply(chatID, "❌ 名称最长 64 字符")
        return
      }
      try {
        const r = await fetch(`https://api.telegram.org/bot${TOKEN}/setMyName`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: arg }),
          signal: AbortSignal.timeout(15000),
        })
        const j = (await r.json().catch(() => null)) as any
        if (r.ok && j?.ok) {
          await reply(chatID, `✅ Bot 显示名已设为：${arg}`)
          await log("info", "bot name set via /botname")
        } else {
          await reply(chatID, `❌ 设置失败：${String(j?.description ?? `HTTP ${r.status}`).slice(0, 120)}`)
        }
      } catch (err) {
        await reply(chatID, `❌ 设置失败：${sanitizeLog(err).slice(0, 120)}`)
      }
      return
    }
    if (text === "/botdesc" || text.startsWith("/botdesc ") || cmd === "botdesc") {
      const arg = commandArg(text)
      if (!arg) {
        try {
          const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`, { signal: AbortSignal.timeout(15000) })
          const j = (await r.json().catch(() => null)) as any
          const cur = String(j?.result?.description ?? "(无)").slice(0, 60)
          await reply(chatID, `[tg-bridge] 当前 Bot 小字（short description）：${cur}\n用法：/botdesc [小字]（自动改为会话短号，或手动指定）`)
        } catch {
          await reply(chatID, "[tg-bridge] 查询当前小字失败（getMe 超时）")
        }
        return
      }
      if (arg.length > 120) {
        await reply(chatID, "❌ 小字最长 120 字符")
        return
      }
      try {
        const r = await fetch(`https://api.telegram.org/bot${TOKEN}/setMyShortDescription`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ short_description: arg }),
          signal: AbortSignal.timeout(15000),
        })
        const j = (await r.json().catch(() => null)) as any
        if (r.ok && j?.ok) {
          await reply(chatID, `✅ Bot 小字已设为：${arg}`)
          await log("info", "bot short description set via /botdesc")
        } else {
          await reply(chatID, `❌ 设置失败：${String(j?.description ?? `HTTP ${r.status}`).slice(0, 120)}`)
        }
      } catch (err) {
        await reply(chatID, `❌ 设置失败：${sanitizeLog(err).slice(0, 120)}`)
      }
      return
    }
    if (text === "/clear") {
      fixedTarget = undefined
      forEachProto("", (k) => protoMap.delete(k))
      sentParts.clear()
      protoOwned.clear()
      savePersistedState()
      await reply(chatID, "📌 已取消钉选，跟随前台")
      return
    }
    if (text === "/watch" || text.startsWith("/watch ") || cmd === "watch") {
      const want = commandArg(text)
      if (!want) {
        const list = [...watchedSessions]
        const head = `📎 附加镜像 ${list.length}/${WATCH_MAX}（只发最终正文）`
        const body = list.length
          ? list.map((s) => `· ${sessionTag(s)} (${s.slice(0, 12)})`).join("\n")
          : "（空：当前只镜像目标会话）"
        await reply(chatID, `${head}\n${body}\n用法：/watch [序号|名称|前缀|ID]　移除：/unwatch [同上]`)
        return
      }
      const id = await resolveSessionID(want)
      if (!id.startsWith("ses_")) {
        await reply(chatID, `❌ 未找到匹配的会话：${clean(want, 40)}（用 /sessions 查看列表）`)
        return
      }
      // R1872：与 /use（R1829）同一存在性不变量 —— 仅校验 `ses_` 前缀会把已删除/不存在的
      // 完整 ID 静默加入附加镜像（占用 WATCH_MAX、持久化、永远收不到消息）。列表可用时必须在列。
      const listOk = await refreshSessionTitles()
      if (!sessionIdAcceptable(id, cachedSessionList.map((s) => s.id), listOk)) {
        await reply(chatID, `❌ 会话不存在：${clean(want, 40)}（可能已删除；用 /sessions 查看列表）`)
        return
      }
      if (watchedSessions.has(id)) {
        await reply(chatID, `📎 已在附加镜像：${sessionTag(id)} (${id.slice(0, 12)})`)
        return
      }
      if (watchedSessions.size >= WATCH_MAX) {
        await reply(chatID, `📎 附加镜像已满（${WATCH_MAX}），先 /unwatch 移除一个`)
        return
      }
      watchedSessions.add(id)
      savePersistedState()
      await reply(chatID, `📎 已附加镜像：${sessionTag(id)} (${id.slice(0, 12)})\n只发最终回复正文（不带思考/状态/工具流）`)
      return
    }
    if (text === "/unwatch" || text.startsWith("/unwatch ") || cmd === "unwatch") {
      const want = commandArg(text)
      if (!want) {
        if (watchedSessions.size === 0) {
          await reply(chatID, "📎 附加镜像为空")
          return
        }
        const n = watchedSessions.size
        watchedSessions.clear()
        savePersistedState()
        await reply(chatID, `📎 已清空附加镜像（${n} 个）`)
        return
      }
      const id = await resolveSessionID(want)
      if (!watchedSessions.delete(id)) {
        await reply(chatID, `📎 未在附加镜像中：${sessionTag(id)} (${id.slice(0, 12)})`)
        return
      }
      forEachProto(id, (k) => protoMap.delete(k))
      savePersistedState()
      await reply(chatID, `📎 已取消附加镜像：${sessionTag(id)} (${id.slice(0, 12)})`)
      return
    }
    if (text === "/tgping" || cmd === "tgping" || cmd === "ping") {
      activeFrontOverride = ""
      const diag = [
        `[tg-bridge] pong · ver=${VERSION}`,
        `push=${pushChatResolve()} · 活动=${(activeSessionID ?? "").slice(0, 12) || "-"} · 前台=${((fixedTarget ?? (await activeFront())) || "").slice(0, 12) || "-"}${fixedTarget ? "（钉选）" : ""}`,
        `事件=${eventCount} · 最近推送=${lastPushAt || "-"} · 外发队列=${outQueue.length}`,
        `卡片=${protoMap.size} 张（可编辑：思考/正文/工具/状态）`,
      ].join("\n")
      await reply(chatID, diag)
      return
    }
    // R2616: /memu is the operator's observed typo of /menu; treat it (and the
    // shortest /men form) as the menu command instead of "unknown command".
    if (text === "/menu" || text === "/memu" || text === "/men" || cmd === "menu" || cmd === "memu" || text === "/菜单" || text === "菜单") {
      // R2640（运营者："memu 应该是一个命令弹一个，不要复用"）：命令入口每次新发一张卡。
      // 按钮回调仍编辑用户点的那张卡，因此多条历史菜单都能各自翻页。
      const c = String(pushChatResolve() || chatID)
      const ok = await showMenuView(c, "root", { freshCard: true })
      if (!ok) await log("warn", `menu command deferred (chat=${sanitizeLog(c)})`)
      return
    }
    if (text === "/help" || cmd === "help" || text === "/start" || cmd === "start") {
      await reply(chatID, HELP_TEXT)
      return
    }
    // R1854：补空格哨兵。其余命令块都写成 `text === "/cmd" || text.startsWith("/cmd ") || cmd === "cmd"`，
    // 只有 /addbot 漏了空格 → `/addbotx`、`/addbots` 等**前缀相同的误敲命令**会被吞进 addbot 分支
    // （args[0] 成垃圾 token），而不是回「❓ 未知命令」。`cmd === "addbot"` 已覆盖正常拼写，
    // 前缀仅用于"命令带参数"这一情形。
    // 批量接入：/addbots <token1> <token2> …（空格/换行分隔）。一次消息登记多个 Bot，
    // 不必改代码、不必为每个 Bot 单独跑命令。单个失败不影响其余；逐个回执。
    if (text === "/addbots" || text.startsWith("/addbots ") || cmd === "addbots") {
      const rest = text.slice("/addbots".length).trim()
      const tokens = rest.split(/\s+/).filter((x) => TG_TOKEN_RE.test(x))
      if (tokens.length === 0) {
        await reply(
          chatID,
          "用法：/addbots &lt;token1&gt; &lt;token2&gt; …\n（空格或换行分隔；每个 token 必须是不同机器人的）\n⚠️ 消息会在登记前尽量删除，但请仍按泄露处理并择机 revoke。",
        )
        return
      }
      if (inboundMsgID > 0) {
        try {
          await tgFetch("deleteMessage", { chat_id: Number(chatID) || chatID, message_id: inboundMsgID })
        } catch {
          /* best-effort */
        }
      }
      let n = 0
      for (const tok of tokens) {
        n += 1
        // R2512：不传“批量 n”标签——handleAddBot 会用 getMe 的 @username 作为
        // 用户可见名（运营者要求“不要 bot 代号，直接用用户名”）。
        // R2539：deferReload ⇒ 整批只重载一次，避免 N 个 bot 触发 N 次插件重载。
        await handleAddBot([tok, String(chatID)], chatID, { deferReload: true })
      }
      const batchEntry = triggerBridgeReload()
      await reply(
        chatID,
        `📦 批量登记结束：提交 ${tokens.length} 个 token（逐个结果见上）。\n` +
          `· 已统一触发桥侧重载：${batchEntry.split("/").pop() ?? batchEntry}`,
      )
      return
    }
    if (text === "/addbot" || text.startsWith("/addbot ") || cmd === "addbot") {
      const rest = text.slice("/addbot".length).trim()
      const args = rest ? rest.split(/\s+/) : []
      // R1835：/addbot 的用户消息里是**明文 token**。登记前先尽力删除这条消息，缩短 token
      // 在 TG 历史里的暴露窗口（私聊中 Bot 可删除自己收到的消息；群聊 / 超 48h / 失败则静默忽略）。
      // 仅在确实带了参数（疑似 token）时删；纯 `/addbot` 用法提示消息不删。
      if (args[0] && inboundMsgID > 0) {
        try {
          await tgFetch("deleteMessage", { chat_id: Number(chatID) || chatID, message_id: inboundMsgID })
        } catch {
          /* best-effort：删不掉不影响登记 */
        }
      }
      await handleAddBot(args, chatID)
      return
    }
    // R2713：会话列表命令（/sessions /recents）整组上收到 tg-command-sessions。
    if (await sessionList.run({ chatID, text, cmd, reply })) return
    // R2714：/alias 整组上收到 tg-command-alias。
    if (await aliasCmd.run({ chatID, text, cmd, reply })) return
    if (text === "/retry" || cmd === "retry") {
      const target = fixedTarget ?? (await activeFront())
      const last = target ? lastInject.get(target) : undefined
      if (!target || !last) {
        await reply(chatID, "[tg-bridge] 无可重发内容")
        return
      }
      await queueAndPump(chatID, target, last, "")
      return
    }
    if (text === "/undo" || cmd === "undo") {
      const target = fixedTarget ?? (await activeFront())
      if (!target) {
        await reply(chatID, "⏹ 没有可停止的会话")
        return
      }
      await reply(chatID, await doStop(target))
      return
    }
    // R2722：/loop 整组上收到 tg-command-loop（注入文案子命令内部转 tg-command-loop-inject）。
    if (await loopCmd.run({ chatID, text, cmd })) return
    // R2717：/proxy 整组上收到 tg-command-proxy。
    if (await proxyCmd.run({ chatID, text, cmd })) return
    // R2718：/config 整组上收到 tg-command-config。
    if (await configCmd.run({ chatID, text, cmd })) return
    // R2719：/background 整组上收到 tg-command-background。
    if (await backgroundCmd.run({ chatID, text, cmd })) return
    // R2715：/model 与 /think 整组上收到 tg-command-model。
    if (await modelCmd.run({ chatID, text, cmd, reply })) return
    // R2720：/autoguard 整组上收到 tg-command-autoguard。
    if (await autoguardCmd.run({ chatID, text, cmd })) return
    // R2723：/replay /reload 整组上收到 tg-command-replay。
    if (await replayCmd.run({ chatID, text, cmd })) return
    if (text === "/compaction" || cmd === "compaction") {
      const target = (fixedTarget?.length ?? 0) > 0 ? fixedTarget : await activeFront()
      if (!target) {
        await reply(chatID, "🗜 没有可查压缩摘要的会话")
        return
      }
      const fn = (client as any)?.session?.latestCompaction
      if (typeof fn !== "function") {
        await reply(chatID, "🗜 兼容层过旧，无法查压缩摘要")
        return
      }
      let m: any = null
      try {
        const res = await fn.call((client as any).session, { path: { id: target } })
        m = (res as any)?.data ?? null
      } catch {
        m = null
      }
      if (!m) {
        await reply(chatID, `🗜 会话 ${target.slice(0, 12)} 没有压缩记录`)
        return
      }
      await protoPushAssistantMessage(target, String(chatID), m)
      await reply(chatID, `🗜 压缩摘要 → ${target.slice(0, 12)}（分条发送）`)
      return
    }
    if (text === "/digest" || cmd === "digest") {
      const target = (fixedTarget?.length ?? 0) > 0 ? fixedTarget : await activeFront()
      if (!target) {
        await reply(chatID, "📋 没有可摘要的会话")
        return
      }
      const msgs = await fetchTail(target, 10)
      if (!msgs) {
        await reply(chatID, `📋 会话 ${target.slice(0, 12)} 没有消息`)
        return
      }
      for (const m of msgs) await protoPushAssistantMessage(target, String(chatID), m)
      await reply(chatID, `📋 最近动态 ${msgs.length} 条 → ${target.slice(0, 12)}（分条发送）`)
      return
    }
    // R2712：推送/队列命令整组上收到 tg-command-push。
    if (await pushCmd.run({ chatID, text, cmd, reply })) return
    if (text === "/stripall" || cmd === "stripall") {
      // 全扫：除各会话最新一条外，所有已知回复消息去键（含各实例各记一份导致的漏网）
      let n = 0
      const seen = new Set<number>()
      const latest = new Set<number>()
      for (const [, v] of [...lastReply.entries()]) latest.add(v.id)
      for (const [k, v] of [...protoMap.entries()]) {
        if (!k.includes(":message:")) continue
        if (seen.has(v.id) || latest.has(v.id)) continue
        seen.add(v.id)
        try {
          const r = await tgFetch("editMessageReplyMarkup", { chat_id: Number(chatID) || chatID, message_id: v.id, reply_markup: { inline_keyboard: [] } })
          if (r.ok) {
            n++
            strippedKb.add(k)
          }
        } catch {
          /* best-effort */
        }
      }
      while (strippedKb.size > STRIP_KB_MAX) {
        const first = strippedKb.values().next()
        if (first.done) break
        strippedKb.delete(first.value)
      }
      savePersistedState()
      await log("info", `stripall done (cleared=${n})`)
      await reply(chatID, `🧹 已清 ${n} 条旧回复按钮（保留最新一条，下条继续轮换）`)
      return
    }
    if (text === "/version" || cmd === "version") {
      await reply(chatID, `[tg-bridge] ver=${VERSION} flt=${filtLine()}`)
      return
    }
    if (text === "/info" || cmd === "info") {
      const target = fixedTarget ?? (await activeFront())
      if (!target) {
        await reply(chatID, "📌 没有可用会话")
        return
      }
      let n = -1
      try {
        const r = await client.session.messages({ path: { id: target } })
        if (Array.isArray(r?.data)) n = r.data.length
      } catch {
        /* ignore */
      }
      const nm = clean(sessionNameOf(target) || "", 40) || "(无标题)"
      const lastA = lastActivity.get(target) ?? 0
      const flags = [
        target === fixedTarget ? "📌钉选" : "",
        target === (await activeFront()) ? "⭐前台" : "",
        Date.now() - lastA < ACTIVE_WINDOW_MS ? "◎活跃" : "",
      ].filter(Boolean).join(" ") || "—"
      await reply(chatID, [`ℹ️ ${nm} (${target.slice(0, 12)})`, `· 消息数：${n < 0 ? "?" : n} · 最后活动：${lastA ? fmtTime(lastA) : "(未知)"}`, `· 状态：${flags} · ${filtLine()} · queue=${outQueue.length}`].join("\n"))
      return
    }
    if (text === "/quiet" || cmd === "quiet") {
      // R2637：过滤/压缩设置不再另发一张卡，直接在唯一菜单消息里打开推送过滤页。
      await showMenuView(String(chatID), "pushfilt")
      return
    }
    if (text === "/loud" || cmd === "loud") {
      (Object.keys(filters) as Array<"reply" | "think" | "tool" | "status">).forEach((k) => { filters[k] = 2 })
      savePersistedState()
      await reply(chatID, "[tg-bridge] loud（恢复全部推送）")
      return
    }
    if (text === "/selfmute" || cmd === "selfmute") {
      const arg = commandArg(text).toLowerCase()
      if (arg === "on" || arg === "off") selfMute = arg === "on"
      else selfMute = !selfMute
      savePersistedState()
      await reply(
        chatID,
        `${selfMute ? "🤫 只答命令（普通文本不再注入）" : "💬 正常应答（普通文本自动注入）"} · bot=${sanitizeLog(BOT_LABEL)}`,
      )
      return
    }
    // R719：压缩通知发送开关（用户点名的「压缩是否发送」选项；等价于 /quiet 菜单里的同款按钮）
    if (text === "/cnotice" || cmd === "cnotice") {
      const arg = commandArg(text).toLowerCase()
      if (arg === "on" || arg === "off") compactPrefs.notice = arg === "on"
      else compactPrefs.notice = !compactPrefs.notice
      savePersistedState()
      await reply(
        chatID,
        `[tg-bridge] 🗜 压缩通知：${compactPrefs.notice ? "发" : "不发"}（关掉后仍记日志） · bot=${sanitizeLog(BOT_LABEL)}`,
      )
      return
    }
    // R2626（运营者：“改，给我一个菜单的选择按钮/界面”）：额度尾恢复设置。
    // auto = workflow 证明“本轮出口 ≠ 上一轮出口”时，Option C 对 quota 尾条
    // 用 recover 文案续一次；off = 仍按旧行为 skip(quota-error)。与自动循环分开。
    if (text === "/quotatail" || text.startsWith("/quotatail ") || cmd === "quotatail") {
      const arg = commandArg(text).toLowerCase()
      let mode = readQuotaRecover().mode
      if (arg === "on" || arg === "auto") mode = "auto"
      else if (arg === "off") mode = "off"
      else mode = mode === "auto" ? "off" : "auto"
      writeQuotaRecoverMode(mode, BOT_ID)
      await reply(
        chatID,
        `[tg-bridge] 🧯 额度尾恢复：${mode === "auto" ? "自动（仅换出口后续一次）" : "关闭（quota 尾条一律跳过）"} · 与自动循环独立 · bot=${sanitizeLog(BOT_LABEL)}`,
      )
      return
    }
    if (text === "/quotarecent" || cmd === "quotarecent") {
      const last = readQuotaRecoverLast()
      await reply(
        chatID,
        last
          ? `[tg-bridge] 🧯 最近额度尾恢复：${fmtTime(last.at)} · ${last.reason || "?"}/${last.prompt || "?"} · ${(last.sid || "?").slice(0, 12)}${last.run ? ` · run=${last.run}` : ""}`
          : "[tg-bridge] 🧯 还没有额度尾恢复记录（需换出口 + 上轮尾条为 quota/429 + 模式自动）",
      )
      return
    }
    // R2650（运营者："有没有按钮给我关闭/打开，注意区分bot"）：per-Bot 开关。
    // 状态写进本 Bot 自己的状态文件；关闭时顺手删掉本 Bot 尚未消费的 rollover
    // 请求，避免它在本轮重启后又悄悄换一次会话。
    if (text === "/rollover429" || text.startsWith("/rollover429 ") || cmd === "rollover429") {
      const arg = commandArg(text).toLowerCase()
      // R2656：人工立即触发（菜单「⚡ 立即 429 换会话」）。先停旧回合、再换；
      // 与额度尾恢复互斥：请求文件存在时选路步骤会关闭本轮 quota-tail recover。
      if (arg === "now") {
        await manualRolloverNow(chatID)
        return
      }
      if (arg === "on") rolloverOn429 = true
      else if (arg === "off") rolloverOn429 = false
      else rolloverOn429 = !rolloverOn429
      let dropped = 0
      if (!rolloverOn429) {
        for (const s of new Set([fixedTarget, persistedFront, frontSessionID])) {
          if (!s) continue
          try {
            unlinkSync(`${ROLLOVER_REQUEST_DIR}/${s}.json`)
            dropped++
          } catch {
            /* 没有待处理请求最正常 */
          }
        }
      }
      savePersistedState()
      const globalOff = process.env.ROLLOVER_ON_429 === "0"
      await reply(
        chatID,
        `[tg-bridge] 🔄 429 换会话：<b>${rolloverOn429 ? "开" : "关"}</b> · bot=${sanitizeLog(BOT_LABEL)}（本轮有 429 的会话下一轮换新）` +
          (dropped ? `\n已删除本 Bot 待处理的换会话请求 ${dropped} 条` : "") +
          (!rolloverOn429
            ? "\n关闭后本 Bot 不会新建/切换会话；不影响其它 Bot。"
            : globalOff
              ? "\n⚠️ 但全局 ROLLOVER_ON_429=0 仍会阻止执行（repo variable）。"
              : ""),
      )
      return
    }
    // R2728/R2729/R2732（运营者：「1，2改成一个菜单选项」「不是全局，是 bot
    // 单独设置」「我说的是 ci 结束/开始/tg 限流这些全局信息的开关」）：
    // 每个 Bot 一个开关，只控制本 Bot 是否重钉/重建注入卡、是否推送全局通知
    // （CI 结束/接力、本轮选代理结果、循环停止、配额 429、Telegram 限流）。菜单按钮和文本命令
    // 操作同一份 card-ops.json 里本 Bot 的条目；CI 的 tg-notify.sh 按候选 Bot
    // 各自的条目决定能不能推。
    if (text === "/cardops" || text.startsWith("/cardops ") || cmd === "cardops") {
      const arg = commandArg(text).toLowerCase()
      const cur = readCardOps(BOT_ID)
      const desired =
        arg === "on" ? true : arg === "off" ? false : arg === "status" ? cur.enabled : !cur.enabled
      if (arg !== "status") writeCardOps(BOT_ID, desired, BOT_ID)
      // R2730：写失败时不能把「想改成的值」当成结果报给运营者；回读文件确认。
      // 同时列出各 Bot 的开关，让「只改本 Bot」在回复里可见，不用切到别的聊天核对。
      const actual = readCardOps(BOT_ID)
      const failed = arg !== "status" && actual.enabled !== desired
      let ids: string[] = []
      try {
        const j = JSON.parse(readFileSync(BOT_REGISTRY_PATH, "utf8")) as { bots?: Array<{ id?: string }> }
        if (Array.isArray(j?.bots)) ids = j.bots.map((b) => String(b?.id ?? "").trim()).filter(Boolean)
      } catch {
        /* 注册表缺失时至少显示本 Bot */
      }
      if (!ids.includes(BOT_ID)) ids.push(BOT_ID)
      const overview = formatCardOpsOverview(
        [...new Set(ids)].map((id) => ({ id: htmlEsc(id), enabled: readCardOps(id).enabled })),
        htmlEsc(BOT_ID),
      )
      await reply(
        chatID,
        `[tg-bridge] 📣 全局通知＋卡片自愈：<b>${cardOpsLabel(actual.enabled)}</b> · 本 Bot\n${CARD_OPS_HELP}\n各 Bot：${overview}\n设置：<code>${CARD_OPS_PATH_BASENAME}</code> · bot=${sanitizeLog(BOT_LABEL)}` +
          (failed
            ? `\n⚠️ 写入未生效（仍是「${cardOpsLabel(actual.enabled)}」）；请检查 ${CARD_OPS_PATH_BASENAME} 的权限/磁盘。`
            : ""),
      )
      return
    }
    if (text === "/stop" || cmd === "stop") {
      const target = fixedTarget ?? (await activeFront())
      if (!target) {
        await reply(chatID, "⏹ 没有可停止的会话")
        return
      }
      // R1062：/stop 语意 = 「停住自动循环」= 先写共享总闸（auto-continue 据此 SKIP，
      // /loop start 恢复），再中断当前回合。仅显式文本命令如此；
      // card ⏹ 按钮（callback stop:）与 /undo 仍只中断回合 —— loop-ctl 两会话共用
      // 的历史误停问题（曾因 ⏹ 写总闸导致两会话循环一起被关）不回归。
      persistLoopStop("user /stop")
      const diag = await doStop(target)
      const ended = diag.startsWith("[tg-bridge] stopped")
      await reply(
        chatID,
        ended
          ? `${diag}\n⏹ 自动循环已停止（/loop start 恢复）`
          : `${diag}\n⏹ 已写入停机总闸；当前回合仍未确认中断（/loop start 恢复）`
      )
      return
    }
    if (text === "/compact" || cmd === "compact") {
      const target = fixedTarget ?? (await activeFront())
      if (!target) {
        await reply(chatID, "🗜 没有可压缩的会话")
        return
      }
      // 通道优先级与 auto-continue.compactNow 一致：
      // ① 宿主自带认证的 _client（2026-11-16 v2.3.0 实测可用）；
      // ② compat 层 session.compact（native ctx.session.compact → slash command → 带凭据的本地 HTTP）。
      let lastErr: unknown = null
      const base = (client as any)?._client
      if (base?.post) {
        try {
          await base.post({ url: `/api/session/${encodeURIComponent(target)}/compact` })
          await reply(chatID, `[tg-bridge] 🗜 已触发压缩 · ${target.slice(0, 12)}`)
          return
        } catch (err) {
          lastErr = err
          await log("warn", `compact via _client failed, trying compat: ${sanitizeLog(err).slice(0, 160)}`)
        }
      }
      const fn = (client as any)?.session?.compact
      if (typeof fn === "function") {
        try {
          await fn.call((client as any).session, { path: { id: target } })
          await reply(chatID, `[tg-bridge] 🗜 已触发压缩 · ${target.slice(0, 12)}`)
          return
        } catch (err) {
          lastErr = err
        }
      }
      const msg = sanitizeLog(lastErr ?? "no compact channel").slice(0, 200)
      await log("error", `compact failed for ${sanitizeLog(target)}: ${msg}`)
      await reply(
        chatID,
        `🗜 压缩失败：${msg}\n可重试；仍失败用 /migrate 或 /new。`,
      )
      return
    }
    // R2724：/new /fork 整组上收到 tg-command-new-fork。
    if (await newForkCmd.run({ chatID, text, cmd })) return
    if (text === "/revert" || text.startsWith("/revert ") || cmd === "revert") {
      await revertCmd.run({
        chatID: String(chatID),
        text,
        resolveTarget: async () => fixedTarget ?? (await activeFront()),
        reply,
      })
      return
    }
    // R2725：/migrate 整组上收到 tg-command-migrate。
    if (await migrateCmd.run({ chatID, text, cmd })) return
    if (text === "/drops" || cmd === "drops") {
      await reply(chatID, diagnostics.dropsText(dropRing))
      return
    }
    if (text === "/owner" || cmd === "owner") {
      await reply(chatID, diagnostics.ownerText(OWNER_PATH))
      return
    }
    if (text === "/offset" || cmd === "offset") {
      await reply(chatID, diagnostics.offsetText(persistedOffset))
      return
    }
    if (text === "/logs" || text.startsWith("/logs ") || cmd === "logs") {
      const arg = commandArg(text)
      const n = /^\d+$/.test(arg) ? Math.min(Number(arg), 40) : 20
      await reply(chatID, diagnostics.logsText(TAP_PATH, n))
      return
    }
    if (text === "/errors" || text.startsWith("/errors ") || cmd === "errors") {
      const arg = commandArg(text)
      const n = /^\d+$/.test(arg) ? Math.min(Number(arg), 30) : 5
      await reply(chatID, diagnostics.errorsText(errorRing, n))
      return
    }
    if (text === "/whoami" || cmd === "whoami") {
      const target = fixedTarget ?? (await activeFront())
      await reply(chatID, diagnostics.whoamiText({ chatID, target, pinned: Boolean(fixedTarget) }))
      return
    }
    if (text === "/sendto" || text.startsWith("/sendto ") || cmd === "sendto") {
      const rest = commandArg(text)
      const sp = rest.search(/\s/)
      if (sp < 0) {
        await reply(chatID, "📌 用法：/sendto [会话] [文本]（如：/sendto 2 你好；只发这一次，不改钉选）")
        return
      }
      const id = await resolveSessionID(rest.slice(0, sp))
      const body = rest.slice(sp + 1).trim()
      if (!body) {
        await reply(chatID, "📌 用法：/sendto [会话] [文本]（文本不可为空）")
        return
      }
      if (!id.startsWith("ses_")) {
        await reply(chatID, `❌ 未找到匹配的会话：${clean(rest.slice(0, sp), 40)}（用 /sessions 查看列表）`)
        return
      }
      // R1872：与 /use（R1829）同一存在性不变量 —— 否则 /sendto 一个已删除的完整 ID 会把
      // 消息塞进不存在的会话，用户只看到后续投递失败，却没有"会话不存在"的明确拒绝。
      const listOk = await refreshSessionTitles()
      if (!sessionIdAcceptable(id, cachedSessionList.map((s) => s.id), listOk)) {
        await reply(chatID, `❌ 会话不存在：${clean(rest.slice(0, sp), 40)}（可能已删除；用 /sessions 查看列表）`)
        return
      }
      await queueAndPump(chatID, id, body, replyCtxOf(msg))
      return
    }
    if (text === "/healcards" || cmd === "healcards") {
      // 一次性纠正"卡在执行中"的工具卡：按会话真实状态核对终态，改写卡片。
      // 背景：宿主没发完成事件时卡片会永远停在旧文案；自动对账只覆盖"落过 running
      // 标记"的卡，而修复之前的历史卡没有任何标记 → 只能由用户手动触发一次。
      const chat = pushChatResolve()
      if (!chat) {
        await reply(chatID, "🩹 没有可用的推送 chat")
        return
      }
      const sids = new Set<string>()
      const t0 = fixedTarget ?? frontSessionID ?? persistedFront
      if (t0) sids.add(t0)
      for (const w of watchedSessions) sids.add(w)
      let fixed = 0
      let checked = 0
      for (const sid of [...sids].slice(0, 3)) {
        try {
          const res = await client.session.messages({ path: { id: sid } })
          const arr = Array.isArray(res?.data) ? res.data : []
          const real = new Map<string, string>()
          for (const m of arr) {
            for (const pp of partsOf(m)) {
              if (String(pp?.type ?? "") !== "tool") continue
              const cid = callOf(pp)
              const stt = String((pp as any)?.state?.status ?? "")
              if (cid && stt) real.set(cid, stt)
            }
          }
          for (const [key, rec] of protoMap) {
            if (!key.startsWith(`${sid}:tool:`)) continue
            // R2372：`checked` 此前**声明后从未自增** → 回执恒为「核对 0 张工具卡」，
            // 与实际发生的核对数不符（违反本模块「如实说明"做到了什么"」的纪律）。
            // 语义 = 本次遍历到的工具卡张数；`fixed` = 其中被真正改写的张数，
            // 差额即回复里"其余本来就不是终态或没有对应卡片"的那部分。
            checked++
            const cid = staleCallId(key)
            const stt = real.get(cid) ?? ""
            if (stt !== "completed" && stt !== "error") continue
                // 去重守卫必须在**编辑之前**：此前它被插在 `if (r.r === "sent")` 里面 ——
                // 等于"先改完再检查有没有改过"，完全无效。
                if (alreadyReconciled(key, stt)) continue
                // 与另两条纠正路径对齐：优先**就地替换状态行**（保住原卡面），且不包 protoBlock
                //（包裹会凭空多出一层 ⚠️ 引用块）。旧实现是"整张卡替换成一行通知 + ⚠️ 包裹"，
                // 用户看到的就是内容全丢 + 格式坏掉。
                // ⚠️ 本站点只拿到 callID→状态，**没有 part 数据**，所以拿不到 renderToolTerminalCard 的
                // 入参；没有锚点时只能退回一行状态（如实说明，不假装能重建整张卡）。
                const minsH = rec.runningAt > 0 ? Math.max(0, Math.round((Date.now() - rec.runningAt) / 60_000)) : 0
                const patchedH = patchStillNote(rec?.text ?? "", stt, minsH)
                const bodyH =
                  patchedH ??
                  (stt === "completed"
                    ? `✅ 已完成（由 /healcards 按会话真实状态纠正；卡住约 ${minsH} 分钟）`
                    : `❌ 失败（由 /healcards 按会话真实状态纠正；卡住约 ${minsH} 分钟）`)
                const r = await editTextRaw(chat, rec.id, bodyH, undefined, rec.fallback === true)
            if (r.r === "sent") {
              markReconciled(key, stt)
              protoMap.set(key, { ...rec, runningAt: 0 })
              staleToolBorn.delete(key)
              // R2492 修复：这里原本还有一句「if (alreadyReconciled(key, stt)) continue」，
              // 但它紧跟在 markReconciled(key, stt) 之后 —— markReconciled 刚把
              // reconcileTag[key] 置成 `EPOCH:stt`，于是该判据**恒为真** → 每次都 continue，
              // 后面的 `fixed++` **永远执行不到** → 回执与日志恒为「纠正 0 张」，与
              // 本模块「如实说明做到了什么」的纪律（R2372 修 checked 时引用的同一条）相悖。
              // 去重本由**编辑之前**的守卫（L8596）负责；此处再判一次纯属自相矛盾，删除即可。
              fixed++
            }
          }
        } catch {
          /* best-effort */
        }
      }
      savePersistedState()
      await reply(chatID, `🩹 healcards：核对 ${checked} 张工具卡，纠正 ${fixed} 张（其余本来就不是终态或没有对应卡片）`)
      await log("info", `healcards: checked=${checked} fixed=${fixed}`)
      return
    }
    if (text.startsWith("/")) {
      if (!KNOWN_CMDS.has(cmd)) {
        await reply(chatID, `❓ 未知命令 /${clean(cmd || text.slice(1).split(/\s/)[0], 30)}（发送 /help 查看列表）`)
      }
      return
    }
    const target = fixedTarget ?? (await activeFront())
    if (!target) {
      await reply(chatID, "[tg-bridge] 无法解析目标会话（没有任何已知会话，请先在 opencode 中新建会话）")
      return
    }
    // 只答命令模式：普通文本不自动注入。**必须明确回执**，否则用户在 Telegram 上
    // 发了半天没反应，会以为 Bot 挂了。
    if (selfMute) {
      await log("info", `selfmute ignored plain text (bot=${sanitizeLog(BOT_LABEL)}, len=${text.length})`)
      await reply(chatID, "🤫 本 Bot 当前是「只答命令」：这条没注入。恢复自动应答：/selfmute off")
      return
    }
    await log("info", `inject from tg (chat=${sanitizeLog(chatID)}, len=${text.length}) -> foreground=${sanitizeLog(target)}`)
    // R2627：普通 TG 注入解析出的目标就是用户当前会话，必须同步内存前台；
    // 旧实现只写 persistedFront，循环停止时 protoSend 仍按旧 frontSessionID 拦推。
    if (frontSessionID !== target) frontSessionID = target
    if (persistedFront !== target) {
      persistedFront = target
      savePersistedState()
    }
    await queueAndPump(chatID, target, text, replyCtxOf(msg))
  }

  const handleUpdate = async (u: any): Promise<void> => {
    const raw = String(u?.message?.text ?? u?.message?.caption ?? "").trim()
    commandReplyMode = Boolean(u?.callback_query) || raw.startsWith("/")
    try {
      await handleUpdateInner(u)
    } catch (err) {
      // R1817：这里**必须**自己兜住。改之前**没有 catch** → 抛错一路冒到 poll 的
      // for 循环，**整批剩余 update 全部不再处理**（for 被抛断，批次提交 L7347 也不执行），
      // 而失败那条的 offset 早在 handleUpdateInner 的 commitOffset(uid) 就提交了
      // → 那条用户消息**永久不再投递**，日志里只剩一句与网络错误**长得一模一样**的
      // `poll error:`，连"丢了哪条"都查不出来。这正是 R1728 记的形态 B（整条事件消失）。
      //
      // 为什么不重试（这是本轮最关键的取舍，写死在这里以免后人"顺手优化"）：
      //   重试需要**同时**撤销两处状态 —— offset **和** 去重环 seenUpdates。
      //   只撤销 offset 是**无效**的：TG 重投同一 update_id 会命中 handleUpdateInner
      //   开头的去重判据直接 return，消息照样丢，而且**连 poll error 都不会再有**
      //   （从"有一条线索"退化成"彻底静默"，比改之前更糟）。
      //   而真重试的代价是**重复副作用**：处理函数可能已经 reply() 回 Telegram 之后
      //   才抛错，重投就会**再发一遍**给用户 —— 那正是 R1807–R1811 追了 5 轮的重复卡片。
      //   在**零观测**到真实丢失（92 条 poll error 全是网络层签名：71 条证书校验、
      //   21 条 socket 关闭，OTHER=0）的前提下，用"可能重复"换"可能丢失"是**不对称**的赌注。
      //   → 本轮只保证「不丢整批 + 留精确痕迹」。重试语义登记待决策，不擅自改。
      const why = sanitizeLog(err)
      await log(
        "error",
        `inbound handler error (uid=${String(u?.update_id ?? "?")}, NOT retried, THIS UPDATE IS LOST): ${why}`,
      )
    } finally {
      commandReplyMode = false
    }
  }

  const poll = async (): Promise<void> => {
    if (polling) return
    if (authDisabled) return
    // R1870：`polling` 必须在进入本函数的**第一个 await 之前**置位。它一身两职：
    //   (a) setInterval(POLL_MS=2s) 的防重入闸；
    //   (b) sanityCheckOffset / peekLatestUpdateId 判定"轮询在飞"（否则并发 getUpdates → 409）。
    // 旧实现把它写在若干 await（循环停止态每拍 `clearPinnedBars` 的 TG 网络往返、
    // `reply`、log）**之后** → 只要其中任一 await 超过 2s，下一拍 interval 看到 polling
    // 仍为 false 就会再进一个 poll，两路 getUpdates 并发，Telegram 对同一 token 回 409
    // 并掐断在飞的那一个（**静默丢轮**）。现在整个函数体包进 try/finally，任何 early
    // return 都会在 finally 复位，杜绝该窗口。
    polling = true
    try {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) {
      stopPolling()
      // 正常交接（热重载）不是错误：记 info，否则真错误会被淹没在换代噪声里。
      await log("info", `poll loop gen ${myGen} superseded, stopping (normal handover)`)
      return
    }
    if (!amPollOwner(pollInstanceId, "tg")) {
      if (!pollLostLogged) {
        pollLostLogged = true
        // R2548：多实例/换代期间租约短暂非本实例是**正常交接**，不是故障。
        // 旧实现记 error，roll 后 restore-monitor 的 "plugin lower-case ERROR == 0"
        // 必挂；实测 05:17:01 记 error、05:18:01 即 took ownership，纯噪声。
        await log("info", "poll loop not owner, waiting for lease takeover (normal handover)")
      }
      return
    }
    if (pollLostLogged) {
      pollLostLogged = false
      await log("info", "poll loop took ownership")
    }
    claimPollOwner(pollInstanceId, "tg")
    syncPersistedTarget()
    // R2575：启动/接管后认领聊天里丢失记录的队列置顶卡（仅私聊，一次性）。
    void reconcileQueuePinCard()
    if (!pollCensusLogged) {
      pollCensusLogged = true
      await log("info", `poll census: owner=${shortId} gen=${myGen} pid=${process.pid}`)
    }
    if (loopStopped()) {
      await clearPinnedBars("loop stopped")
      void refreshQueuePin()
    }
    if (pinRestorePending > 0) {
      pinRestorePending = 0
      const pc = pushChatResolve()
      if (pc && pinQueue.length > 0) await reply(pc, `📌 注入队列恢复 ${pinQueue.length} 条（/queue 置顶查看，/flush 继续注入，/dropq 清掉）`)
      for (const sid of new Set(pinQueue.map((qq) => qq.sid))) void pumpInject(sid)
    }
    // R1059：周期性重泵。注入队列此前只在“新消息入队 / 会话 idle / /flush”时被触发；
    // 用户不再发新消息时，排队的消息会一直干等（实测“为什么刚刚不能注入”排队 10 分钟）。
    // 每条 poll 周期检查一次队列，非空即以当前会话为目标重泵（pump 自身有 pumping 去重 +
    // injectMode=idle 的回合空闲等待，不会与“每回合一条”冲突）。
    {
      const pend = new Set(pinQueue.filter((qq) => qq.sid).map((qq) => qq.sid))
      if (pend.size > 0) {
        for (const sid of pend) void pumpInject(sid)
      }
    }
    // R1063：改名周期检查。session.idle 事件实测从不触发（onIdle 挂点 0 命中），
    // 因此 rename 改由 poll 循环驱动：节流 60s 一次，目标=当前 front。
    // renameBotToSession 按 (sid|title) 去重，重复调用是 no-op。
    if (Date.now() - lastRenameCheck > RENAME_CHECK_MS) {
      lastRenameCheck = Date.now()
      const cur = fixedTarget ?? frontSessionID ?? persistedFront
      if (typeof cur === "string" && cur.startsWith("ses_")) {
        // R1916c：改名前强制刷新标题缓存 —— sessionTitleCache 只在 boot 与闸口命令时
        // 填充，auto-continue 侧的循环状态标记（[LOOP]/[LOOP:OFF]）是独立进程每 5s 写的，
        // 不改名时缓存会长期陈旧。实测 R1916 上线后 bot2/bot3 标题已含 [LOOP:OFF] 但
        // Telegram 机器人名仍是旧标题 → rename 按 (sid|title) 判重静默 no-op。
        // 60s 一次的 HTTPSessionList 拉取成本可接受（闸口命令场景早已同频调用）。
        await refreshSessionTitles()
        void renameBotToSession(cur)
      }
    }
      // ROUND 12（运营者症状②）：**显式**声明 allowed_updates。此前完全省略 —— 而 Telegram
      // 对省略的语义是"沿用**上一次**的 allowlist"。一旦历史上任何一次调用（旧版本 / 别的
      // 工具 / 手工调试）把它设成不含 `edited_message`，编辑事件就会被 **TG 端永久静默丢弃**：
      // poll 里根本收不到该 update，桥的编辑分支（`tg edit has no queued item` / 原地替换）
      // 永远得不到任何输入 —— 正是运营者反复反馈的"对已发消息的修改不会被注入"。
      // 显式写全=消除这个**服务端粘滞**状态。三类与桥实际消费的类型严格一致
      // （grep 证实仅 message / edited_message / callback_query）。
      const url = `${apiBase}/getUpdates?offset=${encodeURIComponent(offset)}&limit=10&timeout=20&allowed_updates=%5B%22message%22%2C%22edited_message%22%2C%22callback_query%22%5D`
      pollAbort = new AbortController()
      const res = await fetch(url, {
        signal: AbortSignal.any([pollAbort.signal, AbortSignal.timeout(30_000)]),
      })
      if (!res.ok) {
        // 409 = 同一 token 上有第二个轮询者。只打状态码无法定位是谁在撞，
        // 必须带上实例身份（owner 租约持有者 / 自己的 id / 代号 / 进程）。
        let holder = "?"
        try {
          holder = String((JSON.parse(readFileSync(OWNER_PATH, "utf8")) as any)?.tg?.id ?? "?")
        } catch {
          /* unreadable */
        }
        const detail = `getUpdates failed: ${res.status} (status=${res.status}, holder=${holder.slice(0, 8)}, me=${shortId}, gen=${myGen}, pid=${process.pid})`
        const authRejected = res.status === 400 || res.status === 401 || res.status === 403
        if (authRejected) {
          authFailStreak++
          if (authFailStreak >= 3) {
            authDisabled = true
            await log(
              "error",
              `getUpdates auth rejected ${authFailStreak}x; polling stopped (bot=${BOT_ID}). ` +
                `Update the token and reload the bridge. ${detail}`,
            )
            stopPolling()
            return
          }
        } else {
          authFailStreak = 0
        }
        if (isRoutinePollStatus(res.status)) {
          // R1861：5xx 是服务端瞬时（本轮未消费 update、offset 不变，下一轮自愈）。
          // 降级 info + 节流（复用 pollTimeoutLogAt），不再污染健康信号；409/4xx 仍走 error。
          if (Date.now() - pollTimeoutLogAt > 5 * 60_000) {
            pollTimeoutLogAt = Date.now()
            await log("info", `long poll server error (routine, will retry): ${detail}`)
          }
        } else {
          await log("error", detail)
        }
        return
      }
      const j = (await res.json()) as any
      // R1879：HTTP 200 也可能带 `ok:false`（error_code/description），或干脆不是对象。
      // 旧实现只测 `Array.isArray(j?.result)` → 一律当"本轮无消息"：**零日志**（连 error_code
      // 都不留痕；本文件其他 Telegram 调用都查了 `j.ok`，唯独 getUpdates 这处不查），
      // 且把**失败的轮次记成健康的空轮** —— 上游在拒绝我们，日志里却看不出任何异常。
      // 规则：**失败轮不记账**（不刷新同伴账本、不推进 offset、不记入站），一律早退。
      if (!j || typeof j !== "object" || j.ok === false) {
        const code = Number(j?.error_code ?? 0)
        const desc = String(j?.description ?? (j ? "(no description)" : "(non-object body)")).slice(0, 120)
        const shown = Number.isFinite(code) && code > 0 ? String(code) : "?"
        const detail =
          `getUpdates not ok: status=200 error_code=${shown} ${desc} ` +
          `(me=${shortId}, gen=${myGen}, pid=${process.pid})`
        const authRejected = code === 400 || code === 401 || code === 403
        if (authRejected) {
          authFailStreak++
          if (authFailStreak >= 3) {
            authDisabled = true
            await log(
              "error",
              `getUpdates auth rejected ${authFailStreak}x; polling stopped (bot=${BOT_ID}). ` +
                `Update the token and reload the bridge. ${detail}`,
            )
            stopPolling()
            return
          }
        } else {
          authFailStreak = 0
        }
        // 429（限流）与 5xx 属瞬时：降级 info + 节流，不让上游抖动冒充 poll error。
        if (code === 429 || isRoutinePollStatus(code)) {
          if (Date.now() - pollTimeoutLogAt > 5 * 60_000) {
            pollTimeoutLogAt = Date.now()
            await log("info", `getUpdates transient (routine, will retry): ${detail}`)
          }
        } else {
          await log("error", detail)
        }
        return // 关键：不走 touchPeer、不推进 offset、不 noteInbound
      }
      const result = Array.isArray(j?.result) ? j.result : []
      authFailStreak = 0
      // R1758：每次 poll 返回都刷新同伴账本（**含空数组**），否则没收到消息的 bot
      // 永远读不到同伴领先 → 落 no-peer → 不报警（自我抑制死结，见 touchPeer 注释）。
      touchPeer()
      if (result.length > 0) noteInbound()
      for (const u of result) {
        await handleUpdate(u)
      }
      if (result.length > 0) {
        const lastId = Number(result[result.length - 1]?.update_id ?? 0)
        if (Number.isFinite(lastId)) commitOffset(lastId)
      }
      try {
        await flushQueue()
      } catch {
        /* best-effort */
      }
      // R1740：入站静默告警。**必须在"成功返回"分支里评估**（含 result 为空）——
      // R1739 查到的 bot3 那 59 秒窗口就是这个形态：没有 poll error、没有 drop、
      // 没有任何日志，当场完全无痕。空返回本身是常态（长轮询 30s 超时 + 用户不说话），
      // 所以判据只看**持续时长**，由 inboundSilenceVerdict 处理（已双向验证 + 8 变异体）。
      const sv = inboundSilenceVerdict({
        now: Date.now(),
        lastInboundAt,
        restoredAt: j.lastinbound ?? 0,
        bootAt: botBootAt,
        peerLastInboundAt,
        thresholdMs: 10 * 60_000,
        throttleMs: 30 * 60_000,
        lastWarnAt: lastInboundSilentWarnAt,
        // 照抄 protoSilentVerdict 调用的同一写法（见下方 watchdog 处）：
        // 用 globalThis 上的 GEN_KEY 标记判断自己是不是当前代。**不要自己发明别名** ——
        // 我第一版写了 `currentGen()` 这个并不存在的函数，而 bun build 不会报未定义标识符，
        // 于是构建门禁给了假绿。判据引用的每个符号都必须 grep 出定义。
        isCurrentGen: (globalThis as Record<string, unknown>)[GEN_KEY] === myGen,
      })
      // ⚠️ R1779 重大更正：此告警**降级为 info 诊断，不再作为 error 上报**。
      //
      // R1779 用 getMe 逐个核对了三个 token 的真实身份（决定性证据）：
      //   tg.env        (primary) → @codecilbot      id=8892941675
      //   tg-fallback.env (alt)   → @opencodev2_bot  id=8964069383
      //   tg-bot3.env   (bot3)    → @cilv2bot        id=8858162646
      // **三个 token 对应三个不同的 Telegram bot，各有独立 getUpdates 队列。**
      // → 我 R1743 起赖以成立的隐含前提「三个 bot 共享同一个消息源」**是假的**。
      //   用户只跟 alt 说话时，primary/bot3 收不到 update 是**完全正常的**。
      // → `peer-ahead`（"同伴有流量而我没有 = 我坏了"）在原理上**无法判定**：
      //   同伴的流量对另一个 bot 的健康状况**不构成任何证据**。
      //
      // 而"不可判定"我却按 error 上报，等于把一个无法证伪的猜测包装成故障结论，
      // 正是我一路在反对的信号稀释。按 R1743 自己写下的取舍原则（宁可漏报不要误报）降级。
      //
      // 保留 info 诊断是为了**保留可观测性**：真出故障时有人能查"这个 bot 多久没收到 update"。
      // 若将来要做可靠的入站故障检测，唯一可行方向是**每个 bot token 单消费者 + 自行计数**
      // （现状已如此），并配合"Telegram 侧确实有未投递消息"的独立证据 —— 而不是跨 bot 比较。
      if (sv.silent && Date.now() - lastInboundSilentWarnAt > 6 * 3600_000) {
        lastInboundSilentWarnAt = Date.now()
        // R1778：必须打 reason。只打 basis 时，reason="peer-ahead" 会显示成「基准=boot」，
        // 读起来像纯时长告警 —— 我据此白绕了一整轮。basis 与 reason 是两个维度，缺一不可读。
        await log(
          "info",
          `[diag] inbound idle ${Math.round(sv.durationMs / 60_000)}min (bot=${BOT_ID}, reason=${sv.reason}, 基准=${sv.basis}): ` +
            `轮询活着（心跳照常、无 poll error）但无入站。` +
            `⚠️ **这不是故障判定**：三 bot 是三个独立 Telegram bot（@codecilbot / @opencodev2_bot / @cilv2bot），` +
            `用户未对本 bot 说话时本就是静默，跨 bot 比较无法判定本 bot 是否漏收（R1779）。`,
        )
      }
    } catch (err) {
      const why = sanitizeLog(err)
      if (/abort/i.test(why) && pollAbortTakenOver) {
        await log("info", `long poll aborted (lease taken over by a newer instance, id=${shortId})`)
      } else if (/timeout|timed out|TimeoutError/i.test(why)) {
        // 长轮询**超时是常态**（客户端按设计在超时后结束本轮、随即重发）。
        // 记成 error 会污染"近 N 分钟 0 error"这个我整轮都在用的健康信号 ——
        // 真错误会被噪声淹没。现降级为 info 并节流（每 5 分钟一条）。
        if (Date.now() - pollTimeoutLogAt > 5 * 60_000) {
          pollTimeoutLogAt = Date.now()
          await log("info", `long poll timeout (routine, will retry: ${why.slice(0, 90)})`)
        }
      } else if (isRoutinePollError(why)) {
        // R1850：链路/对端瞬断（TLS 非正常终止 GnuTLS -110、ECONNRESET、socket hang up…）
        // 与超时同族 —— 本轮结束、下一轮立即重发即可自愈。降级 info + 节流，
        // 不再让可恢复抖动冒充"poll error"污染健康信号。真错误仍走下面的 error 分支。
        if (Date.now() - pollTimeoutLogAt > 5 * 60_000) {
          pollTimeoutLogAt = Date.now()
          await log("info", `long poll transient network (routine, will retry: ${why.slice(0, 90)})`)
        }
      } else {
        await log("error", `poll error: ${why}`)
      }
    } finally {
      pollAbort = null
      polling = false
    }
    // 补跑挂起的 offset 自愈（必须在 polling 归零之后，否则又会自撞）。
    if (sanityPendingReason) {
      const why = sanityPendingReason
      sanityPendingReason = null
      setTimeout(() => {
        runOffsetCheck(`deferred:${why}`)
      }, 2000)
    }
  }


  // ── offset 自愈 ────────────────────────────────────────────────
  // 症状：poll 循环活着、租约正常，但**一条入站消息都收不到**（命令/菜单全无反应）。
  // 原因：状态文件里的 offset 被写成了**另一个 Bot 的 update_id 空间**（多 Bot 改造
  // 期间两个实例共用过同一份状态/env），领先真实计数几亿 → Telegram 会把所有
  // update_id < offset 的更新直接丢弃，且不报错。
  // 自愈：用 `getUpdates?offset=-1&limit=1` 做**只读窥视**（负 offset 不确认、不消费、
  // 不与运行中的 poller 冲突）。若窥视到的最新 id 小于我们存的 offset，说明领先了，
  // 立刻把 offset 拉回该 id（宁可重放最近一条，也不要静默丢弃全部）。
  const peekLatestUpdateId = async (outer?: AbortSignal): Promise<number | null> => {
    try {
      // 外部信号（换代/丢租约）+ 15s 超时；AbortSignal.any 任一触发即中断。
      const signal = outer
        ? AbortSignal.any([outer, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000)
      // ROUND 12：窥视也必须带同一个 allowlist，否则它可能继承**旧的**受限设置、
      // 看不到编辑类 update，自愈判据随之失真。
      const r = await fetch(`${apiBase}/getUpdates?offset=-1&limit=1&allowed_updates=%5B%22message%22%2C%22edited_message%22%2C%22callback_query%22%5D`, {
        headers: { "content-type": "application/json" },
        signal,
      })
      if (!r.ok) return null
      const j: any = await r.json().catch(() => null)
      const arr = Array.isArray(j?.result) ? j.result : []
      if (arr.length === 0) return null
      const id = Number(arr[arr.length - 1]?.update_id)
      return Number.isFinite(id) ? id : null
    } catch {
      return null
    }
  }
  // 兄弟基线：扫描其它 Bot 的状态文件，取它们 lastRealUpdateId 的最大值。
  // 只在本实例自己没有任何真实处理记录时使用（否则自己就是最准的基线）。
  const siblingBaseline = (): number | null => {
    if (lastRealUpdateId > 0) return null
    let best = 0
    for (const f of globSync(`REDACTED_ROOT/.config/opencode/tg-chats*.json`)) {
      if (f === STATE_PATH) continue
      try {
        const j = JSON.parse(readFileSync(f, "utf8")) as any
        const v = Number(j?.lastRealUpdateId ?? 0)
        if (Number.isFinite(v) && v > best) best = v
      } catch {
        /* ignore */
      }
    }
    return best > 0 ? best : null
  }
  /** offset 自检的**安全调用器**：自检是"丢消息风险"的关键路径（offset 领先真实计数时
   *  Telegram 会静默丢弃全部入站），而 sanityCheckOffset 内部**没有 try**；
   *  用 `void` 直接调用时一旦抛异常会**完全静默**（插件宿主里连日志都不会有）。
   *  ⚠️ 用 reason 作参数而不是把它插进模板字面量 —— 否则 reason 里含反引号时会生成
   *     嵌套模板（TS 语法错误，R997 踩过）。 */
  const runOffsetCheck = (reason: string): void => {
    void sanityCheckOffset(reason).catch((e: unknown) => {
      void log("error", `offset sanity check failed (${reason}): ${sanitizeLog(e).slice(0, 140)}`)
    })
  }
  const sanityCheckOffset = async (reason: string): Promise<void> => {
    // getUpdates 与本实例的长轮询**互斥**：Telegram 对同一 token 上任何并发 getUpdates
    // 都返回 409，并且会掐断正在等待的那一个 —— 即使我们用的是 offset=-1（不消费）。
    // 症状：启动 8 秒后的自检正好撞上刚起来的长轮询，自己把自己打成 409（两个 Bot
    // 会在同一毫秒各 409 一次，因为它们是同一时刻加载的）。
    // 处理：轮询在飞就挂起，等这一轮 poll 结束后再补跑。
    if (polling) {
      sanityPendingReason = reason
      return
    }
    // R2507：`peekLatestUpdateId` 本身也是一次 getUpdates。只检查 polling 再 await
    // 仍有竞态：检查后、peek 发出前，2s 的 poll 定时器可能刚好进入 poll → 两边并发，
    // Telegram 对**两边**都回 409（实测每次启动自检都会刷 4–5 条 409）。
    // 先占住 polling（poll 定时器看到 true 会直接 return），peek 完成/异常后释放。
    polling = true
    sanityAbort = new AbortController()
    try {
      const real = await peekLatestUpdateId(sanityAbort.signal)
      // R1818：判定提成纯函数 offsetRewindTarget（_v2compat），分支互斥且穷举。
      // 旧实现在这里把**常态** ahead=1 当成「offset 越界」并回退到 real = 已处理过的那条，
      // 再 seenUpdates.clear() → 重载后那条会被重新投递、重复回复用户。
      // 02:06:44.950Z 生产实证：stored=530870734 server=530870733 ahead=1; rewinding。
      const rw = offsetRewindTarget({
        stored: persistedOffset,
        real,
        lastReal: lastRealUpdateId,
        // 无条件求值是无害的（纯函数只在 real===null 时才读它）；不写成条件求值是为了
        // 免得「什么时候求值」变成一条隐含契约，日后改纯函数时踩坑。
        sibling: siblingBaseline(),
      })
      if (rw.target === null) return

      await log(
        "error",
        `${rw.why === "sibling-space" ? "offset implausible vs sibling" : "offset ahead of server"} (${reason}): stored=${persistedOffset} target=${rw.target} server=${real ?? "null"} lastReal=${lastRealUpdateId} ahead=${real === null ? "n/a" : persistedOffset - real} why=${rw.why}; rewinding (入站会被静默丢弃)`,
      )
      // ★ 必须同时写**内存态** offset。旧代码只写 persistedOffset，而
      //   `let offset = persistedOffset` 一辈子只在 setup 跑一次 → 自愈在**当前活实例**
      //   里完全无效，必须等下次热重载才生效 —— 而那恰好是最坏的时机：重载会把已回退的
      //   落盘值灌进 offset，使**已处理过的 update 被重新投递**。
      //   R1818 实测：02:06:44 那次回退当场就是无效的（当时靠 40 秒后的新入站
      //   把落盘值又推回去而侥幸没出事，不是设计）。
      offset = rw.target
      persistedOffset = rw.target
      seenUpdates.clear()
      savePersistedState()
    } finally {
      sanityAbort = null
      polling = false
    }
  }

  // 换代宽限：新实例在 setup 里就抢走了 tg 租约，但旧实例可能还挂着 20 秒长轮询，
  // 而它的看门狗最多 3 秒后才会中断。若新实例 POLL_MS(2s) 就首 poll，必然与旧实例
  // 撞一次 409（两个 Bot 同一毫秒各一次）。把首轮延后到看门狗之后 → 抖动归零。
  // 冷启动没有旧实例，这个 4s 只是入站首条消息的固定延迟，可接受。
  // R1728 投递静默 watchdog：只**告警不自动重载**。
  // 不自动重载的理由：自动重载可能打断正在进行的一次对话/提问，风险不对称；
  // 而这次故障的代价是"静默 30 分钟无人知晓"，告警已经把"不可观测"变成"可观测"。
  // 判据要严：仅当「本 Bot 桥已加载完成 + 投静音默超阈值 + 循环本身没停」时才报，
  // 否则深夜无人值守时会刷出一堆"正常安静"的假警报。
  const PROTO_SILENT_WARN_MS = 12 * 60_000
  const PROTO_SILENT_THROTTLE_MS = 15 * 60_000
  setInterval(() => {
    const now = Date.now()
    const v = protoSilentVerdict(now, lastProtoSendAt, lastProtoSilentWarnAt, {
      thresholdMs: PROTO_SILENT_WARN_MS,
      throttleMs: PROTO_SILENT_THROTTLE_MS,
      loopStopped: loopStopped(),
      isCurrentGen: (globalThis as Record<string, unknown>)[GEN_KEY] === myGen,
      paused: pausedMode, // R1905：主动暂停推送时不误报"断流"
    })
    if (!v.warn) return
    lastProtoSilentWarnAt = now
    void log(
      "warn",
      `proto silent ${v.minutes}min (bot=${BOT_ID}): 桥仍活着但没有成功投递过。` +
        `若循环正在注入，疑似热重载半完成导致事件流断开 → 需 reload 桥：` +
        `touch REDACTED_ROOT/.config/opencode/plugins/tg-bridge-v2.ts（重载入口）或 opencode service restart`
    )
  }, 5 * 60_000)
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let bootTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    pollTimer = setInterval(() => {
      void poll()
    }, POLL_MS)
  }, 4000)
  // R2708：热重载完成后自动发一条短提示。等首轮 poll 宽限（4s）过去、租约切换稳定后
  // 再发；若已被更新实例取代或丢了租约，静默跳过（旧实例不得抢发）。
  // 只提示「热重载」：冷启动不调度，避免每次 CI run 都多一条消息。
  const reloadNoticeTimer: ReturnType<typeof setTimeout> | null = isHotReload
    ? setTimeout(() => {
        void (async () => {
          try {
            if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
            if (!ownsPollLease()) return
            const chat = PUSH_CHAT || [...allowedNorm][0] || ""
            if (!chat) return
            const now = Date.now()
            if (!claimReloadNotice(globalThis as Record<string, unknown>, chat, now)) return
            const text = reloadNoticeText({ ver: VERSION, bots: reloadBots(globalThis as Record<string, unknown>, now), at: now, fmtTime })
            await reply(chat, text)
            await log("info", `reload notice sent (bot=${BOT_ID}, chat=${sanitizeLog(chat)}, ver=${VERSION}, from=${reloadState.previousVer ?? "?"})`)
          } catch (err) {
            await log("warn", `reload notice failed (bot=${BOT_ID}): ${sanitizeLog(err).slice(0, 120)}`)
          }
        })()
      }, 7000)
    : null
  // R2653：稍等首轮推送结束再收上一进程遗留的「⏳ 自动…进行中」提示，避免与
  // 启动回扫抢 Telegram 发送节奏。一次性定时器，换代时随 stopPolling 一起收掉。
  const automationRecoverTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
    void recoverStaleAutomation()
  }, 8000)
  // 换代/停止时把两个句柄都收掉（首轮宽限的 setTimeout 也算，否则会留一个孤儿定时器）
  const stopPolling = (): void => {
    try {
      if (bootTimer) clearTimeout(bootTimer)
    } catch {
      /* ignore */
    }
    try {
      if (pollTimer) clearInterval(pollTimer)
    } catch {
      /* ignore */
    }
    try {
      clearTimeout(automationRecoverTimer)
    } catch {
      /* ignore */
    }
    if (reloadNoticeTimer) {
      try {
        clearTimeout(reloadNoticeTimer)
      } catch {
        /* ignore */
      }
    }
    bootTimer = null
    pollTimer = null
  }
  // 租约看门狗：热重载时新实例会在 setup 里抢占 tg 租约；旧实例若还挂着 20 秒长轮询，
  // 新实例的第一次 getUpdates 就会 409（两个 Bot 同一毫秒各撞一次）。这里每 3 秒查一次，
  // 一旦发现自己已不是租约持有者，立刻中断在飞请求 —— 换代抖动从 ~20s 压到 ≤3s。
  const leaseWatch = setInterval(() => {
    void (async () => {
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) {
        // 被新实例取代：连看门狗一起停，避免每次热重载都留下一个 3s 的空转定时器。
        // **但必须先中断在飞的长轮询** —— 否则旧实例那次 20 秒 getUpdates 还在挂着，
        // 新实例首 poll 必然 409（实测每次重载每个 Bot 各 1 次）。既然要走了，断掉无损。
        if (pollAbort) {
          pollAbortTakenOver = true
          try {
            pollAbort.abort()
          } catch {
            /* already gone */
          }
        }
        // peek 也可能在飞（它不受 pollAbort 管），一并断掉，避免旧实例继续占着
        // 同一 token 的 getUpdates 把新实例撞 409。
        if (sanityAbort) {
          try {
            sanityAbort.abort()
          } catch {
            /* already gone */
          }
        }
        clearInterval(leaseWatch)
        return
      }
      if (!pollAbort && !sanityAbort) return
      if (ownsPollLease()) return
      pollAbortTakenOver = true
      if (pollAbort) {
        try {
          pollAbort.abort()
        } catch {
          /* already gone */
        }
      }
      if (sanityAbort) {
        try {
          sanityAbort.abort()
        } catch {
          /* already gone */
        }
      }
    })()
  }, 3000)
  // ── R1895：跨 Bot 429 提醒（每 15 秒一拍）───────────────────────────────────
  // 用户指令：某个 Bot 被 Telegram 429 限流时，**其他**机器人各发一条提示给他。
  // 自己是发不出去的（硬限流挡的是整个 Bot），所以本拍只做两件事：
  //   ① 自己已恢复 → 清掉共享标记（别的实例不再把它算作"限流中"）；
  //   ② 别人限流中 → 替它说一句，按「Bot + 本次限流起点」去重，一个实例对一个 Bot 只喊一次。
  // 全程 best-effort：任何读盘/发送失败都只记日志，绝不影响主发送路径。
  const FLOOD_WATCH_MS = 15_000
  // 通知间隔：无论几个 Bot 同时限流，本实例两次提醒至少隔 60s（避免刷屏）。
  const FLOOD_NOTICE_MIN_GAP_MS = 60_000
  // key = `${bot}:${since}` → 发出时刻。since 变了即新的一次限流，重新允许提醒一次。
  const floodNoticeSent = new Map<string, number>()
  const floodLabel = (bot: string): string => {
    if (bot === BOT_ID) return bot
    try {
      const j = JSON.parse(readFileSync(BOT_REGISTRY_PATH, "utf8")) as { bots?: Array<{ id?: string; label?: string }> }
      const label = String((j?.bots ?? []).find((b) => String(b?.id ?? "") === bot)?.label ?? "").trim()
      if (label) return `${label}（${bot}）`
    } catch {
      /* 标签只是装饰，取不到就退回 id */
    }
    return bot
  }
  const floodWatchTick = async (): Promise<void> => {
    try {
      // 陈旧热重载实例不参与：由新实例接管提醒（与其它心跳同一口径）。
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      const now = Date.now()
      // ① 自己恢复 → 清标记。clearSelfFlooded 自己会跳过"本就不存在/已过期"的情况，
      //    所以这行不会变成持续空写（文件 mtime 不变即可验证）。
      if (now >= floodGate.floodUntil) clearSelfFlooded(BOT_ID, now)
      // 自己正在限流：此时替别人喊也发不出去（sendTextRaw 直接 retry 进队列），跳过。
      if (now < floodGate.floodUntil) return
      // R2732：Telegram 限流提示属于全局信息；本 Bot 开关关闭时不再替其它 Bot 喊。
      // clearSelfFlooded 已在上方执行，跨 Bot 去重/恢复记账不受影响。
      if (!readCardOps(BOT_ID).enabled) return
      const active = activeFloods(readFloodFlagDisk(), now).filter((f) => f.bot !== BOT_ID)
      if (!active.length) return
      const chat = pushChatResolve()
      if (!chat) return
      // 顺手清掉早已过期的去重条目（限流结束超过 6 小时就不必再记住）。
      for (const [k, t] of floodNoticeSent) if (now - t > 6 * 3600_000) floodNoticeSent.delete(k)
      for (const f of active) {
        const key = `${f.bot}:${f.since}`
        if (floodNoticeSent.has(key)) continue
        const lastAt = [...floodNoticeSent.values()].reduce((a, b) => Math.max(a, b), 0)
        // 本轮先不发（还没到间隔）：**不**记 key —— 下一拍重新判断，否则永远等不到。
        if (lastAt > 0 && now - lastAt < FLOOD_NOTICE_MIN_GAP_MS) continue
        floodNoticeSent.set(key, now)
        const left = Math.max(1, Math.ceil((f.until - now) / 1000))
        const secs = Math.max(1, Math.round((now - f.since) / 1000))
        await reply(
          chat,
          `⚠️ ${floodLabel(f.bot)} 正被 Telegram 限流（429），已持续约 ${secs} 秒，预计还需约 ${left} 秒恢复；期间它发不出任何消息，恢复后会自动补发。`,
        )
        await log("info", `cross-bot 429 notice (bot=${f.bot} since=${f.since} left=${left}s)`)
      }
    } catch (err) {
      await log("error", `flood watch failed: ${sanitizeLog(err)}`)
    }
  }
  setInterval(() => {
    void floodWatchTick()
  }, FLOOD_WATCH_MS)
  // R2634：429→200 自动 fork 请求轮询。2s 一拍，远低于 watcher 写请求后的
  // 下一轮注入间隔；原子 rename 认领保证同一会话只 fork 一次。
  setInterval(() => {
    void processQuotaForkRequests()
  }, 2_000)
  // R2649/R2700：429 配额轮后的换会话请求轮询。请求在 ~/.config/opencode（随环境
  // 快照跨 run 存活），由拥有该会话的桥实例原子认领；新建会话后切换 front/pinned
  // 并注入“阅读旧会话历史，继续任务”。2s 一拍，重启后很快生效。
  setInterval(() => {
    void processRolloverRequests()
  }, 2_000)
  // 状态落盘心跳：用来一眼看出"状态文件是不是冻住了"（曾冻 15 分钟无人察觉）。
  setInterval(() => {
    void (async () => {
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      const age = stateSavedAt ? Math.round((Date.now() - stateSavedAt) / 1000) : -1
      // 这个心跳原本**只打日志**、从不落盘：空闲的 Bot（没有推送、没有入站）因此
      // 永远不写状态文件 —— 实测备用侧 proto 回收日志已打 `339 → 150`，文件却仍是
      // 801/339。状态陈旧超过 2 分钟就真正落盘一次（写盘很轻，2 分钟一次可忽略）。
      let saved = false
      if (age > 120) {
        savePersistedState()
        saved = true
      }
      const age2 = stateSavedAt ? Math.round((Date.now() - stateSavedAt) / 1000) : -1
      const tmpNow = checkTmpPressure()
      if (tmpNow.alert) await log(tmpNow.alert.includes("回落") ? "info" : "error", tmpNow.alert)
      await log(
        "info",
        `state save heartbeat:${tmpNow.text} last=${age}s${saved ? ` -> saved(age=${age2}s)` : ""} bytes=${stateSavedBytes} fails=${stateSaveFails} path=${STATE_PATH}`,
      )
    })()
  }, 60_000)
  // ── 询问兜底：事件没送达时，也要把"待答询问"送到 TG ──────────────────────
  // 实测缺陷：备用会话里躺着一个待答询问（`name='question'`、`state='running'`、
  // `executed=False`），宿主在等这个答案 → 回合永不完成 → 之后**不再发任何事件**。
  // 桥是纯事件驱动，于是那条消息它从未看到，`pushQuestionCard` 从未被调用 →
  // 询问从未出现在 TG（用户报"另一个机器人监听的会话有一个询问，TUI 看得到，
  // 但没有用 TG 推给我"）。同一件事还伪装成"7 分钟没消息"和"工具挂起"。
  // 这里定期**回读**自己负责的会话，发现没推过的待答询问就补推；不依赖事件送达。
  // 幂等：按 callID 去重，且 pushQuestionCard 自身的 proto key 也含 callID，
  // 因此事件路径随后再推时会被 hash-dup/编辑收敛，不会变成两张卡。
  const ASK_RECONCILE_MS = 45_000
  const askReconcile = async (): Promise<void> => {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    const chat = pushChatResolve()
    if (!chat) return
    const cands = new Set<string>()
    for (const s of [fixedTarget, frontSessionID, persistedFront]) {
      if (typeof s === "string" && s.startsWith("ses_")) cands.add(s)
    }
    for (const s of watchedSessions) {
      if (cands.size >= 4) break
      if (typeof s === "string" && s.startsWith("ses_")) cands.add(s)
    }
    for (const sid of cands) {
      // 归属：只补推自己负责的会话，不越权替别的 Bot 发
      if (!shouldPush(sid)) continue
      try {
        const r = await client.session.messages({ path: { id: sid } })
        const arr = Array.isArray(r?.data) ? r.data : []
        for (let i = arr.length - 1; i >= 0 && i >= arr.length - 3; i--) {
          const m: any = arr[i]
          for (const p of partsOf(m)) {
            if (String(p?.type ?? "") !== "tool") continue
            if (String(p?.tool ?? "") !== "question") continue
            const stt = String((p as any)?.state?.status ?? "")
            if (stt !== "running" && stt !== "pending") continue
            const callID = callOf(p)
            const key = `${sid}:${callID}`
            if (pushedAsk.has(key)) continue
            pushedAsk.add(key)
            if (pushedAsk.size > 200) {
              const first = pushedAsk.values().next()
              if (!first.done) pushedAsk.delete(first.value)
            }
            await pushQuestionCard(sid, chat, callID, (p as any).state)
            await log(
              "info",
              `ask reconciled (补推待答询问; session=${sanitizeLog(sid).slice(0, 24)}, call=${sanitizeLog(callID).slice(0, 28)}, 事件未送达)`,
            )
          }
        }
      } catch {
        /* best-effort：回读失败下一轮再试 */
      }
    }
  }
  setInterval(() => {
    void askReconcile()
  }, ASK_RECONCILE_MS)
  // ── 整体自动转后台（60s 拍）────────────────────────────────────────────
  // 只在**确有阻塞中的同步子代理**时才动：没有阻塞就没有"转后台"这回事，
  // 无条件调用只会刷无意义请求。冷却 + 会话级去重，避免同一阻塞被反复提升。
  const BG_AUTO_MS = 60_000
  const bgAutoTick = async (): Promise<void> => {
    try {
      // R1826：与 askReconcile / emitCensus / runOffsetCheck 等**所有**定时器同规则 ——
      // 陈旧热重载实例必须自停。此前**独漏**这一条：旧实例的 60s 拍仍会 fetchTail，
      // 必要时还会 POST background promote；且每次热重载都累加一个这样的陈旧实例
      // → 换代数轮后多个旧实例同时"自动转后台"、刷网络与日志。
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      const cfg = readBg()
      const sid = fixedTarget ?? frontSessionID ?? persistedFront ?? ""
      if (!cfg.enabled || !sid) return
      const msgs = await fetchTail(sid, 1)
      const parts: any[] = Array.isArray(msgs) ? (msgs[0]?.parts ?? []) : []
      // R1820：插件 client 白名单**没有** background 端点（load 时 shape-dump 实证：
      // session 键无 background、experimental.session 为空），唯一可用路是 HTTP 直连
      // （与手动「立即转后台」同路；对不存在会话探测得 404 SessionNotFound → 路由存在，不经实验开关）。
      // 修复用户反馈「菜单里的转后台按钮不能实际控制是否自动转后台」：此前把 client shape / 实验开关
      // 当硬门槛，shouldAutoPromote 第一步就判「本 build client 无后台 API」或「实验开关未开启」
      // → 开关打开也永不触发。直连可用 ⇒ 视为具备能力、且不要求实验开关。
      const httpAvail = bgHttpAvail()
      const d = shouldAutoPromote(
        parts,
        cfg,
        Date.now(),
        bgLastAttempt.get(sid) ?? 0,
        bgEnvOn() || httpAvail,
        httpAvail ? undefined : bgApiShape(client),
      )
      if (!d.go) {
        if (Date.now() - bgLastWhyLogAt > 10 * 60_000) {
          bgLastWhyLogAt = Date.now()
          await log("info", `bg-auto idle: session=${sanitizeLog(sid).slice(0, 12)} why=${sanitizeLog(d.why)}`)
        }
        return
      }
      bgLastAttempt.set(sid, Date.now())
      const sessAny = (client as any)?.session
      const expSess = (client as any)?.experimental?.session
      const fn = sessAny?.background ?? expSess?.background
      if (typeof fn !== "function") {
        await automationStart("bg", `会话：${sid.slice(0, 12)}`)
        const hr = await bgHttpPromote(sid)
        await log(hr.ok ? "info" : "warn", `bg-auto http-fallback: ${hr.text.slice(0, 140)} (session=${sanitizeLog(sid).slice(0, 12)})`)
        await automationEnd("bg", hr.ok, hr.ok ? `会话 ${sid.slice(0, 12)} 已转后台` : hr.text.slice(0, 160))
        return
      }
      try {
        await automationStart("bg", `会话：${sid.slice(0, 12)}`)
        await fn.call(sessAny?.background ? sessAny : expSess, { sessionID: sid })
        await log("info", `bg-auto promoted: session=${sanitizeLog(sid).slice(0, 12)} why=${sanitizeLog(d.why)}`)
        await automationEnd("bg", true, `会话 ${sid.slice(0, 12)} 已转后台`)
      } catch (err) {
        await log("error", `bg-auto failed: session=${sanitizeLog(sid).slice(0, 12)} err=${sanitizeLog(String(err)).slice(0, 120)}`)
        await automationEnd("bg", false, sanitizeLog(String(err)).slice(0, 160))
      }
    } catch (err) {
      await log("error", `bg-auto tick error: ${sanitizeLog(String(err)).slice(0, 120)}`)
    }
  }
  setInterval(() => {
    void bgAutoTick()
  }, BG_AUTO_MS)
  // ── ctx 周期刷新（5 分钟） ────────────────────────────────────────────
  // `backfillCtxUsage` 原先只在**完全没有值**时才触发（兜底），所以事件路径一旦给出值，
  // 兜底就不再跑 → 刷新节奏取决于"哪些轮次带 token 数据"，实测最长可达 7 分钟，
  // 于是每张卡片都挂"（N 分钟前）"。这里让它按固定节奏主动刷新：读会话消息 → 走
  // noteUsage 的同一套合理性判断 → 更新显示值。它按设计**不会**把累计口径的账本值写进
  // ctxUsage（避免 100% 假象），所以周期调用是安全的。
  const CTX_REFRESH_MS = 5 * 60_000
  // 探测诊断的节流：同一会话只提示一次"读到数据但取不到时间戳"
  const compactionProbeLogged = new Set<string>()
  let baselineSeedCount = 0
  // 宿主自动压缩的**第二条探测**，以及**唯一会真的发到 TG** 的提示。
  // 为什么必须有第二条探测：2026-09-26T15:36 实测主会话 ctx 从 498.1k(48%) 掉到 42.7k(4%)，
  // 而那一刻 `session.latestCompaction` **没有变化** → 唯一那条时间戳探测**根本没看到这次压缩**。
  // 结论：靠 API 时间戳判断"有没有发生压缩"不可靠；而 ctx 跌落正是用户自己在手机上看到的症状。
  // 为什么以前手机上什么都没有：观测分支**只 log 一行、不发卡**（用户报「你刚刚的压缩没有发」）。
  const lastCompactTotal = new Map<string, number>()
  const COMPACT_DROP_RATIO = 0.6
  // 门槛：只有"积累了相当多上下文"之后的骤降才算压缩事件，避免小数字抖动/换模型窗口误报。
  const COMPACT_MIN_BEFORE = 50_000
  // 同一场压缩的迟到观测可以晚到 4-6 分钟（实测）：3 分钟只挡即时重复，
  // 额外的 confirmedWindow 专门挡「已由 event/autoc/api 确认后，ctxdrop 又报一次」。
  const COMPACT_NOTICE_DEDUPE_MS = 180_000
  const COMPACT_CONFIRMED_WINDOW_MS = 15 * 60_000
  // latestCompaction 会滞留：超过 30 分钟的时间戳只当考古，不再发新卡。
  const COMPACT_API_MAX_AGE_MS = 30 * 60_000
  const noteHostCompaction = async (
    sid: string,
    // R1035：加 "event" —— 宿主**主动报**的 compaction 事件（最可靠的一路）。
    // R724：加 "autoc" —— 自动循环压缩成功点经共享总线上报（唯一确知的自动压缩来源）。
    how: CompactHow,
    atMs: number,
    before: number,
    after: number,
  ): Promise<void> => {
    const now = Date.now()
    const prev = lastCompactNotified.get(sid) ?? null
    const verdict = compactNoticeVerdict({
      how,
      at: atMs,
      now,
      prev,
      dedupeMs: COMPACT_NOTICE_DEDUPE_MS,
      confirmedWindowMs: COMPACT_CONFIRMED_WINDOW_MS,
      apiMaxAgeMs: COMPACT_API_MAX_AGE_MS,
    })
    // 迟到的观测仍然有价值：它可能带来真正的「压缩后水位」（event 当时只能写未知）。
    // 只更新水位样本，不发第二张卡。
    if (!verdict.send) {
      if (after > 0) lastCompactTotal.set(sid, after)
      await log(
        "info",
        `compaction notice suppressed (${verdict.why}; session=${sanitizeLog(sid).slice(0, 14)}, how=${how}, ` +
          `${compactLogDelta(before, after)}, at=${atMs})`,
      )
      return
    }
    // R719（用户点名新增的选项）：压缩通知开关（默认开）。关闭 = 不发「🗜 上下文已压缩」卡片。
    // 注意仍要更新去重状态与留痕日志：否则重新打开开关后，会把关闭期间积压的压缩事件补发一遍。
    // 静默≠失明：日志照打（result=suppressed(option)），排障时"到底发生了什么"依然可查。
    if (!compactPrefs.notice) {
      lastCompactNotified.set(sid, { at: atMs > 0 ? atMs : now, sentAt: now, how })
      lastCompactTotal.set(sid, after)
      await log(
        "info",
        `compaction notice suppressed (option off; session=${sanitizeLog(sid).slice(0, 14)}, how=${how}, ` +
          `${compactLogDelta(before, after)}, at=${atMs})`,
      )
      return
    }
    const chat = pushChatResolve()
    if (!chat) return
    lastCompactNotified.set(sid, { at: atMs > 0 ? atMs : now, sentAt: now, how })
    lastCompactTotal.set(sid, after)
    const u = ctxUsage.get(sid)
    const win = u && windowKnown(u.modelID, u.providerID) ? windowFor(u.modelID, u.providerID) : 0
    const nm = clean(sessionNameOf(sid) || "", 40) || sid.slice(0, 12)
    const exact = how === "api" ? fmtTime(atMs) : "刚刚"
    // R2667：标题/水位/来源统一由 compact-notice.ts 拼装；外层 protoBlock 只转义一次。
    const body = compactNoticeBody({ name: nm, before, after, win, how, exact })
    // sendTextRaw 是**直调**的（不经过 protoSend）→ 成功时一行日志都不打，
    // "到底发没发"在日志里完全看不出来（L1932 的同款教训）→ 必须留痕。
    // 这次**不静默**：用户明确说过"压缩没有发"，静默卡片等于又发了个没用的东西。
    const r = await sendTextRaw(chat, protoBlock(compactTitle(how), body), undefined, false)
    await log(
      "info",
      `compaction notice (session=${sanitizeLog(sid).slice(0, 14)}, how=${how}, ` +
        `${compactLogDelta(before, after)}, result=${r.r}, at=${atMs})`,
    )
  }
  // ── R724：压缩总线消费（15s 拍）────────────────────────────────────────
  // auto-continue 的 compactNow 成功点把事件写到 globalThis `__oc_compaction_events__`
  // （与 __oc_model_windows__ 同族：同进程模块无法直接互调，走全局总线）。
  // 为什么必须补这一路：宿主 compaction 事件每事件只投一个 handler，非拥有者收到即丢
  // （R722 实证「compaction event for non-owned session ignored」而拥有者无处理行）；
  // API 时间戳会滞留、ctx 骤降依赖新样本 —— 自动压缩时三路都可能漏。此路 = 确知事件。
  // 归属判据与 event 路逐字一致；多实例同时看到总线时以「先摘取者消费」避免重复发卡
  // （单线程内 splice 原子）；去重与开关仍由 noteHostCompaction 统一兜底。
  const COMPACTION_BUS_KEY = "__oc_compaction_events__"
  const COMPACTION_BUS_TTL_MS = 10 * 60_000
  const consumeCompactionBus = async (): Promise<void> => {
    const G = globalThis as Record<string, unknown>
    const arr = G[COMPACTION_BUS_KEY]
    if (!Array.isArray(arr) || arr.length === 0) return
    const nowMs = Date.now()
    const claimed: Array<{ sid: string; at: number; reason: string }> = []
    for (let i = arr.length - 1; i >= 0; i--) {
      const ev = arr[i] as { sid?: unknown; at?: unknown; reason?: unknown } | undefined
      const sid = String(ev?.sid ?? "")
      const at = Number(ev?.at ?? 0)
      // TTL 丢弃：重启积压 / 换代太久的事件不再补发（避免"压缩卡穿越"）。
      if (!sid.startsWith("ses_") || !Number.isFinite(at) || nowMs - at > COMPACTION_BUS_TTL_MS) {
        arr.splice(i, 1)
        continue
      }
      const scopeOwnB = process.env.TG_SCOPE_TO_OWN_CHAT !== "0"
      const ownBus =
        !scopeOwnB || ownSessions.has(sid) || fixedTarget === sid || frontSessionID === sid || persistedFront === sid
      if (!ownBus) continue // 归属其他实例：留在总线里等它消费
      arr.splice(i, 1)
      claimed.push({ sid, at, reason: String(ev?.reason ?? "") })
    }
    for (const c of claimed) {
      // 与 host event 路同款：压缩前水位 → 清零 → 尽力重建压缩后（拿不到就如实未知）。
      const uBefore = ctxUsage.get(c.sid)
      const beforeTotal = uBefore ? ctxTotal(uBefore) : 0
      ctxUsage.delete(c.sid)
      try {
        await backfillCtxUsage(c.sid)
      } catch {
        /* best-effort：下一轮再试 */
      }
      const uAfter = ctxUsage.get(c.sid)
      const rawAfter = uAfter ? ctxTotal(uAfter) : 0
      const afterTotal = rawAfter > 0 && rawAfter < beforeTotal ? rawAfter : 0
      await log(
        "info",
        `compaction bus (autoc): session=${sanitizeLog(c.sid).slice(0, 14)}, ` +
          `reason=${sanitizeLog(c.reason).slice(0, 60)}, ${compactLogDelta(beforeTotal, afterTotal)}, at=${c.at}`,
      )
      await noteHostCompaction(c.sid, "autoc", c.at, beforeTotal, afterTotal)
    }
  }
  setInterval(() => {
    void (async () => {
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      await consumeCompactionBus()
    })()
  }, 15_000)
  setInterval(() => {
    void (async () => {
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      const targets = new Set<string>()
      for (const s of [fixedTarget, frontSessionID, persistedFront]) {
        if (typeof s === "string" && s.startsWith("ses_")) targets.add(s)
      }
      for (const s of watchedSessions) {
        if (targets.size >= 3) break
        if (typeof s === "string" && s.startsWith("ses_")) targets.add(s)
      }
      for (const sid of targets) {
        // 回填**前**留一份累计值与模型：压缩会让它骤降，只有拿回填前的数字才判得出"降了"。
        const prevU = ctxUsage.get(sid)
        const prevTotal = prevU ? ctxTotal(prevU) : 0
        const prevModel = prevU ? `${prevU.modelID}/${prevU.providerID}` : ""
        try {
          await backfillCtxUsage(sid)
        } catch {
          /* best-effort：下一轮再试 */
        }
        // 第二探测：ctx 骤降 = 压缩（API 漏报时的唯一救命通道）。
        // 门槛 + 去重都在 noteHostCompaction 里；这里只负责判"降了"。
        const nowU = ctxUsage.get(sid)
        const nowTotal = nowU ? ctxTotal(nowU) : 0
        const nowModel = nowU ? `${nowU.modelID}/${nowU.providerID}` : ""
        // R2667：换模型也会让分母/样本骤降，但这不是压缩 → 绝不发「已压缩」卡。
        const modelChanged = prevModel !== "" && nowModel !== "" && prevModel !== nowModel
        const dropVerdict = compactDropVerdict(prevTotal, nowTotal, COMPACT_MIN_BEFORE, COMPACT_DROP_RATIO)
        if (dropVerdict.fire && modelChanged) {
          await log(
            "info",
            `ctx drop ignored (model changed ${sanitizeLog(prevModel)}->${sanitizeLog(nowModel)}; ` +
              `session=${sanitizeLog(sid).slice(0, 14)}, ${prevTotal}->${nowTotal}, ${dropVerdict.why})`,
          )
        } else if (dropVerdict.fire) {
          await log(
            "info",
            `ctx drop seen (session=${sanitizeLog(sid).slice(0, 14)}, ${prevTotal}->${nowTotal}, ${dropVerdict.why})`,
          )
          await noteHostCompaction(sid, "ctxdrop", Date.now(), prevTotal, nowTotal)
        }
        // 记录**宿主自己的压缩事件**及其当时的 ctx 水位。
        // 为什么要自动记：目前"宿主在 ~45-50% 自动压缩"只有一次人工考古得到的观测，
        // 不足以当成确定阈值。自动积累样本，才能把猜测变成事实 —— 也才能判断
        // "自动压缩压不住"时该怎么办。
        try {
          const fn = (client as any)?.session?.latestCompaction
          if (typeof fn === "function") {
            const r = await fn.call((client as any).session, { path: { id: sid } })
            const d: any = r?.data ?? null
            // rowToV1 的返回形状是 `{ info: { time: { created } }, parts }` —— 时间戳在
            // **info.time.created**。我最初只试了 `d.time.created`，于是 at 恒为 0、
            // 这段代码**静默地什么都不做**（自己审计出来的"静默失败"模式，又犯了一次）。
            const at = Number(d?.info?.time?.created ?? d?.time?.created ?? d?.created ?? d?.time_created ?? 0)
            if (at <= 0 && d && !compactionProbeLogged.has(sid)) {
              // 读到了数据却取不到时间戳 → 必须留痕，否则又变成"看起来在跑其实没跑"
              compactionProbeLogged.add(sid)
              await log(
                "warn",
                `host compaction probe: got data but no timestamp (session=${sanitizeLog(sid).slice(0, 14)}, keys=${Object.keys(d).slice(0, 5).join(",")})`,
              )
            }
            if (at > 0 && at !== lastHostCompact.get(sid)) {
              const prev = lastHostCompact.get(sid) ?? 0
              lastHostCompact.set(sid, at)
              // 只在**有基线**时才发卡：prev===0 是重载后的基线播种（会读到几小时前的旧压缩），
              // 那时发卡就是纯噪声。两条探测的重复由 noteHostCompaction 去重。
              if (prev > 0) {
                const uNow = ctxUsage.get(sid)
                await noteHostCompaction(sid, "api", at, lastCompactTotal.get(sid) ?? 0, uNow ? ctxTotal(uNow) : 0)
              }
              // ⚠️ **基线播种（prev===0）不记 info**：它只表示"重载后的首次读数"，而重载很频繁
              // （实测 96 分钟 46 次）→ 每小时约 138 行这种日志（3 个会话），
              // 会把**真正的新压缩事件**埋掉。与 R1003 同源：常态不该和真事件同级。
              // 但**不能完全静默**（否则"探测是否在跑"又变成只能靠猜）→ 记 debug 级。
              if (prev <= 0) {
                baselineSeedCount += 1
                if (baselineSeedCount % 20 === 1) {
                  void log(
                    "debug",
                    `compaction baseline seeded (session=${sanitizeLog(sid).slice(0, 14)}, ` +
                      `at=${new Date(at).toISOString()}, 累计第 ${baselineSeedCount} 次（重载会重置基线，这是预期）`,
                  )
                }
                continue
              }
              const u = ctxUsage.get(sid)
              const pctNow = u && windowKnown(u.modelID, u.providerID) ? (ctxTotal(u) / windowFor(u.modelID, u.providerID)) * 100 : -1
              await log(
                "info",
                `host compaction observed (session=${sanitizeLog(sid).slice(0, 14)}, at=${new Date(at).toISOString()}, ` +
                  `since_last=${Math.round((at - prev) / 60000)}min, ctx_now=${pctNow >= 0 ? `${Math.round(pctNow)}%` : "?"})`,
              )
            }
          }
        } catch {
          /* best-effort */
        }
      }
    })()
  }, CTX_REFRESH_MS)
  void askReconcile()

  // 入站/出站定期汇总：把"消息丢了"变成可核对的数字（每个 Bot 各自一份）。
  // ⚠️ 首报**不能**等满一个周期。实测（2026-09-26 15:36→15:53 的 17 分钟内重载 7 次）
  // io census 从 15:31 起整整 24 分钟一次没出现 —— 每次重载都把 5 分钟计时器清零，
  // 而**重载恰恰是我最需要对账的时候**（改完代码正要确认"消息没丢"）。
  // → 首报提前到 60s，之后仍按 5 分钟。
  // 首报必须带 `up=`（本实例存活时长）：计数器是**每实例**的，重载后 in=0 是正常的，
  // 不标出来会被读成"入站全丢" —— 那正是今天修掉的那类误导。
  const CENSUS_MS = 300_000
  const bootedAt = Date.now()
  const emitCensus = async (): Promise<void> => {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    const c = inboundCounters
    await log(
      "info",
      `io census: in=${c.total} (cb=${c.callback} cmd=${c.command} text=${c.text} other=${c.other}) ` +
        `dropped(dupe=${c.droppedDupe} notAllowed=${c.droppedNotAllowed} noMsg=${c.droppedNoMessage}) ` +
        `out=${c.outbound} outFail=${c.outboundFail} up=${Math.round((Date.now() - bootedAt) / 1000)}s`,
    )
  }
  setTimeout(() => {
    void emitCensus()
  }, 60_000)
  setInterval(() => {
    void emitCensus()
  }, CENSUS_MS)
  // 卡死看门狗：某个 tool/shell 停在 running（宿主没再发完成事件）时，手机上会一直
  // 显示"执行中"。用户明确反馈过"实际已经完成了却一直显示执行中"，所以这里改成
  // **先核对真实状态再改写**，而不是一律写"状态未知"：
  //   ① 3 分钟没新事件就介入（15 分钟太久，用户视角就是"一直"）；
  //   ② 按会话一次性拉取消息，按 callID 找该工具的真实状态；
  //   ③ 真实状态已是终态（completed/error）→ 改写成"✅ 已完成/❌ 失败（已核对真实状态）"；
  //   ④ 仍是 running/pending → 改写成"状态未知（可能已中断）"。
  // 本宿主工具跑完不发完成事件 → 对账是主路径。旧值 3 分钟 + 5 分钟节流意味着
  // 每张长命令的卡片都要"执行中"干躺 3-8 分钟（用户反馈"执行中的工具不会被更新"）。
  const TOOL_STALE_MS = 60_000
  const staleChecked = new Map<string, number>()
  // callID → 真实状态（按会话缓存一次，避免每个 key 都拉一次）
  const toolStateCache = new Map<string, Map<string, { status: string; part: any }>>()
  const fetchToolStates = async (sid: string): Promise<Map<string, { status: string; part: any }>> => {
    const cached = toolStateCache.get(sid)
    if (cached && Date.now() - (staleChecked.get(`__ts__${sid}`) ?? 0) < 30_000) return cached
    const out = new Map<string, { status: string; part: any }>()
    try {
      const res = await client.session.messages({ path: { id: sid } })
      const arr = Array.isArray(res?.data) ? res.data : []
      for (const m of arr) {
        for (const p of partsOf(m)) {
          if (String(p?.type ?? "") !== "tool") continue
          const cid = callOf(p)
          const stt = String((p as any)?.state?.status ?? "")
          // 连 part 一起存：对账要靠它**重渲染真卡片**（只存状态就只能发一行通知）
          if (cid && stt) out.set(cid, { status: stt, part: p })
        }
      }
    } catch {
      return out
    }
    toolStateCache.set(sid, out)
    staleChecked.set(`__ts__${sid}`, Date.now())
    return out
  }
  setInterval(() => {
    void (async () => {
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      const now = Date.now()
      // 回收已完成的工具键（按插入序，Map 保持插入序）：只回收既不是 :input、
      // 也没有被看门狗/专用索引跟踪的键 —— 正在运行或有卡待纠正的绝不能动。
      {
        let toolKeys = 0
        for (const k of protoMap.keys()) if (k.includes(":tool:")) toolKeys++
        if (toolKeys > TOOL_KEYS_MAX) {
          let excess = toolKeys - TOOL_KEYS_MAX
          for (const k of [...protoMap.keys()]) {
            if (excess <= 0) break
            if (!k.includes(":tool:")) continue
            if (k.endsWith(":input")) continue
            if (staleToolBorn.has(k)) continue
            if (staleCardIdx.has(k)) continue
            protoMap.delete(k)
            excess--
          }
          void log("info", `proto tool keys trimmed (${toolKeys} → ${toolKeys - (toolKeys - TOOL_KEYS_MAX)})`)
          // 回收只改内存的话，重启后又会从旧文件载回满表 —— 必须立刻落盘。
          savePersistedState()
        }
      }
      const chat = pushChatResolve()
      if (!chat) return
      const bySess = new Map<string, Array<[string, number]>>()
      for (const [key, born] of [...staleToolBorn]) {
        if (now - born < TOOL_STALE_MS) continue
        if (now - (staleChecked.get(key) ?? 0) < 60_000) continue
        staleChecked.set(key, now)
        const idxPre = staleCardIdx.get(key.replace(/:input$/, ""))
        const rec = protoMap.get(key)
        if (!rec && !idxPre) {
          // 拿不到 message id 就无法改写这张卡片。**必须留痕**：否则"永远执行中"
          // 就是无声故障（用户实测过，且日志里一条痕迹都没有）。
          await log(
              "error",
              `stale tool card unrepairable (no msg id, card may stay running): key=${sanitizeLog(key).slice(0, 60)}`,
            )
          staleToolBorn.delete(key)
          continue
        }
        const sess = key.split(":")[0] ?? ""
        const arr = bySess.get(sess) ?? []
        arr.push([key, born])
        bySess.set(sess, arr)
      }
      for (const [sess, items] of bySess) {
        const states = await fetchToolStates(sess)
        for (const [key, born] of items) {
          const idx = staleCardIdx.get(key.replace(/:input$/, ""))
          const rec = protoMap.get(key)
          if (!rec && !idx) {
            await log(
              "error",
              `stale tool card unrepairable (no msg id, card may stay running): key=${sanitizeLog(key).slice(0, 60)}`,
            )
            staleToolBorn.delete(key)
            continue
          }
          const callID = staleCallId(key)
          const hit = states.get(callID)
          const real = hit?.status ?? ""
          // 同一 key + 同一终态已被另一条路径纠正过 → 不再重写（否则长相在两者间来回跳）。
          if (alreadyReconciled(key, real)) continue
          const mins = Math.round((now - born) / 60_000)
          const msgId = rec?.id ?? idx?.id ?? 0
          const fb = rec?.fallback === true || idx?.fallback === true
          let r: { r: string }
          // 本次是「就地替换状态行」还是「整张重渲染」？没有这个判别信号就只能猜，
          // 而本轮最大的教训正是：别拿推断当结论。
          let preserved = false
          if (hit && (real === "completed" || real === "error")) {
            // 有真 part → **重渲染整张终态卡片**（入参 + 输出 + 状态），而不是用一行
            // 通知覆盖掉原卡（用户反馈"完成后也不会显示内容"）。
            staleToolBorn.delete(key)
            staleCardIdx.delete(key.replace(/:input$/, ""))
            // **尊重用户的显示设置**（用户反馈"看门狗不管你的显示设置"）：
            // 事件路径用 `filt("tool")` 决定档位，mode===1 是 header-only（卡里本来只有标题），
            // 而看门狗此前**不读设置**、一律塞完整正文 → 在 header-only 卡上凭空多出大段内容。
            // 现在两条路径读同一个设置：mode===1 只写一行状态，不塞正文。
            const toolMode = filt("tool")
            if (toolMode === 1) {
              // R2673：若这张卡是「仅标题合并」链条的锚点，保留累计（×n）——
              // 看门狗的单行状态覆盖不能把合并标记悄悄抹掉。
              const mergeChain = titleMergeChains.get(chat)
              const staleLine = `${real === "completed" ? "✅ 已完成" : "❌ 失败"} · 用时约 ${mins} 分钟`
              r = await editTextRaw(
                chat,
                msgId,
                mergeChain && mergeChain.id === msgId && mergeChain.count > 1
                  ? withTitleMergeCount(staleLine, mergeChain.count)
                  : staleLine,
                undefined,
                fb,
              )
            } else {
              // R1088: 看门狗纠正不能只换状态行 —— 用户实测「✅ 已完成」卡上没有工具运行结果。
              // 会话记录里 part.state 有实质输出/错误时整卡重渲染(renderToolTerminalCard 带 📤 输出块);
              // 仅当无输出时退回 patch 状态行, 避免破坏已有显示。
              const _st8 = hit.part?.state ?? {}
              const _hasOut8 = String(_st8.output ?? _st8.error ?? "").trim() !== ""
              const patched = _hasOut8 ? null : patchStillNote(rec?.text ?? "", real, mins)
            preserved = patched !== null
            r = await editTextRaw(chat, msgId, patched ?? renderToolTerminalCard(sess, hit.part, real, mins), undefined, fb)
            }
          } else if (real === "running" || real === "pending") {
            // 真的还在跑：如实说"仍在执行"。
            // ⚠️ 这里**替换**而不是追加：旧实现是 `rec.text + 通知`，于是每分钟叠加一段
            // （实测 4 分钟就叠了 4 层"⏳ 仍在执行中（已 N 分钟）"），内容无界增长 ——
            // 用户反馈"shell 格式完全坏掉了"。而且原 `rec.text` 是**落盘时**的旧文本，
            // 拿它当基底会与卡片真实内容不符。
            const still = `⏳ 仍在执行中（已 ${mins} 分钟；本宿主不主动发完成事件，属正常）`
            // 用户建议（2026-09-27）：「ctrl+b 让 shell 后台运行的方式能不能被利用？自动循环
            // 文本注入在 ai 没有主动停止时就会有注入」—— 观察是对的，机制**不能**被桥直接利用：
            // 实测能力面（hostcaps 日志）：ctx.session 只有
            //   [hook, create, get, switchAgent, switchModel, prompt, generate, command,
            //    synthetic, interrupt, update, move, wait, context]
            // **没有** background / abandon / detach / abort-tool 任何一个；ctrl+b 是 TUI 的
            // 本地按键，桥（宿主进程内的插件）没有任何 API 能代按。
            // 但"只给状态、不给出路"正是用户看不到办法的原因 —— 长跑的 shell 会一直占着回合，
            // 回合不结束，注入闸（r100）就一直按住不注入。所以这里把**出路**写清楚。
            // ⚠️ **撤回 r712 的说法**：我原先在这里写"按 ctrl+b 可把 shell 转到后台，回合随即
            // 结束、自动循环才能继续"。查完证据后发现**这条是假承诺**，现已删除：
            //   ① 宿主二进制（$HOME/.opencode/bin/opencode，185MB，strings 出 75 万行）里
            //      **没有** ctrl+b 的按键绑定（只有 2 处在压缩后的 UI 渲染代码里偶然出现，
            //      是变量名子串，不是绑定）；
            //   ② 配置里也没有：`opencode.jsonc`(292B) / `cli.json`(393B) 均无 key/bind/ctrl；
            //   ③ shell 工具**自己**写着：`Background commands "&" are not supported yet.`
            //   ④ SDK 侧也没有对应能力：`/session/{id}/shell` 的 body 是 {agent,model,command}
            //      —— 那是"让服务端跑一条命令"，不是"把正在跑的工具转后台"。
            // → 这里只写**已验证为真**的出路：注入闸在拦（不抢跑），要结束这一回合用 ⏹ 停止
            //   或在 opencode 界面中断它。**宁可少给建议，也不给做不到的建议。**
            const bgHint = mins >= 3
              ? "\n\n<i>循环在等这一回合结束（注入已按闸拦住，不会往正在跑的回合里插话）。要结束这一回合：用本卡的 ⏹ 停止，或在 opencode 界面中断它。</i>"
              : ""
            // 同样必须跳过代码块：那一行若出现在工具输出里，那是**数据**（R1024）。
            const base = stripOutsideCode(rec?.text ?? "", (seg) =>
              seg.replace(/⏳ 仍在执行中（已[^）]*）\n?/g, ""),
            ).trim()
            // 基底为空（header-only 模式，或重启后落盘文本为空）→ **不动这张卡**：
            // 拿一行通知去覆盖它，正是"内容全丢"那一类问题。
            r = base
              ? await editTextRaw(chat, msgId, `${base}

${protoBlock(`⚠️ ${sessionTag(sess)}`, `${still}${bgHint}`)}`, undefined, fb)
              : { r: "skip" }
          } else {
            const unknown = `已 ${mins} 分钟没有新状态，且会话里查不到该工具的记录（可能已被压缩或消息被删）`
            r = await editTextRaw(chat, msgId, `${rec?.text ?? ""}\n\n${protoBlock(`⚠️ ${sessionTag(sess)}`, unknown)}`, undefined, fb)
          }
          if (r.r === "sent") {
          markReconciled(key, real)
          await log("info", `card mode=${preserved ? "patch(格式保全)" : "rerender(整张重渲染)"} key=${sanitizeLog(key).slice(0, 60)}`)
          if (rec && lastEditBody) protoMap.set(key, { ...rec, text: lastEditBody })
            await log(
              "info",
              `stale tool card reconciled (key=${sanitizeLog(key).slice(0, 60)}, mins=${mins}, real=${real || "unknown"}, cardLen=${(r as unknown as { len?: number }).len ?? "?"})`,
            )
          }
        }
      }
    })()
  }, 60_000)
  // 启动补发：卡片只在**实时事件**里推，实例换代（热重载/崩溃重启）期间产生的回合
  // 就此丢失 —— 表现为"某个 Bot 突然不更新"，而会话其实还在被循环驱动、还在注入。
  // 实测：01:55–02:02 备用侧被注入 2 次、却一张卡都没推（期间 4 次重载）。
  // 这里在启动后对目标会话做一次**有界补发**：最近 3 条 assistant 消息里，
  // protoMap 中没有 `:message:<id>` 键的，补一张卡并注明是补发（不重复推已推过的）。
  setTimeout(() => {
    void (async () => {
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      if (loopStopped()) return
      const chat = pushChatResolve()
      const sid = fixedTarget ?? frontSessionID ?? persistedFront
      if (!chat || !sid) return
      try {
        const res = await client.session.messages({ path: { id: sid } })
        const arr = Array.isArray(res?.data) ? res.data : []
        const asst = arr.filter((m: any) => String(m?.role ?? m?.info?.role ?? "") === "assistant").slice(-3)
        let missed = 0
        for (const m of asst) {
          const id = String(m?.id ?? m?.info?.id ?? "")
          if (!id) continue
          if (protoMap.has(`${sid}:message:${id}:1`)) continue
          const txt = String(m?.text ?? m?.info?.text ?? "").trim()
          if (!txt) continue
          // R1605：与正链同款转换（mdTableToHtml 包表格 <pre>）——补发路径此前直发
          // txt.slice，含表格的报告在换代补发时仍显示原始管道符（R1602 覆盖空档）。
          const body = closeUnclosedPre(fenceSafe(mdTableToHtml(mdBoldToHtml(txt))).slice(0, 1200))
          const key = `${sid}:message:${id}:1`
          const r = await sendTextRaw(chat, protoBlock(`💬 回复 · 补发 · ${sessionTag(sid)}`, body), true)
          // R1802：判据与主投递路径同源。`missed` 统计的是**补发了几条**，不是"成功锚定了几条"
          // —— TG 收下就算补发成功，缺 message_id 只让我方无法改写那张卡。故按 delivered 计数。
          const cdv = protoDeliveryVerdict(r)
          if (cdv.delivered) {
            if (r.id) protoMap.set(key, { id: r.id, text: body, fallback: r.fallback === true })
            else await log("warn", `catch-up degraded (${sanitizeLog(key)}) no message_id，无法锚定该补发卡`)
            missed++
          }
        }
        if (missed > 0) {
          savePersistedState()
          await log("info", `startup catch-up push (session=${sanitizeLog(sid).slice(0, 12)}, missed=${missed})`)
        }
      } catch {
        /* best-effort */
      }
    })()
  }, 12_000)
  // 启动补登记：进程重启后内存里的 staleToolBorn 是空的 —— **之前就卡在"执行中"的
  // 卡片不会被看门狗看到**（用户实测：read 早已完成，卡片仍显示执行中）。这里从
  // protoMap（已落盘）+ 真实消息状态把仍然 running/pending 的工具重新登记，让看门狗
  // 能在 3 分钟内按真实状态纠正它。
  setTimeout(() => {
    void (async () => {
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      if (loopStopped()) return
      const sids = new Set<string>()
      const t0 = fixedTarget ?? frontSessionID ?? persistedFront
      if (t0) sids.add(t0)
      for (const w of watchedSessions) sids.add(w)
      for (const k of protoMap.keys()) {
        const s = k.split(":")[0] ?? ""
        if (s.startsWith("ses_")) sids.add(s)
      }
      for (const sid of [...sids].slice(0, 6)) {
        try {
          const res = await client.session.messages({ path: { id: sid } })
          const arr = Array.isArray(res?.data) ? res.data : []
          // 真实状态表：callID → status
          const real = new Map<string, { status: string; part: any }>()
          for (const m of arr) {
            for (const p of partsOf(m)) {
              if (String(p?.type ?? "") !== "tool") continue
              const cid = callOf(p)
              const stt = String((p as any)?.state?.status ?? "")
              if (cid && stt) real.set(cid, { status: stt, part: p })
            }
          }
          // ① 仍在 running/pending 的 → 登记给看门狗
          for (const [cid, hitA] of real) {
            const stt = hitA.status
            if (stt !== "running" && stt !== "pending") continue
            const key = `${sid}:tool:${cid}:input`
            if (protoMap.has(key) && !staleToolBorn.has(key)) {
              staleToolBorn.set(key, Date.now())
              await log("info", `stale tool re-registered on startup (key=${sanitizeLog(key).slice(0, 60)}, real=${stt})`)
            }
          }
          // ② **卡片标记为"运行中"（runningAt>0，落盘带下来）但真实状态已是终态** → 按真相改写。
          //    这才是用户报的"read 早完成了，卡片还显示执行中"：宿主没发完成事件，卡片就
          //    永远停在旧文案。**不能靠 rec.text 判断** —— 落盘只存 [key,id,fallback,runningAt]，
          //    重启后 text 为空，早期版本因此完全对不上账。
          const chat = pushChatResolve()
          for (const [key, rec] of protoMap) {
            if (!key.startsWith(`${sid}:tool:`)) continue
            if (!rec.runningAt) continue
            const cid = staleCallId(key)
            const hitR = real.get(cid)
            const stt = hitR?.status ?? ""
            if (stt === "running" || stt === "pending") {
              // 真的还在跑：交给看门狗（用落盘的进入时刻，分钟数才准确）
              if (!staleToolBorn.has(key)) {
                staleToolBorn.set(key, rec.runningAt)
                await log("info", `stale tool re-registered on startup (key=${sanitizeLog(key).slice(0, 60)}, real=${stt})`)
              }
              continue
            }
            if (stt !== "completed" && stt !== "error") continue
            const mins = Math.max(0, Math.round((Date.now() - rec.runningAt) / 60_000))
            let preserved = false
            protoMap.set(key, { ...rec, runningAt: 0 })
            staleToolBorn.delete(key)
                        // 有真 part → 重渲染整张终态卡（与巡检对账同一渲染器）；拿不到 part 才退回一行通知。
            // 旧实现只用一行通知覆盖整张卡 → 命令与输出全丢（用户引用到这种卡片）。
            // ⚠️ 尊重用户的显示设置（与巡检对账读**同一个** filt("tool")）：header-only 只写一行状态。
            // 此前**启动修复路径完全不读显示设置** → 同一张卡被事件路径写成"一行"、被本路径写成
            // "完整卡（入参+输出+diff）"，卡在两种格式之间来回跳 —— 用户反馈"看门狗导致格式又坏了"。
            // 实测依据：生产日志里备用 Bot 的纠正事件出现过 card mode=rerender（完整卡），
            // 而它自己的档位是 filters.tool=1（header-only）。
            if (filt("tool") === 1) {
              const r1 = await editTextRaw(
                chat,
                rec.id,
                `${stt === "completed" ? "✅ 已完成" : "❌ 失败"} · 用时约 ${mins} 分钟`,
                undefined,
                rec.fallback === true,
              )
              if (r1.r === "sent") markReconciled(key, stt)
              await log(
                "info",
                `card mode=header-only key=${sanitizeLog(key).slice(0, 60)} cardLen=${(r1 as unknown as { len?: number }).len ?? "?"}`,
              )
              continue
            }
            // ⚠️ 此前这里是逗号表达式：`(preserved = patchStillNote(...) !== null, renderToolTerminalCard(...))`
            // —— **算完 patch 只取布尔值就把结果丢了**，body 永远是重渲染，而日志却报 `card mode=patch`。
            // 也就是说我的判别信号报的是**意图**不是事实（R684 引入，R971 才查出来）。
            const patchedB = patchStillNote(rec?.text ?? "", stt, mins)
            preserved = patchedB !== null
            const body = hitR?.part
              ? patchedB ?? renderToolTerminalCard(sid, hitR.part, stt, mins)
              : stt === "completed"
                ? stillNoteMsg("completed", mins)
                : stillNoteMsg("error", mins)
            // 不再包 protoBlock：包裹会给**已保全的原卡**再加一层 ⚠️ 引用块 → 保全被破坏；
            // 且巡检对账（站点A）本来就不包，两条路径产出必须一致。终态渲染器自带
            // 「此卡片由看门狗按会话真实状态纠正」的页脚，⚠️ 包裹是冗余的。
            const r = await editTextRaw(chat, rec.id, body, undefined, rec.fallback === true)
            if (r.r === "sent") {
            markReconciled(key, stt)
            await log("info", `card mode=${preserved ? "patch(格式保全)" : "rerender(整张重渲染)"} key=${sanitizeLog(key).slice(0, 60)}`)
            if (rec && lastEditBody) protoMap.set(key, { ...rec, text: lastEditBody })
              await log(
                "info",
                `stuck tool card reconciled on startup (key=${sanitizeLog(key).slice(0, 60)}, real=${stt}, ` +
                  `cardLen=${(r as unknown as { len?: number }).len ?? "?"}${r.r === "sent" ? "" : `, edit=${r.r}`})`,
              )
            }
          }
        } catch {
          /* best-effort */
        }
      }
    })()
  }, 8000)
  // 启动回扫一次：清掉历史残留回复的旧键（TUI standby 已提前 return，到不了这里）
  setTimeout(() => {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    // R2636：启动回扫也必须 force —— Bot 处于 /stop 状态时旧卡按钮同样是垃圾；
    // 扫描只清“每个会话非最新的卡”，运行中的手动回合最新卡仍保留 ⏹。
    void backfillStrip(true)
  }, 5000)
  // R2504（用户：有部分停止按钮没有删除）：一轮结束后最后一张思考/工具卡仍
  // 保留 ⏹，要等下一条带按钮的消息出现才会被 demote；长回合结束后可能永久
  // 残留。每 30s 检查本 Bot 目标的最后一条 assistant 是否已完成，完成才剥掉
  // lastReply 的按钮；运行中的回合（completed=0）保持可停止。
  const stripStopOnCompletedTurn = async (): Promise<void> => {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    const sid = fixedTarget ?? frontSessionID ?? persistedFront
    if (!sid) return
    const prev = lastReply.get(sid)
    if (!prev || !prev.id) return
    const chat = pushChatResolve()
    if (!chat) return
    try {
      const pe = await client.session.messages({ path: { id: sid } })
      const arr = Array.isArray(pe?.data) ? pe.data : []
      let lastAssistant: any = null
      for (let i = arr.length - 1; i >= 0; i--) {
        const m = arr[i] as any
        if (String(m?.role ?? m?.info?.role ?? "") === "assistant") {
          lastAssistant = m
          break
        }
      }
      if (!lastAssistant) return
      const completed = Number(lastAssistant?.time?.completed ?? lastAssistant?.info?.time?.completed ?? 0)
      if (!(completed > 0)) return
      // Only the ⏹ button must go. A truncated final reply also carries a
      // “看完整版” row; clearing the whole keyboard would make the full text
      // unreachable. Reuse the same full-key lookup as trackReplyButtons.
      const pk = prev.key
      let rows: unknown[][] = []
      if (pk.includes(":message:")) {
        let fid = ""
        for (const [k2, v2] of fullKeyStore.entries()) {
          if (v2.sid === sid && v2.key === pk) fid = k2
        }
        if (fid) rows = [[{ text: "📄 看完整版", callback_data: `full:${fid}` }]]
      }
      const r = await tgFetch("editMessageReplyMarkup", {
        chat_id: Number(prev.chat) || prev.chat,
        message_id: prev.id,
        reply_markup: { inline_keyboard: rows },
      })
      if (r.ok || (r.status === 400 && /not modified/i.test(String(r.desc ?? "")))) {
        strippedKb.add(prev.key)
        lastReply.delete(sid)
        savePersistedState()
        await log("info", `stop button stripped after turn (session=${sanitizeLog(sid).slice(0, 12)} msg=${prev.id} keptFull=${rows.length ? 1 : 0})`)
      } else if (r.status === 400 || r.status === 403) {
        // 旧消息不可编辑：标记完成，避免每 30s 重试同一张卡
        strippedKb.add(prev.key)
        lastReply.delete(sid)
        await log("warn", `stop button strip skipped (msg=${prev.id}, status=${r.status}, desc=${sanitizeLog(String(r.desc ?? "")).slice(0, 80)})`)
      }
    } catch {
      /* best-effort */
    }
  }
  setInterval(() => {
    void stripStopOnCompletedTurn()
  }, 30_000)
  setTimeout(() => {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    runOffsetCheck("startup")
  }, 8000)
  setInterval(() => {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    runOffsetCheck("periodic")
  }, 10 * 60_000)

  // R1567：turn-end note 以**轮询**为底（用户指令：AI 主动结束输出→每轮一条短提示）。
  // 实证：宿主写完 time.completed 后不一定再发 message.updated 事件 → 事件驱动
  // 结构性看不见终态，必须保留轮询兜底。R2648：事件里若确实带 completed，则立刻触发
  // 一次检查（见 message.updated 分支），轮询降到 5s，作为事件丢失时的后备。
  // 从尾部反向找最近一条 completed>0 的 assistant 消息，按消息 id 去重。
  const checkTurnEndNote = async (sidHint?: string, force = false): Promise<void> => {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    if (!TURN_END_NOTIFY || pausedMode) return
    // R1596：非主实例默认不发 turn-end note；R2648 起可在注册表给单个 Bot 配
    // turnNoteOwnerOnly:false 打开（bot5/bot6 已开）。放在最前，避免非负责实例白采样。
    if (noteOwnerOnlySkipped({ ownerOnly: TURN_NOTE_OWNER_ONLY, isOwner: QUEUE_CARD_OWNER })) return
    const sid = fixedTarget ?? frontSessionID ?? persistedFront
    if (!sid || !isPrimaryPush(sid)) return
    if (sidHint && sidHint !== sid) return
    // 事件路径可能连续触发：1.5s 内只做一次会话采样（轮询/下一次事件会补上）。
    // force = 来自 session.list 的 idle 跃迁（真回合边界），必须穿透节流。
    const now = Date.now()
    if (!force && now - turnNoteCheckAt < 1_500) return
    turnNoteCheckAt = now
    const chat = pushChatResolve()
    if (!chat) return
    try {
      const pe = await client.session.messages({ path: { id: sid } })
      const arr = Array.isArray(pe?.data) ? pe.data : []
      if (!arr.length) return
      // R2672（运营者："不要保留，不能直接询问要不要循环吗，做好功能联动"）：
      // note 完成即发，不再有安静窗；loopActive 只决定文案与按钮 —— 循环中说明
      // 「下一轮自动继续」，循环停则直接问「要继续自动循环吗？」。R2671：循环状态
      // 必须按**本会话**算（loop-ctl 闸 + /loop off + halted），否则会把已 off 的
      // 会话误标成循环中。
      const loopActive = sessionLoopActive(sid)
      for (let i = arr.length - 1; i >= 0; i--) {
        const m = arr[i] as any
        if (String(m?.role ?? m?.info?.role ?? "") !== "assistant") continue
        const completed = Number(m?.time?.completed ?? m?.info?.time?.completed ?? 0)
        if (!(completed > 0)) continue
        // R1569：热重载后新实例 Set 为空，旧消息（含已通知过的）会再补发 →
        // 只认本实例启动之后完成的消息。
        if (completed < turnNoteBootAt) break
        const mid = String(m?.id ?? m?.info?.id ?? "")
        const noteKey = `${sid}:${mid}`
        if (turnEndNotified.has(noteKey)) break
        // R2648（运营者："只要回合正常结束就立刻发"）：错误回合已有错误卡，
        // 不能用 ✅ 冒充正常结束；标记后不再重复评估。
        const mErr = (m as any)?.error ?? (m as any)?.info?.error
        const mFinish = String((m as any)?.finish ?? (m as any)?.info?.finish ?? "")
        if (mErr || mFinish === "error") {
          turnEndNotified.add(noteKey)
          break
        }
        // R2648：只有**真正结束回合**的消息才算。`tool-calls` 是中间步骤（工具跑完
        // 还会有下一条 assistant 消息）；finish 为空 = 流还没收尾（中断/骨架）。
        // 少了这道闸，安静窗为 0 的即时检查会把每一步工具调用都当成"回合结束"。
        if (!mFinish || mFinish === "tool-calls" || mFinish === "tool_calls") break
        // R2648c（用户实报「输出结束会在没有结束时发送，注意bot5」）：assistant 写了
        // finish=stop 不代表回合真的完了 —— 被提升到后台的 shell 仍在跑时，宿主会在它
        // 完成后注入合成消息把回合续起来。只要还有未收到 `<shell … state="completed">`
        // 通知的 shellID，就不发 note（也不标记已通知，完成后的新终态还会再评估）。
        const pendingShells = pendingBackgroundShells(arr, shellStillAlive)
        if (pendingShells.length > 0) {
          const pkey = `${sid}:${mid}:${pendingShells.join(",")}`
          if (turnNotePendingLogged !== pkey) {
            turnNotePendingLogged = pkey
            void log(
              "info",
              `turn-end note deferred (pending background shell ${pendingShells
                .map((x) => sanitizeLog(x).slice(0, 24))
                .join(",")} session=${sanitizeLog(sid).slice(0, 12)} mid=${mid.slice(0, 12)})`,
            )
          }
          break
        }
        turnEndNotified.add(noteKey)
        if (turnEndNotified.size > 1024) {
          const fk = turnEndNotified.values().next()
          if (!fk.done) turnEndNotified.delete(fk.value)
        }
        // R1570：lastRound 采样只走 protoPush（full 档）——镜像档/被 filt 挡住的
        // 文本不更新，note 会显示过时 R。这里从已完成消息的 text parts **即时采样**，
        // 与 L3557 同一正则（兼容 [ROUND n] 与 [ROUND Rn]），取不到才回落 lastRound。
        // R1595：采样顺带不用了——判据改「续跑检测」（见下），ROUND 标记不再参与门控。
        let noteRound = lastRound.get(sid)
        for (const pp of partsOf(m)) {
          if (String(pp?.type ?? "") !== "text") continue
          const t = String(pp?.text ?? "").trim()
          if (!t) continue
          noteRound = extractRound(t)
          if (noteRound) break
        }
        if (noteRound && noteRound !== lastRound.get(sid)) {
          lastRound.set(sid, noteRound)
          savePersistedState()
        }
        // R1603：note 门控 = **M 之后是否还有任何消息**（用户真实指令：输出结束应该
        // 在不发送消息（包括循环提示）就不会继续时发送）。宿主的循环提示是 type=
        // 'synthetic'、无 parts 的行，旧判据（R1595：按比 M 新的用户消息文本前缀匹配
        // 循环提示）role 过滤/partsOf 都取不到 → 漏检（实测 primary note 每 20s 复活，
        // 06:16:14 后累计 9 条）。任何比 M 新的行（提示/真实 TG/下一轮报告/事件）都是
        // "还会继续"的信号；M 是会话最后一条 = 停摆 → 才发「✅ 输出结束」。
        let newerMessage = false
        for (let j = i + 1; j < arr.length; j++) {
          const u = arr[j] as any
          if (String(u?.id ?? u?.info?.id ?? "")) { newerMessage = true; break }
        }
        if (noteSkipped({ newerMessage, loopSkip: TURN_NOTE_LOOP_SKIP })) break
        // R2657（运营者："为什么输出结束比其他消息先发"）：note 的触发只看 DB 里的
        // `time.completed`，而正文/思考卡走另一条路（message.updated 事件；事件缺失时
        // 25s 补扫），还要逐张过同 chat 的 1.1s 节流。实测 bot6 16:11:47：`✅ 输出结束`
        // 比它引用的那条消息（mid=msg_1dffa79b）的正文早 2.5s 到达 —— 用户看到短提示
        // 插在回复前面。这里加顺序闸门：M 的可见内容没投递前只 defer（**不**标记已通知，
        // 下一轮检查再评估），投递后才允许发 note。宽限/重试上限见 turnEndContentDelivered。
        if (
          !turnEndContentDelivered({
            sid,
            mid,
            keys: protoMap.keys(),
            retryKeys: protoRetry.keys(),
            askIds: partsOf(m)
              .filter((p: any) => String(p?.type ?? "") === "tool" && String(p?.tool ?? "") === "question")
              .map((p: any) => callOf(p)),
            hasVisibleContent: hasDeliverableContent(m),
            completedAt: completed,
            now: Date.now(),
          })
        ) {
          // 上面的 turnEndNotified.add 要撤回：defer 不是"已通知"，否则内容投递后
          // note 永远不会再评估。与 R2648c 后台 shell 的 defer（在 add 之前 break）同语义。
          turnEndNotified.delete(noteKey)
          const ckey = `${sid}:${mid}:content`
          if (turnNoteContentLogged !== ckey) {
            turnNoteContentLogged = ckey
            void log(
              "info",
              `turn-end note deferred (content not delivered yet, session=${sanitizeLog(sid).slice(0, 12)} mid=${mid.slice(0, 12)})`,
            )
          }
          break
        }
        // R2672：文案与按钮共用 loopActive（会话级）。循环关闭时第二行直接询问，
        // 并给「🔁 继续循环 / ⏹ 保持停止」；循环中给「⏹ 停止循环」。
        const note = turnEndLine({
          loop: loopActive,
          round: noteRound,
          name: sessionNameOf(sid),
          askLoop: !loopActive,
          autoLoop: loopActive,
        })
        const noteKb = turnEndKeyboard({ sid, loopActive })
        void sendQueued(String(chat), note, noteKb.length > 0 ? noteKb : undefined)
          .then(() => log("info", `turn-end note sent (session=${sanitizeLog(sid).slice(0, 12)} mid=${mid.slice(0, 12)} loop=${loopActive ? "yes" : "no"} kb=${noteKb.length > 0 ? "yes" : "no"})`))
          .catch(() => { /* best-effort */ })
        break
      }
    } catch {
      /* best-effort */
    }
  }
  // R2648：完成事件是主路径（立即发），5s 轮询只兜事件丢失（原 20s）。
  setInterval(() => {
    void checkTurnEndNote()
  }, 5_000)
  // R2648b：宿主对**终态**消息常常不发 message.updated（骨架事件缺 role），
  // session.idle 实测也不触发；但 session.list 的 `time.idle` 在回合结束 1s 内更新，
  // 且列表只有会话元数据（~KB，不像 messages 一次 2MB）。用 1.5s 轻量观测发现
  // idle 跃迁，再强制做一次全量确认 —— 把「回合结束→note」从 5s 压到 ≈1–2s。
  const turnNoteIdleSeen = new Map<string, number>()
  setInterval(() => {
    void (async () => {
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      if (!TURN_END_NOTIFY || pausedMode) return
      if (noteOwnerOnlySkipped({ ownerOnly: TURN_NOTE_OWNER_ONLY, isOwner: QUEUE_CARD_OWNER })) return
      const sid = fixedTarget ?? frontSessionID ?? persistedFront
      if (!sid || !isPrimaryPush(sid)) return
      try {
        const res = await (client as any).session.list?.({})
        const arr = Array.isArray(res?.data) ? (res.data as any[]) : []
        const row = arr.find((x: any) => String(x?.id ?? "") === sid) as any
        const idle = Number(row?.time?.idle) || 0
        if (!(idle > 0)) return
        if (idle <= (turnNoteIdleSeen.get(sid) ?? 0)) return
        turnNoteIdleSeen.set(sid, idle)
        // 热重载后列表里已有旧 idle：只认本实例启动之后的回合。
        if (idle < turnNoteBootAt) return
        // idle 跃迁 = 真回合边界：穿透 1.5s 事件节流，避免被刚到的骨架事件吞掉。
        void checkTurnEndNote(sid, true)
      } catch {
        /* best-effort */
      }
    })()
  }, 1_500)

  // R1827：事件驱动的 assistant 推送存在**结构性盲区**（与 R1567 turn-note 同源：
  // 宿主不保证为每条 assistant 消息都发 message.updated；即便发了，事件里的 `info`
  // 也可能没有 role/parts —— auto-continue 的 "empty-verdict" 日志实锤了这种骨架事件）。
  // 实测：bot3（非主实例、front 是其项目的循环会话）03:08–04:29 多条**带正文**的
  // assistant 消息完全未推送（proto 里毫无记录，而同期 tool 消息正常）→ 用户视角
  // 「bot3 的信息和思考从不发送」。
  // 修法：与 turn-note 同源的**轮询补扫**——定期抓 front 会话尾部消息，凡 proto 无记录
  // 的 assistant 正文/思考补推。幂等性：① 已推送的键存在于 protoMap（热重载后由持久化
  // proto 恢复）→ 直接跳过；② 与事件路径并发时由 protoSend 内的 shouldSend/sentHash
  // 二次去重。只补正文/思考（tool 由事件路径负责，避免无谓的编辑风暴）。
  setInterval(() => {
    void (async () => {
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      if (pausedMode) return
      const sid = fixedTarget ?? frontSessionID ?? persistedFront
      if (!sid || !isPrimaryPush(sid)) return
      const chat = pushChatResolve()
      if (!chat) return
      let arr: any[] = []
      try {
        const pe = await client.session.messages({ path: { id: sid } })
        if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
        arr = Array.isArray(pe?.data) ? pe.data : []
      } catch {
        return
      }
      if (!arr.length) return
      // R1867：窗口从"尾部 4 行"改为"尾部 CATCHUP_ASSISTANT_TAIL 条 assistant 消息"。
      // 旧写法在循环里极易漏：一条被事件路径漏推的 assistant 正文，只要其后再落 ≥4 行
      //（宿主 synthetic 循环提示、tool 卡、用户消息都是"行"），就滑出窗口**永久丢失** ——
      // 正是用户诉求「bot3 的信息和思考从不发送」的残余形态。按 assistant 计数，无论中间夹
      // 多少非 assistant 行都能覆盖；仍是有界扫描（避免大 session 每 25s 全量 O(n·protoMap)）。
      const tailStart = catchupAssistantsStart(arr as any[], CATCHUP_ASSISTANT_TAIL)
      for (let i = tailStart; i < arr.length; i++) {
        const m = arr[i] as any
        if (isCompactionMessage(m)) continue
        const role = String(m?.role ?? m?.info?.role ?? "")
        const typ = String(m?.type ?? m?.info?.type ?? "")
        if (role !== "assistant" && typ !== "assistant") continue
        const content = partsOf(m)
        const hasText = content.some(
          (p: any) => (p?.type === "text" || p?.type === "reasoning") && String(p?.text ?? "").trim()
        )
        // R2451：报错回合常常 parts=0（无正文/思考），旧代码 `!hasText → continue` 把
        // **整条报错消息**跳过 —— 用户实报「部分错误不发送，比如速率限制」。放宽为
        // 「有正文 **或** 带 error」→ 交给 protoPushAssistantMessage 末尾的「❌ 生成失败」卡
        // （致命错误无 retry part、事件路径拿不到 message.updated，此补扫是就地的兜底）。
        const hasErr = !!((m as any)?.info?.error ?? (m as any)?.error)
        if (!hasText && !hasErr) continue
        const mid = String(m?.id ?? m?.info?.id ?? "")
        if (!mid) continue
        // 与 turn-note 同一"本实例启动基线"：只补 boot 之后**创建或完成**的消息，
        // 避免每次热重载把旧历史重新推一遍。
        // R1912：纯 createdAt 基线会漏掉「跨重载生成」的消息——createdAt 在 boot 前、
        // 但正文/完成在 boot 之后才落地（实测 bot3 ROUND 76：09:49 创建，期间经历重载，
        // ~10:00 才完成 → 旧实例没正文可推、新实例按 createdAt 判 boot 前 → 两侧都跳过，
        // 正文永久丢失）。这里放宽为「创建于 boot 后 **或** 完成于 boot 后」；boot 前
        // 已完成的旧历史仍然跳过，热重载不会重推一遍。
        const createdAt = Number(m?.time?.created ?? m?.info?.time?.created ?? 0)
        const completedAt = Number(m?.time?.completed ?? m?.info?.time?.completed ?? 0)
        if (!(createdAt > turnNoteBootAt || (completedAt > 0 && completedAt > turnNoteBootAt))) continue
        const msgKey = mid.slice(0, 20)
        const seen = [...protoMap.keys()].some(
          (k) =>
            k.startsWith(`${sid}:message:${msgKey}:`) ||
            k.startsWith(`${sid}:thinking:${msgKey}:`) ||
            // R2451：报错卡（`:error:`）也是这条消息的"已推送"标志；否则每条无正文的
            // 报错消息会每 25s 被补扫重算一次（protoSend 去重能防重发，但白跑无害）。
            k.startsWith(`${sid}:error:${msgKey}`) ||
            // R750：只有被本桥过滤掉的 reasoning/tool 也在窗口里；没有可发送 part 时
            // protoMap 不会新增键，补扫会每 25s 重复同一批消息。用 catchup 标记持久化
            // “已处理”，避免空转；真实发送失败仍由 protoRetry 保留重试。
            k.startsWith(`${sid}:catchup:${msgKey}`)
        )
        if (seen) continue
        // R276：补扫路径必须传 backfill=true → 迟到的补推卡改用补推时刻+「补发」括注，
        // 消除「签署时间与发送顺序不相符」；事件路径的实时推送（backfill 缺省 false）不受影响。
        await protoPushAssistantMessage(sid, String(chat), m, false, "full", true)
        const pushed = [...protoMap.keys()].some(
          (k) =>
            k.startsWith(`${sid}:message:${msgKey}:`) ||
            k.startsWith(`${sid}:thinking:${msgKey}:`) ||
            k.startsWith(`${sid}:error:${msgKey}`)
        )
        if (!pushed) {
          const retrying = [...protoRetry.keys()].some(
            (k) => k.startsWith(`${sid}:`) && k.includes(msgKey)
          )
          if (retrying) {
            await log(
              "info",
              `proto catchup retry-pending (${sanitizeLog(sid).slice(0, 12)} msg=${sanitizeLog(mid).slice(0, 20)})`
            )
            continue
          }
          protoMap.set(`${sid}:catchup:${msgKey}`, { id: 0, text: "", fallback: true })
          savePersistedState()
          await log(
            "info",
            `proto catchup marked (${sanitizeLog(sid).slice(0, 12)} msg=${sanitizeLog(mid).slice(0, 20)} parts=${content.length} no-visible-part-or-filtered)`
          )
          continue
        }
        await log(
          "info",
          `proto catchup pushed (${sanitizeLog(sid).slice(0, 12)} msg=${sanitizeLog(mid).slice(0, 20)} parts=${content.length})`
        )
      }
    })()
  }, 25_000)

  const onIdle = async (sessionID: string): Promise<void> => {
    activeSessionID = sessionID
    touchActivity(sessionID)
    busyTurn.delete(sessionID)
    // R1060：回合空闲且该会话有标题时，自动把 Bot 显示名改成会话标题
    if (sessionID) void renameBotToSession(sessionID)
    // 空闲唤醒：排队内容在回合自然结束时继续注入；同时刷新水位
    if (pinQueue.some((qq) => qq.sid === sessionID)) void pumpInject(sessionID)
    void backfillCtxUsage(sessionID)
    if (!shouldPush(sessionID) || pausedMode) return
    const target = pushChatResolve()
    if (!target) return
    // 附加镜像档不打扰：只有主目标才发「完成/自然停止」状态卡。
    if (!isPrimaryPush(sessionID)) return
    // 自动循环会在 idle 后立刻注入下一轮：这时宣布「完成/自然停止」等于误报空闲
    // （用户看到“AI 明明在运行，却标注为AI空闲”）。循环中一律不说空闲。
    const loopRunning = !loopStopped()
    const protoActive = [...protoMap.keys()].some((k) => k.startsWith(sessionID))
    const hasStatus = protoMap.has(`${sessionID}:status`)
    if (protoActive && !hasStatus) {
      const label = loopRunning ? "✅ 本轮完成" : "✅ 完成"
      const reason = loopRunning ? "reason: 本轮结束（自动循环将立即继续）\nstatus: ✅" : "reason: 自然停止\nstatus: ✅"
      void protoSend(`${sessionID}:status`, String(target), protoBlock(label, reason), true)
    }
    const now = Date.now()
    const realAt = lastRealPush.get(sessionID) ?? 0
    const lastStop = lastStopNotify.get(sessionID) ?? 0
    const busyRecently = now - realAt < 2 * STOP_NOTIFY_MS
    if (!loopRunning && busyRecently && now - lastStop >= STOP_NOTIFY_MS) {
      lastStopNotify.set(sessionID, now)
      const s = clean(sessionNameOf(sessionID) || sessionID.slice(0, 12), 28)
      await sendQueued(target, `◻️ 自然停止 · ${s}（无新输出）`)
    }
  }

  // ---- 循环注入状态卡（R2228 v3：用户「单张可编辑状态卡」+「置顶」）-----------
  // 演进：v1 逐条提醒（每轮一条）→ 实测 23:02–02:11 刷了 125 条，且队列回灌在
  // 02:05 于 8 秒内连发 18 条 → 用户改选「单张可编辑状态卡」并要求置顶。
  // 现行为：全局只维护**一张**卡 —— 首次创建，之后每次注入 editTextRaw 原地编辑；
  // 创建即静默置顶。聊天零新增、不响铃、不刷屏。
  // 卡 id 落盘 inject-card-<bot>.json（配置目录，非 /tmp）：热重载后继续编辑同一条，
  // 不会每次部署都多出一张卡。
  // 直发 sendTextRaw / 直编辑 editTextRaw，**绝不进 outQueue**：旧版正是队列积压回灌
  // 造成 8 秒 18 连发（02:05 实录），此路径从根上绕开回灌。
  // 失败一律 best-effort 吞掉（通知是附赠，不阻断注入主路径）。
  let lastCardEditAt = 0
  const pinInjectCard = async (chat: string, mid: number, tag: string): Promise<boolean> => {
    try {
      const r = await tgFetch("pinChatMessage", {
        chat_id: Number(chat) || chat,
        message_id: mid,
        disable_notification: true,
      })
      await log(
        r.ok ? "info" : "warn",
        `inject card pin ${r.ok ? "ok" : "failed"} (bot=${BOT_ID}, ${tag}, msg=${mid}${r.desc ? `, desc=${sanitizeLog(r.desc).slice(0, 80)}` : ""})`,
      )
      return r.ok
    } catch (err) {
      await log("warn", `inject card pin error (bot=${BOT_ID}): ${sanitizeLog(err).slice(0, 100)}`)
      return false
    }
  }
  // R2577：旧卡一旦在 Telegram 侧无法再置顶（pin 返回 ok 但 getChat 永远没有它），
  // 只重复 pin 没有意义。重建一张新卡并把旧卡改成迁移提示；新卡 24h 内不再重建，
  // 避免“新卡也钉不上”时每分钟发一张。
  const recreateInjectCard = async (chat: string, st: InjectCardState, text: string, now: number): Promise<void> => {
    const old = st.msgID
    const s = await sendTextRaw(chat, text, injectCardKeyboard(), true)
    if (s.r !== "sent" || typeof s.id !== "number" || s.id <= 0) {
      await log("warn", `inject card recreate failed (bot=${BOT_ID}, old=${old ?? "-"}, r=${s.r})`)
      return
    }
    st.msgID = s.id
    st.cardAt = now
    st.pinOk = false
    st.pinCheckedAt = now
    st.pinFail = 0
    st.pinRecreatedAt = now
    writeInjectCardState(BOT_ID, st)
    await log("info", `inject card recreated (bot=${BOT_ID}, old=${old ?? "-"}, new=${s.id}, reason=pin lost)`)
    const ok = await pinInjectCard(chat, s.id, "recreate")
    if (ok) {
      const p = await readPinnedMessage(chat)
      st.pinOk = !!(p.ok && p.mid === s.id)
    }
    st.pinCheckedAt = Date.now()
    writeInjectCardState(BOT_ID, st)
    if (old && old !== s.id) {
      try {
        const r = await editTextRaw(chat, old, "🔁 循环注入 · 状态卡已迁移（此卡停止更新）", [], false)
        if (r.r === "sent") await log("info", `inject card retired (bot=${BOT_ID}, msg=${old})`)
      } catch {
        /* best-effort */
      }
    }
  }
  // R2577/R2728：把「卡面声称已置顶」改成「先校验、再按真实状态渲染」。校验频率：
  // 已置顶 10 分钟一次；未置顶/未校验 60 秒一次。队列卡占着最新置顶时不抢；
  // 用户自己钉了别的消息时也不抢，只如实显示未置顶。
  // R2728：菜单开关关闭时只做 10 分钟一次的只读校验（不再重钉/重建），
  // 卡面仍然如实显示；本 Bot 也不再推送全局通知（CI/429/TG 限流）。
  const ensureInjectCardPinState = async (
    chat: string,
    st: InjectCardState,
    now: number,
    text: string,
  ): Promise<void> => {
    if (!st.msgID) return
    if (queuePin.get(chat) !== undefined) return
    const opsOn = readCardOps(BOT_ID).enabled
    const due = !opsOn ? 600_000 : st.pinOk === true ? 600_000 : 60_000
    if (st.pinCheckedAt && st.pinCheckedAt > 0 && now - st.pinCheckedAt < due) return
    const probe = await readPinnedMessage(chat)
    if (!probe.ok) return
    st.pinCheckedAt = now
    if (probe.mid === st.msgID) {
      st.pinOk = true
      st.pinFail = 0
      writeInjectCardState(BOT_ID, st)
      return
    }
    if (!opsOn) {
      // 关闭自愈：不抢队列卡/用户置顶，也不重建；只记录“当前最新置顶不是本卡”。
      st.pinOk = false
      st.pinFail = 0
      writeInjectCardState(BOT_ID, st)
      return
    }
    if (probe.mid !== undefined) {
      if (isQueuePinCardText(probe.text)) {
        // 队列卡是“最新置顶”，注入卡可能仍在置顶列表里但 getChat 看不到；不抢。
        writeInjectCardState(BOT_ID, st)
        return
      }
      if (!isInjectCardText(probe.text)) {
        // 用户/其他 Bot 的消息占着置顶：尊重现状，不把用户的置顶顶掉。
        st.pinOk = false
        st.pinFail = 0
        writeInjectCardState(BOT_ID, st)
        return
      }
    }
    // 没有置顶，或最新置顶是另一张旧注入卡：尝试把当前卡钉上。
    const ok = await pinInjectCard(chat, st.msgID, "keep")
    st.pinOk = false
    st.pinFail = (st.pinFail ?? 0) + 1
    if (ok) {
      const p2 = await readPinnedMessage(chat)
      if (p2.ok && p2.mid === st.msgID) {
        st.pinOk = true
        st.pinFail = 0
        writeInjectCardState(BOT_ID, st)
        return
      }
    }
    const cardAge = st.cardAt && st.cardAt > 0 ? now - st.cardAt : Number.POSITIVE_INFINITY
    const canRecreate =
      st.pinFail >= 2 &&
      cardAge > 24 * 60 * 60 * 1000 &&
      (!st.pinRecreatedAt || now - st.pinRecreatedAt > 6 * 60 * 60 * 1000)
    writeInjectCardState(BOT_ID, st)
    if (canRecreate) await recreateInjectCard(chat, st, text, now)
  }
  try {
    registerInjectNotifier(BOT_ID, async (sessionID, kind) => {
      // R2666: a quota-tail recovery may target a session that is no longer a
      // loop target (/loop off), so accept the union of loop-target ownership
      // and persisted front/pinned ownership.
      if (!ownsLoopSession(sessionID) && !quotaForkMine(sessionID)) return
      const now = Date.now()
      const chat = pushChatResolve()
      if (!chat) return
      const st = readInjectCardState(BOT_ID)
      const gap = st.lastAt > 0 ? now - st.lastAt : 0
      // 5s 内的连发（重载/重试噪声）不计入间隔；>6h 视为跨时段，不污染均值
      if (gap >= 5_000 && gap < 6 * 60 * 60 * 1000) {
        st.avgGapMs = st.avgGapMs > 0 ? Math.round(st.avgGapMs * 0.7 + gap * 0.3) : gap
      }
      st.count += 1
      st.lastAt = now
      st.lastKind = kind
      st.lastSid = sessionID
      // R2666: an edit to the pinned card is silent in Telegram. Send a short
      // visible notice for every automatic injection (round or recovery).
      if (!pausedMode && !selfMute && claimInjectNotice(sessionID, kind, now)) {
        try {
          const notice = injectNoticeText({ bot: BOT_LABEL, sid: sessionID, kind, count: st.count, at: now })
          const nr = await sendTextRaw(chat, notice, undefined, false)
          await log(
            nr.r === "sent" ? "info" : "warn",
            `inject notice ${nr.r} (bot=${BOT_ID}, kind=${kind}, session=${sanitizeLog(sessionID).slice(0, 12)}, msg=${nr.id ?? "-"})`,
          )
        } catch (err) {
          await log("warn", `inject notice failed (bot=${BOT_ID}, kind=${kind}): ${sanitizeLog(err).slice(0, 120)}`)
        }
      }
      if (now - lastCardEditAt < 30_000) {
        // Still persist count/lastAt; the 60s card tick will render them.
        writeInjectCardState(BOT_ID, st)
        return
      }
      lastCardEditAt = now
      const render = (): string =>
        injectCardText({
          bot: BOT_LABEL,
          lastAt: now,
          kind,
          sid: sessionID,
          count: st.count,
          avgGapMs: st.avgGapMs,
          gate: loopGateInfo(),
          sessionLoopOff: !sessionLoopRegistered(sessionID),
          now,
          session: sessionTag(sessionID),
          sessionState: sessionStateLabel(sessionID),
          queue: outQueue.length,
          pinQueue: pinQueue.length,
          paused: pausedMode,
          refreshedAt: now,
          offline: invalidBotDisplayNames(),
          pinned: st.pinOk,
        })
      // R2577/R2728：先校验/自愈置顶，再用真实 pinOk 渲染；卡面不再无条件写“已置顶”。
      await ensureInjectCardPinState(chat, st, now, render())
      const text = render()
      await log(
        "info",
        `inject card update (bot=${BOT_ID}, msg=${st.msgID ?? "new"}, kind=${kind}, count=${st.count}, session=${sanitizeLog(sessionID).slice(0, 12)})`,
      )
      const cardKb = injectCardKeyboard()
      if (st.msgID) {
        const r = await editTextRaw(chat, st.msgID, text, cardKb)
        if (r.r === "sent") {
          writeInjectCardState(BOT_ID, st)
          return
        }
        if (r.r === "retry") {
          // 网络/429/5xx：卡还在，别重发（越失败越发）；落盘计数，下轮注入继续编辑
          writeInjectCardState(BOT_ID, st)
          await log("info", `inject card edit deferred (bot=${BOT_ID}, msg=${st.msgID}, status=${r.status ?? 0}, retry_after=${r.retryAfter ?? 0}s)${r.desc ? `, desc=${sanitizeLog(r.desc).slice(0, 60)}` : ""}`)
          return
        }
        // drop：消息已被删/不可编辑 → 清理卡 id 走重建
        await log(
          "warn",
          `inject card edit failed (bot=${BOT_ID}, msg=${st.msgID}, r=${r.r}${r.desc ? `, desc=${sanitizeLog(r.desc).slice(0, 80)}` : ""}) → recreate`,
        )
        st.msgID = undefined
      }
      const s = await sendTextRaw(chat, text, cardKb, true)
      if (s.r === "sent" && typeof s.id === "number" && s.id > 0) {
        st.msgID = s.id
        st.cardAt = now
        st.pinOk = undefined
        st.pinCheckedAt = 0
        st.pinFail = 0
        writeInjectCardState(BOT_ID, st)
        await log("info", `inject card created (bot=${BOT_ID}, msg=${s.id}, count=${st.count})`)
        const ok = await pinInjectCard(chat, s.id, "create")
        if (ok) {
          const p = await readPinnedMessage(chat)
          st.pinOk = p.ok ? p.mid === s.id : undefined
        }
        st.pinCheckedAt = Date.now()
        writeInjectCardState(BOT_ID, st)
      } else {
        // retry/drop 或 sent 但拿不到 id（R1806）：落盘计数，下轮注入重试建卡
        writeInjectCardState(BOT_ID, st)
        await log(
          "warn",
          `inject card create failed (bot=${BOT_ID}, r=${s.r}${s.desc ? `, desc=${sanitizeLog(s.desc).slice(0, 80)}` : ""})`,
        )
      }
    })
  } catch (err) {
    await log("warn", `inject-notice register failed (bot=${BOT_ID}): ${sanitizeLog(err).slice(0, 120)}`)
  }

  // R2501 (2026-10-23): 置顶循环卡以前只在「注入」时刷新，轮次间隔 5–10 分钟时
  // 会话状态/队列数字会整轮停在旧值（运营者：状态卡要有会话状态并且记得更新）。
  // 60s 拍：复用 poll 已维护的 cachedSessionList / lastActivity，仅在文案变化时
  // edit（避免无意义编辑触发 TG 限流）；换代后自动停。
  let lastLiveCardText = ""
  let cardLiveBusy = false
  setInterval(() => {
    void (async () => {
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      if (cardLiveBusy) return
      const chat = pushChatResolve()
      if (!chat) return
      const st = readInjectCardState(BOT_ID)
      if (!st.msgID) return
      // Primary has no fixedTarget/front; fall back to the last injected session
      // and *always* render the current resolved sid (previously the stale
      // st.lastSid was preferred, so the card could show a dead session).
      const sid = fixedTarget ?? frontSessionID ?? persistedFront ?? (st.lastSid || "")
      if (!sid) return
      cardLiveBusy = true
      try {
        const now = Date.now()
        const render = (): string =>
          injectCardText({
            bot: BOT_LABEL,
            lastAt: st.lastAt || now,
            kind: st.lastKind,
            sid,
            count: st.count,
            avgGapMs: st.avgGapMs,
            gate: loopGateInfo(),
            sessionLoopOff: !sessionLoopRegistered(sid),
            now,
            session: sessionTag(sid),
            sessionState: sessionStateLabel(sid),
            queue: outQueue.length,
            pinQueue: pinQueue.length,
            paused: pausedMode,
            refreshedAt: now,
            offline: invalidBotDisplayNames(),
            pinned: st.pinOk,
          })
        // R2577/R2728：先校验/自愈置顶，再按真实 pinOk 渲染；卡面不再无条件写“已置顶”。
        await ensureInjectCardPinState(chat, st, now, render())
        if (!st.msgID) return
        const text = render()
        if (text === lastLiveCardText) return
        const r = await editTextRaw(chat, st.msgID, text, injectCardKeyboard(), false)
        if (r.r === "sent") {
          lastLiveCardText = text
          // R2508：留一行可见证据，确认 60s 拍真的在改卡（运营者曾反馈“像停更”）。
          await log("info", `inject card refreshed (bot=${BOT_ID}, msg=${st.msgID}, offline=${readInvalidBotIds().join(",") || "-"})`)
        }
      } catch {
        /* 卡片刷新是附赠，失败下一拍再来 */
      } finally {
        cardLiveBusy = false
      }
    })()
  }, 60_000)

  // ── R277（运营者 R276 指令）：快照交接优化 save 侧 ──────────────────────────────
  // primary 实例周期性（默认 300s，1-10 分钟可调）把 $HOME 载荷同步到会话仓库孤儿
  // 分支 `env-sync`（脚本 opencode/config/scripts/env-sync.sh；设计与实测见
  // sessions/2026-10-19-snapshot-handoff-optimization.md）。目标：run 尾的 env 全量
  // 打包（≈1m45s）改由运行期滚动完成，restore 侧随后可优先从分支恢复（新鲜度
  // ≤5 分钟；release 资产保持兜底）。仅 primary 触发（三实例重复同步无意义）；
  // detached 子进程 + 脚本自持锁 ⇒ 热重载/重叠触发安全，不占事件循环。
  if (BOT_ID === "primary") {
    const envSyncScript = process.env.ENV_SYNC_SCRIPT ?? `REDACTED_ROOT/.config/opencode/scripts/env-sync.sh`
    const envSyncEveryMs = Math.min(3_600_000, Math.max(60_000, Number(process.env.ENV_SYNC_INTERVAL_MS ?? 300_000) || 300_000))
    const runEnvSyncTick = (why: string) => {
      try {
        if (!existsSync(envSyncScript)) return
        const child = spawn("bash", [envSyncScript], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, ENV_SYNC_WHY: why },
        })
        child.unref()
      } catch (err) {
        void log("warn", `env-sync spawn failed: ${sanitizeLog(String(err)).slice(0, 120)}`)
      }
    }
    // R721 同款热重载护栏：被换代后清掉两个句柄，避免旧实例空转 ticker。
    let esBoot: ReturnType<typeof setTimeout> | null = null
    let esTimer: ReturnType<typeof setInterval> | null = null
    const esGuard = (): boolean => {
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) {
        if (esBoot) { try { clearTimeout(esBoot) } catch { /* ignore */ } }
        if (esTimer) { try { clearInterval(esTimer) } catch { /* ignore */ } }
        return false
      }
      return true
    }
    esBoot = setTimeout(() => { if (esGuard()) runEnvSyncTick("boot") }, 150_000)
    esTimer = setInterval(() => { if (esGuard()) runEnvSyncTick("interval") }, envSyncEveryMs)
    await log("info", `env-sync: enabled (save-side R277; every ${Math.round(envSyncEveryMs / 1000)}s, script=${envSyncScript})`)
  }

  return {
    // R1487 回滚（用户指令：「就是你改的，快改回去」+「不要修改发送到服务器的请求」）：
    // 原先这里的 `tool: { shell: makeShellPromoTool(...) }` 走 V1 Hooks.tool 槽位，
    // 经 v2Bridge 会被注册成同名插件工具 → ①顶掉内置 shell（宿主报 No tool named "shell"），
    // ②改写发往 provider 的 tools 定义 → Console 免费层判定请求非「来自 OpenCode 内部」，
    //   报 FreeTierError: OpenCode's free tier can only be used from within OpenCode。
    // 该机制整体作废，不再返回任何 tool 覆盖。实现保留在 v2lib/shell-promo.ts（未接线）。
    event: async ({ event }) => {
      // Same singleton as poll(): stale stacked instances stay subscribed to
      // framework events after hot-reload; must not push. Silent (hot path).
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      eventCount++
      const props = (event.properties as any) ?? {}
      const info = props.info ?? {}
      const evSid: string | undefined = typeof (event as any)?.sessionID === "string" ? (event as any).sessionID : undefined
      const msgSid = props.sessionID ?? evSid ?? info.sessionID ?? ""
      if (event.type === "message.updated") {
        if (msgSid && typeof info?.title === "string" && info?.title) {
          activeSessionTitle = info.title
          sessionTitleCache.set(msgSid, info.title)
        }
        if (msgSid && info?.role === "user") {
          const synthetic = await isSyntheticUserMsg(msgSid, String(info?.id ?? ""))
          // 任意后台会话的真实 user 消息不能抢走 TG/循环前台；只有当前钉选
          // 会话，或尚未建立前台时的第一条消息，才可更新 front。
          const canBecomeFront = !fixedTarget || fixedTarget === msgSid || !frontSessionID
          // R1054：**非主实例**只认领"自己投递过"的会话（默认 = 隔离，入口文件原意）。
          // 主实例（QUEUE_CARD_OWNER=true）行为**完全不变** —— 它就是"跟随前台"的那个。
          // 想回到旧的"共享"语义：设 `TG_SCOPE_TO_OWN_CHAT=0`，**不改代码**即可切换。
          const scopeOwn = process.env.TG_SCOPE_TO_OWN_CHAT !== "0"
          const ownOk = !scopeOwn || QUEUE_CARD_OWNER || ownSessions.has(msgSid) ||
            frontSessionID === msgSid || persistedFront === msgSid
          if (!ownOk) {
            if (Date.now() - crossTalkSkipLogAt > 60_000) {
              crossTalkSkipLogAt = Date.now()
              await log(
                "info",
                `front claim skipped (not our session, bot=${BOT_ID}, sid=${sanitizeLog(msgSid).slice(0, 14)}) —— 隔离模式`,
              )
            }
            return
          }
          if (!synthetic && canBecomeFront) {
            frontSessionID = msgSid
            if (persistedFront !== msgSid) {
              persistedFront = msgSid
              savePersistedState()
            }
          }
        }
        if (msgSid && (info?.role === "assistant" || !activeSessionID)) {
          activeSessionID = msgSid
          touchActivity(msgSid)
        }
        if (msgSid && info?.role === "assistant") {
          noteUsage(msgSid, info)
          // 完成插入的忙闲信号：带 completed = 本轮输出结束（放行）；无 completed = 回合活着（含循环/TUI 发起的，记忙）
          if ((info as any)?.time?.completed) {
            busyTurn.delete(msgSid)
            // R2648（运营者："只要回合正常结束就立刻发，不要120s"）：完成事件到达即
            // 触发一次 turn-end 检查；宿主不保证每条终态都发事件，5s 轮询仍兜底。
            // 不在事件侧过滤 finish —— 骨架事件常缺 finish，过滤掉会退回 5s 轮询；
            // tool-calls/错误回合由 checkTurnEndNote 内的 finish 闸拦下（不会误发）。
            void checkTurnEndNote(msgSid)
          } else {
            busyTurn.add(msgSid)
            if (busyTurn.size > 200) {
              const fk = busyTurn.values().next()
              if (!fk.done) busyTurn.delete(fk.value)
            }
          }
        }
        // 压缩即清零（①）：compaction 事件到 → 水位置零，下条 assistant 重建。
        // R2369（用户实报「压缩的会话不对」）：旧的 `takeCompacted(msgSid)` 走的是
        // `_v2compat` 的**模块级共享**一次性标志（三个 Bot 共用同一份 _v2compat），
        // winner 未必拥有该会话 → 非拥有者清掉无意义的 ctxUsage 并把压缩卡发到自己的
        // 聊天，拥有者反而被饿死（水位不清 + 通知漏发）。现在标记随事件
        // `properties.compacted` 走，并**按会话归属**处理：只有把该会话作为自己的
        // 前台/固定目标/已投递会话的实例才清水位并发卡（隔离模式；TG_SCOPE_TO_OWN_CHAT=0 退回共享）。
        if (msgSid && (props as any).compacted === true) {
          const scopeOwnC = process.env.TG_SCOPE_TO_OWN_CHAT !== "0"
          const ownCompact =
            !scopeOwnC || ownSessions.has(msgSid) ||
            fixedTarget === msgSid || frontSessionID === msgSid || persistedFront === msgSid
          if (!ownCompact) {
            await log(
              "info",
              `compaction event for non-owned session ignored (bot=${BOT_ID}, sid=${sanitizeLog(msgSid).slice(0, 14)})`,
            )
            return
          }
          // ⚠️ R1035：**必须在清零之前**取水位 —— 删掉就再也拿不到"压缩前占多少"。
          // 这一路是宿主**主动报**的 compaction 事件（tap 从 sqlite 的 compaction 行合成），
          // 是三条探测里**最可靠**的一条：api 探测可能取不到时间戳而静默跳过，
          // ctx 骤降探测依赖 ctxUsage 有前值 —— 而这里恰恰是**先清零**的那个。
          // 实测（R1035）：2026-09-26T18:20:44 压缩真发生（ctx 504.3k→34.5k），
          // 这行日志**打了**，但 `compaction notice` **0 次** → 用户零通知。
          // （R1036 已补：lastHostCompact 现落盘于 `hcompact` 且提到模块级 →
          //   重载不再把真压缩降级成"基线播种"。event 这一路本就不依赖它。）
          const uBefore = ctxUsage.get(msgSid)
          const beforeTotal = uBefore ? ctxTotal(uBefore) : 0
          ctxUsage.delete(msgSid)
          await log("info", `[tg-bridge] ctx reset on compaction (${sanitizeLog(msgSid).slice(0, 12)})`)
          if (beforeTotal >= COMPACT_MIN_BEFORE) {
            // R1041：R1035 只发不更新（after 恒 0）→ 用户看到的卡停在"压缩前 504.3k"，
            // 是**半成品**。这里试着把水位立刻重建出来，好让卡片显示真实的"压缩后"。
            // 用 backfillCtxUsage（5 分钟刷新用的同一个函数，从消息重算，不是累计账本 ——
            //   readSessionUsage 读的是 session_v2 的**累计** token，压缩后不会变小，靠它拿不到）。
            await backfillCtxUsage(msgSid)
            const uAfter = ctxUsage.get(msgSid)
            const rawAfter = uAfter ? ctxTotal(uAfter) : 0
            // ⚠️ 只认"**确实降下来了**"的值：若重建读到的是压缩前的旧值（>= before），
            // 说明没重建成功 → 如实当未知（after=0），**绝不显示一个没降的数字**
            // （那会让同一张卡自相矛盾：上面写"压缩前 504k"、下面写"现在 520k"）。
            const afterTotal = rawAfter > 0 && rawAfter < beforeTotal ? rawAfter : 0
            await noteHostCompaction(msgSid, "event", Date.now(), beforeTotal, afterTotal)
          }
        }
        if (msgSid && info?.role === "assistant") {
          const chat = pushChatResolve()
          if (chat) {
            try {
              const r = await client.session.messages({ path: { id: msgSid } })
              if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
              syncPersistedTarget()
              const msgs = Array.isArray(r?.data) ? r.data : []
              const chain = msgs.filter((x: any) => String(x?.id ?? x?.info?.id ?? "") === String(info?.id ?? ""))
              await log("info", `proto-chain msgSid=${sanitizeLog(msgSid)} infoId=${String(info?.id ?? "").slice(0, 24)} total=${msgs.length} hit=${chain.length}`)
              if (chain.length > 0) {
                // 询问卡片不受钉选门控：agent点名要人，必须送达（带会话标识）。
                // 暂停模式只放行询问卡片。
                const needAsk = ownsAsk(msgSid) && chain.some(hasQuestionPart)
                if ((shouldPush(msgSid) && !pausedMode) || needAsk) {
                  const mode = pushModeFor(msgSid)
                  for (const m of chain) await protoPushAssistantMessage(msgSid, String(chat), m, false, mode)
                  return
                }
              } else {
                await log("error", `proto-chain empty (session=${sanitizeLog(msgSid)})`)
              }
            } catch (err) {
              await log("error", `proto-chain fetch failed (session=${sanitizeLog(msgSid)}): ${sanitizeLog(err).slice(0, 120)}`)
            }
          }
        }
        return
      }
      if (event.type === "session.created") {
        const sid = props.sessionID ?? evSid ?? info?.id ?? ""
        if (sid && !activeSessionID) activeSessionID = sid
        if (sid && typeof info?.title === "string" && info?.title) {
          activeSessionTitle = info.title
          sessionTitleCache.set(sid, info.title)
        }
        return
      }
      if (event.type !== "session.idle") return
      const sid = (event.properties as { sessionID?: string }).sessionID ?? evSid ?? info.sessionID ?? ""
      // R2648：session.idle = 回合边界。事件若真的到达，立刻评估 turn-end note
      // （宿主实测常不发这个事件，5s 轮询仍兜底；checkTurnEndNote 内部有 finish 闸）。
      if (sid) void checkTurnEndNote(sid)
      if (sid) await onIdle(sid)
    },
  }
}
