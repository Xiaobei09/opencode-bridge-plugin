import type { Plugin } from "@opencode-ai/plugin"
import type { AssistantMessage } from "@opencode-ai/sdk"
import { statSync, readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, unlinkSync } from "node:fs"
import { readSessionUsage, resetSessionTokens, sessionTokens, readRecentUserTexts, fireInjectNotices, idleVerdict, preBootOrphan, preBootDeadTurn, lastRealUserExcerpt, isSyntheticUserText, EXCERPT_MARKER, sortRowsByCreatedTime, effectiveTail, OPENCODE_DB_PATH } from "./_v2compat"
// R2838：pre-boot 判据必须用宿主进程启动时刻；插件热重载会重置 AC_BOOT_AT，
// 把正在生成的活回合误判成孤儿（2026-11-19 10:57 两次假注入）。
import { HOST_BOOT_AT } from "./host-boot"
// R2696：日志安全纯函数的唯一实现（控制字符 → 单行、会话/消息 ID 缩短）。
import { stripLogControls, shrinkLogIds } from "./log-safe"
// R2686：状态路径 / 原子写 / 容错读 / 会话 ID 的统一实现。
import { PRIVATE_FILE_MODE, LOOP_CTL_PATH, TG_STATE_PATH, atomicWriteJson, readLoopCtl, isSessionID, mergeBotStop, loopGateCovers } from "./state-io"
// R2844：跨模块运行期路径与「结束轮次杀同类进程」收口到共享模块（默认值不变）。
import { MODEL_WINDOWS_PATH, QUOTA_FORK_REMAP_DIR, ROLLOVER_REQUEST_DIR, ROLLOVER_SEED_DIR } from "./state-paths"
import { killOtherOpencodeProcesses } from "./peer-kill"
// 窗口用量的唯一口径（与 tg-bridge 卡片、宿主 TUI 的 HZ 完全一致）。
import { tokenTotalOf } from "./ctx-usage"
// R2659（运营者：「添加简单模式，只注入“继续”」）/ R2663（自定义文案）：每轮注入文案模式。
import { readLoopInjectMode, readLoopInjectCustom, composeLoopInjectText, loopInjectMetaForMode, isSimpleContinueText, rowHasLoopInjectMeta } from "./loop-inject-mode"
// 自动停止守卫的判据与配置读写放在共享模块（tg-bridge 的菜单也要用同一份，避免两边漂移）。
// R2674：配置按 Bot 分开（guardPathForBot / readGuardForBot），本模块只按会话归属选 Bot。
import {
  readGuardForBot,
  noteGuardTripForBot,
  readGuardLastTripForBot,
  detectGuardSignals,
  guardVerdict,
  loopPauseDecl,
  alreadyTripped,
} from "./loop-guard"
// R1548：中止事件分类 + 遥测（ESC 停不住问题的修复判据所在，纯函数可单测）。
import { classifyAbort, noteAbortEvent, restartNoticeNear } from "./abort-classify"
// R942：出口代理状态（只读）——本轮 provider 流量走哪个出口，坏了要靠换轮解决。
import { exitProxySummary } from "./exit-proxy"
// R2572：与 tg-bridge 共用停机解除表的读写实现（此前两边各解析一次同一文件，
// 格式漂移会让「已取消」的会话在一边被恢复、另一边仍停着）。
import { readHaltRelease } from "./halt-release"
// R2672：桥的 turn-end note「继续循环」按钮 → 本插件进程内即时评估。
import { installAutoContinueNudge } from "./loop-nudge"
// R2686：进程内模块联动走事件注册/触发，不再只靠轮询。
import { emit, offOwner, on } from "./events"
// R2789：跨进程状态文件 / 宿主 DB 变化走 fs.watch，替代 60s / 1.5s 定时拍。
import { watchFile } from "./fs-events"
// R2789：多个事件来源统一进串行队列，避免并发评估互相覆盖。
import { taskQueue } from "./task-queue"
// R2676（运营者选定 fix 1）：与 resume-once 的额度尾恢复做 per-run、message-id 级互斥。
import {
  claimQuotaTail,
  isPreBootQuotaTail,
  readQuotaTailMarker,
  releaseQuotaTail,
} from "./quota-tail-marker"
// R2833：版本号统一由 version.ts 提供；每轮与 loop-state 最新轮次一致。
import { BRIDGE_VERSION as VERSION } from "./version"

const MAX_TRACKED = 1024
const RETRY_MS = [3000, 6000]
// R2607：仅作**窗口表不可用**时的兜底分母；每会话真实窗口经 resolveContextWindow 解析。
// ⚠️ ROUND 31（D7 实测）：兜底取 1_048_576 是**危险方向** —— 模型不可解析的会话（实测 bot4
// `ses_sanitized02…`：无 model-switched 记录 ⇒ realWin=null ⇒ 回退 1M，`ctx=7%`）会被当成 1M 窗口，
// 而本宿主模型表里**最小真值就是 200000**（big-pickle/deepseek/glm/mimo 均 200k）⇒ 压缩阈值会
// 算到 ~700k 才触发（真值 140k）⇒ **先溢出、回合直接失败**。改为保守兜底 = 表内最小真值 200000：
// 宁愿早压缩（有成本、无故障），绝不晚压缩。可用 `AC_FALLBACK_WINDOW` 覆盖。
const CONTEXT_WINDOW = Number(process.env.AC_FALLBACK_WINDOW ?? 200_000)
const COMPACT_THRESHOLD = 0.7
const COMPACT_EVERY = 450
const ABORT_STALE_MS = 3 * 60 * 1000
// R1910：本插件实例启动时刻。用于 classifyAbort 区分「本实例装载前就在跑的回合」与
// 本实例内新产生的回合（cancel-safety / 本轮 200 计数 / quota 日志）。
// R2838：它**不是**宿主进程启动时刻 —— 热重载会重置，不能用于 pre-boot 孤儿判定；
// 这些判据改用 host-boot.ts 的 HOST_BOOT_AT。见 abort-classify。
const AC_BOOT_AT = Date.now()
// R2521: whether this run produced at least one healthy assistant turn.
let AC_ROUND_HAD_SUCCESS = false
// R2535：egress watcher 在 **进程外** 结束本轮时也必须知道本轮是否出现过正常回合。
// 旧行为固定写 round_success=false ⇒ 有 200 的轮次也被算作"无成功"，
// 连续 3 轮后误停循环（运营者规则：只有连续 3 轮没有任何 200 才停）。
// 这里在首个正常回合落一个标记，workflow 的 watcher_stop 分支据此判定。
let AC_ROUND_SUCCESS_MARKED = false
// R2655（运营者："放宽egress_only条件到本轮200数量小于10"）：本轮真实 200 的数量。
// 旧的 round-had-success 只有布尔值：只要有 1 个健康回合，配额 429 轮也会清零
// 429 streak，于是"少量 200 后立刻配额耗尽"永远等不到换会话。这里按 assistant
// 消息 id 去重计数（一条无错 assistant 消息 ≈ 一次成功的上游调用/200），只数
// 本进程启动后创建的消息；数量落盘给 workflow 的 failure_guard 判定 <10。
const AC_ROUND_200_TARGET = 10
const AC_ROUND_200_IDS = new Set<string>()
let AC_ROUND_200_COUNT = 0
const recordRound200 = (messageID: string): void => {
  const id = String(messageID ?? "")
  if (!id || AC_ROUND_200_IDS.has(id) || AC_ROUND_200_COUNT >= AC_ROUND_200_TARGET) return
  AC_ROUND_200_IDS.add(id)
  AC_ROUND_200_COUNT = AC_ROUND_200_IDS.size
  try {
    const dir = String(process.env.RUNNER_TEMP ?? "")
    if (dir) writeFileSync(`${dir}/round-200-count`, `${AC_ROUND_200_COUNT}\n`)
  } catch {
    /* best-effort counter */
  }
}
const markRoundHadSuccess = (): boolean => {
  if (AC_ROUND_SUCCESS_MARKED) return false
  AC_ROUND_SUCCESS_MARKED = true
  try {
    const dir = String(process.env.RUNNER_TEMP ?? "")
    if (dir) writeFileSync(`${dir}/round-had-success`, `${new Date().toISOString()}\n`)
  } catch {
    /* best-effort marker */
  }
  // R2790：真实成功回合说明 provider 额度已恢复 → 解除账号级硬闸。
  // 注意本函数在模块顶层，不能调用插件闭包里的 log()。
  clearProviderQuotaGate()
  return true
}
// R2655: count every distinct healthy assistant message created this run, not
// just the tail that triggered `noteHealthyRound`. Capped at the target (10)
// because the workflow only needs to know "< 10"; this keeps the per-eval scan
// bounded. Deduped by message id so repeated evals never double-count.
const scanRound200 = (messages: any[]): void => {
  if (AC_ROUND_200_COUNT >= AC_ROUND_200_TARGET) return
  for (let i = messages.length - 1; i >= 0; i--) {
    const row: any = messages[i]
    const info = row?.info
    if (info?.role !== "assistant" || info?.error) continue
    const created = Number(info?.time?.created ?? 0)
    if (!(created > 0 && created >= AC_BOOT_AT)) continue
    const id = String(info?.id ?? row?.id ?? "")
    if (id) recordRound200(id)
    if (AC_ROUND_200_COUNT >= AC_ROUND_200_TARGET) return
  }
}
const STALL_SESSION_MSGS = 600

// R208（D7 根因）：宿主跨进程重启后，会话消息 seq 可能从 0 重计（实测 bot4 目标：新消息
// seq=6..40、旧行 935..1035）⇒ 宿主 API 的行序 ≠ 会话时序，新消息被排到旧消息之前。
// R2686：排序实现上收到 `_v2compat`（宿主数据兼容层），tg-bridge 与本模块共用，
// 不再各留一份。time().created 缺失/非法者归 0（排最前）。

// 规范状态文件仍为 $HOME/.opencode/loop-state.md（本会话约定）；提示词**刻意不写死路径**，
// 以满足用户要求"不强调循环具体存放文件"。agent 可从该文件的头部/上下文获知规范位置。
const ROUND_PROMPT = `继续自动筛查循环（直到用户按 ESC 中断为止；本机制不再依赖回复中的 [STATUS] 标记判定，每次助手回合完成便自动续跑）:

本轮开始请先复述两个要点:
(a) 复述"用户上一次的真实话/指令"(即最近一条非自动注入的用户消息要点;若不可辨识则注明"自动注入,无新指令");
(b) 复述"循环规则"(自动续跑直至用户按 ESC 中断;9 个维度轮换扫描;每轮需更新循环状态记录;输出 [ROUND n]+[STATUS: CONTINUE/STOP])。

然后基于当前状态(上一轮修复已生效、未完成项与待验证项)进入下一轮:扫描/修复/回归/更新状态/输出本轮报告,继续下一轮,直到用户按 ESC 中断。不要重复已完成轮次的内容,不确定项标记"待验证+验证方法"。

【自动停止守卫】以下两种情况**不要**自行续跑，改为宣告（标记只作**独占一行**写在报告末尾；行文或代码块里提及无效）：
1) 检测到真问题（需要用户决策、或你无法自行解决的阻塞）：末行写 [SIGNAL:PROBLEM: 原因]；
2) 需要网页搜索（本宿主默认禁止联网搜索）：先在正文写清要查什么，末行写 [SIGNAL:WEBSEARCH: 要查什么]。
宣告后守卫会自动停止循环并等你在 TG 授权或决策；处理完用 /loop start（或菜单「继续循环」）恢复。`

// R1090: 连续两轮注入的最小间隔。回合完成立即注入会触发模板化重复刷屏
//（用户反馈「bot3 有很多重复的发送」: 每回合 701+495+tool 固定 pattern）。
const MIN_ROUND_MS = Number(process.env.AC_MIN_ROUND_MS ?? 90_000)
const throttleLogAt = new Map<string, number>()
// R1092: 已判定"仅思考(reasoning)无文本/工具产出"的消息集合 —— 不注入、不计空转
//（否则纯思考回合会被 refetch 判为"真实产出"注入、或落入 empty-stall 被误熔断[R1065 回归]）。
const reasoningOnlyMsgs = new Set<string>()
const noteReasoningOnly = (msgId: string): void => {
  reasoningOnlyMsgs.add(msgId)
  if (reasoningOnlyMsgs.size > 500) {
    const first = reasoningOnlyMsgs.values().next()
    if (!first.done) reasoningOnlyMsgs.delete(first.value)
  }
}
const RECOVER_PROMPT = `上一轮自动筛查应答因可恢复错误中断，请忽略该错误，直接继续既定循环规则进入下一轮（直到用户按 ESC 中断）：
本轮的循环规则与你上次收到的一致，请先复述(a)用户上一次的真实话/指令(若不可辨识注明"自动注入,无新指令")与(b)循环规则，然后扫描/修复/回归/更新循环状态记录/输出本轮报告。不要重复已完成轮次的内容。

如果上一轮的错误仍未消除(如 provider 网络错误)，本轮请把错误症状与重试判断写入本轮报告后仍输出 [STATUS: CONTINUE]，继续下一轮；不要因同一错误反复空转。`

// 自动停止守卫：记录「这条消息已因守卫停过一次」。
// 为什么必须记：恢复循环靠的是同一条最后助手消息判定，一旦 /loop start 清闸，
// eval 看到的仍是同一条（含 [STATUS: STOP]）→ 立刻又停 → 用户永远恢复不了（永动机）。
// 记 msg.id 后，只有**新的**助手消息才能再次触发，符合「停一次、等人处理」的语义。
const guardTripped = new Map<string, string>()
// R2666：注入逻辑不变；版本与桥对齐，表示“注入后会发可见提示”的整条链路已加载。
// R2676：额度尾恢复与 resume-once 做 per-run 互斥（同一 pre-boot 429 只注入一次）。
// R2806：本 run 自己撞上的 quota/429 不再 in-run recover（见 suppressInRunQuotaRecover）。
// R2833：版本号来源见文件顶部 `BRIDGE_VERSION`（统一维护，每轮更新）。
// 错误策略（现行，R2512）：「同一会话连续 3 次错误 → 结束本轮」。
// 语义：
//   · 连续 = 该会话中间没有一次成功的正常回合（非错误 assistant 消息）。
//   · 第 1/2 次连续错误 → recover（照常恢复/续跑）；第 3 次 → END-ROUND-CI（exit 0），
//     由 workflow relay 起新 run：新 run 会重新挑一个**出口代理**（新出口 IP ⇒ 新额度）。
//   · R2806 例外：**本轮**的 quota/429 不进入 1/2 次 recover —— 首个 429 已由
//     egress-watch 结束本轮，插件只记录并等 relay；transport/abort 仍按本预算走。
//   · R2512 修正：旧实现是**全局** streak，任意其它会话出现正常回合就 reset；
//     实测另一个空闲会话每分钟把失败会话的 streak 清零（日志恒为 1/2），
//     连续 quota 失败永远不结束本轮。现改为按会话计数，健康回合只 reset 自己。
//   · R942 变更：旧实现在本轮内「切 IP」（force-resolve 改 /etc/hosts + mihomo 切节点）
//     再切最多 5 次。实测那类 DNS/节点级切换**不改变源站看到的客户端 IP**，额度照样被卡；
//     而 Bun 在进程启动时解析一次代理、运行期改 env 也不换隧道 ⇒ 本轮内本来就没有
//     可切换的出口。现在改为「按轮换」：坏出口的唯一出路是换一轮。
// 计数按 distinct msg.id，避免同一错误被每拍重复计数。
// R204（D4）：**陈旧认领逃生**阈值（ms）。末条错误消息比这还老、空闲复核已过、且 recover
// 注入被判去重命中时，判定 claim 为陈旧（宿主从未产出回合），释放后改注入 ROUND_PROMPT。
// 实测场景：bot4 的 front 目标末条是 12h 前的 abort，每拍 `recover-inject duplicate
// suppressed` 且无回退 ⇒ 永久 0 回合。env AC_STALE_CLAIM_MS 覆盖。
const STALE_CLAIM_MS = (() => {
  const v = Number(process.env.AC_STALE_CLAIM_MS ?? "1800000")
  return Number.isFinite(v) && v >= 0 ? v : 1800000
})()
const ERR_CONSECUTIVE_LIMIT = (() => {
  const v = Number(process.env.AC_ERR_CONSECUTIVE_LIMIT ?? "3")
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 3
})()
export type ErrorPolicyAction = "recover" | "end"
// 纯函数（可单测）：按会话的连续错误计数。同一 msg.id 只计一次；健康回合只 reset
// 该会话，不能被其它空闲会话的“正常消息”清零（R2512 实测 bug）。
export const nextSessionErrorStreak = (
  state: { bySession: Readonly<Record<string, number>>; seen: readonly string[] },
  sessionID: string,
  key: string,
): { bySession: Record<string, number>; seen: string[]; added: boolean; streak: number; max: number } => {
  const maxOf = (m: Record<string, number>): number => Math.max(0, ...Object.values(m))
  if (state.seen.includes(key)) {
    const bySession = { ...state.bySession }
    return {
      bySession,
      seen: [...state.seen],
      added: false,
      streak: bySession[sessionID] ?? 0,
      max: maxOf(bySession),
    }
  }
  const seen = [...state.seen, key].slice(-128)
  const bySession = { ...state.bySession, [sessionID]: (state.bySession[sessionID] ?? 0) + 1 }
  return { bySession, seen, added: true, streak: bySession[sessionID], max: maxOf(bySession) }
}
export const resetSessionErrorStreak = (
  state: { bySession: Readonly<Record<string, number>>; seen: readonly string[] },
  sessionID: string,
): { bySession: Record<string, number>; seen: string[] } => {
  const bySession = { ...state.bySession }
  delete bySession[sessionID]
  return { bySession, seen: [...state.seen] }
}
// 旧版全局 streak（保留导出仅为兼容既有调用/测试；运行期已改用按会话计数）。
export const nextErrorStreak = (
  state: { streak: number; seen: readonly string[] },
  key: string,
  reset = false,
): { streak: number; seen: string[]; added: boolean } => {
  if (reset) return { streak: 0, seen: [], added: false }
  if (state.seen.includes(key)) return { streak: state.streak, seen: [...state.seen], added: false }
  const seen = [...state.seen, key].slice(-128)
  return { streak: state.streak + 1, seen, added: true }
}
// 纯函数（可单测）：给定连续错误数，决定下一步。
// R942：出口代理**按轮换**（每轮 CI 一个代理，见 exit-proxy.ts），本轮内没有可切换的
// 出口 ⇒ 连续错误的唯一正确处置是**结束本轮**，让 workflow relay 起新 run（新出口 IP、
// 新额度），而不是在坏代理上继续消耗。
export const errorPolicyAction = (args: {
  streak: number
  limit?: number
}): ErrorPolicyAction => {
  const lim = Math.max(1, Math.floor(Number(args.limit ?? ERR_CONSECUTIVE_LIMIT) || ERR_CONSECUTIVE_LIMIT))
  return args.streak < lim ? "recover" : "end"
}
// 纯函数（可单测）：429/限流识别。error.name 可能是 provider.quota，message 里也可能带 429。
export const isRateLimitError = (name: string, message: string, status = 0): boolean => {
  if (Number(status) === 429) return true
  // R942：把 opencode 自己的免费额度提示也认出来（实测原文）：
  //   "Free usage limit reached. Connect a provider or subscribe to OpenCode Go
  //    to keep going, or switch models."
  // 旧正则只认 429 / rate limit / quota，认不出这句话 → 额度耗尽被当成普通错误。
  return /\b429\b|rate[\s_-]?limit|too many requests|provider\.quota|\bquota\b|free usage limit|usage limit|connect a provider|switch models/i.test(
    `${name} ${message}`,
  )
}
// R210（运营者 2026-10-18 指令：连续错误提示 → 结束本轮 CI + 自动重启）：**墙钟停滞**判据。
// 实证缺口：abort 类错误不计入全局错误窗口，且同一条错误消息按 distinct msg.id 去重后永远只算 1 次
// ⇒ bot4 16:18–16:53 每分钟评估同一 abort、循环停滞，却从不触发 END-ROUND-CI，只能人工取消。
// 语义：会话尾条消息**持续是错误**（≥ 阈值无更新消息 = 宿主无推进）→ 与 5 连错同一出口（exit 0 → relay 重启）。
// 非错误评估 / 成功注入 round / PAUSE / SKIP 时清零。
const AC_ERR_STALL_MS = (() => {
  const v = Number(process.env.AC_ERR_STALL_MS ?? "300000")
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 300000
})()
// R188 诊断注记（热载与 diag 日志的关系）：运行期改动**任一** plugin 文件内容会触发宿主
// 热载整个插件集（同进程 reload，PID 不变；banner/self-check 走 client.app.log，不发 TG）。
// 热载**不截断** diag 日志（`/tmp/opencode/tg-bots-instance.log`），故其 `instance registered`
// （token=set/allowed=set）计数会跨「启动+热载」累加；只有**真实进程启动**才截断重写。
// 因此 restore-monitor 的 `bridge token=set/allowed=set` 期望值应以「单次启动的注册数」为准，
// 排查时先确认 BRLOG 时间戳是否只含一次启动块。
// R1916（用户指令 2026-10-09）：「增加在循环是否启动在会话名称的显示」。
// 原实现只有运行态标记 [LOOP]，停止态标题无任何标识 → 会话名只回答了「循环在跑
// 吗」的一半（跑→有标；停→与从未循环无差别）。现扩展为双标记三态：
//   · running → 标题尾缀 [LOOP]       （循环进行中，与旧行为一致，向后兼容）
//   · stopped → 标题尾缀 [LOOP:OFF]   （循环已停止，显式可辨识）
//   · clear   → 剥掉任一循环标记      （非循环目标/被清理，不显示）
// 机器人名字由桥侧 renameBotToSession 以会话标题为源自动同步（setMyName），
// 标题状态变化后 bot 名随之更新（429 冷却期满自动补改，见 tg-bridge 注释）。
const LOOP_TITLE_MARK_ON = "[LOOP]"
const LOOP_TITLE_MARK_OFF = "[LOOP:OFF]"
// 长标记在前：strip 时先剥 [LOOP:OFF] 再剥 [LOOP]，避免「XXX [LOOP] [LOOP:OFF]」
// 这类历史叠加残留只被删一部分。
const LOOP_TITLE_MARKS = [LOOP_TITLE_MARK_OFF, LOOP_TITLE_MARK_ON]
const stripLoopTitle = (title: string): string => {
  let out = String(title ?? "").trim()
  let changed = true
  while (changed) {
    changed = false
    for (const m of LOOP_TITLE_MARKS) {
      if (out.endsWith(m)) {
        out = out.slice(0, -m.length).trim()
        changed = true
        break
      }
    }
  }
  return out
}
/**
 * R2680：标题标记必须和 auto-continue 的真实判定同源。
 *
 * 旧实现只看 loop-ctl 的 Bot 闸：只要没被显式 stop，就给 front 会话挂 [LOOP]。
 * 但 `/loop off` 写的是 loop-sessions-off（不是 loop-ctl），eval 会 `loop=no -> skip`。
 * 于是标题显示“循环中”、状态卡却写“本会话未开启自动循环”、实际也不会续跑——
 * 这正是运营者反复问“为什么十几分钟没继续/是不是两套在跑”的来源之一。
 *
 * 纯函数：闸停或本会话显式 loop-off，都显示 [LOOP:OFF]；两者都开才是 [LOOP]。
 */
export const loopTitleState = (gateStopped: boolean, loopOff: boolean): "running" | "stopped" =>
  gateStopped || loopOff ? "stopped" : "running"
const AC_GEN_KEY = process.env.AC_GEN_KEY ?? "__acGen"

// R1847/R2686：原子写 JSON 已上收到 state-io.ts（跨进程共享文件统一 tmp+rename）。
// 这里保留 re-export，避免旧调用方/测试的 import 路径失效。
export { atomicWriteJson }
export const LOOP_SESSIONS_CAP = 16

// 记录“被本插件打过 [LOOP] 标记的会话”集合。热重载后内存态丢失，若不落盘，
// 旧目标上的 [LOOP] 会永久残留成假标记。集合而非单值：历史上可能同时存在
// 多个被标记会话，换目标后要把它们全部清掉。
const MARKER_STATE_PATH = process.env.AC_MARKER_PATH ?? `REDACTED_ROOT/.config/opencode/loop-marker.json`
const MARKER_SET_MAX = 16
const readMarkedSids = (): string[] => {
  try {
    const j = JSON.parse(readFileSync(MARKER_STATE_PATH, "utf8")) as any
    const raw: unknown[] = Array.isArray(j?.sids) ? j.sids : Array.isArray(j) ? j : []
    const out: string[] = []
    for (const v of raw) {
      if (isSessionID(v) && !out.includes(v)) out.push(v)
      if (out.length >= MARKER_SET_MAX) break
    }
    if (out.length === 0 && isSessionID(j?.sid)) out.push(j.sid) // 旧格式兼容
    return out
  } catch {
    return []
  }
}
const writeMarkedSids = (sids: string[]): void => {
  try {
    const clean = sids.filter(isSessionID).slice(0, MARKER_SET_MAX)
    // R1849：loop-marker.json 跨 Bot 的 AC 进程共享；裸写有 O_TRUNC 窗口，
    // `readMarkedSids` parse 失败 → 返回 [] → 该清掉的 [LOOP] 标记清不掉/反之。
    atomicWriteJson(MARKER_STATE_PATH, { sids: clean, ts: Date.now() })
  } catch {
    /* best-effort */
  }
}

// R2686：loop-ctl 路径与主/旧路径回落读取由 state-io.ts 统一提供。
// 能不能往"当前这条助手消息"注入下一轮 —— 判据，纯函数便于行为测试。
// 背景：用户报「AI 明明没有主动结束，却已经注入循环了，这种情况经常发生」。
// 根因不是"判据写错"，而是**根本没有判据**：HUNG-TURN 那段注释写着"循环也不该往
// 活着的回合里注入"，可 len>0 的正常路径一路走到 inject()，从不看 time.completed
// —— 流式中的消息一旦有了文字就被当成本轮结束。
// 为什么 completed 是唯一可靠的信号：opencode 的宿主侧回合结束**就是**给最后一条
// assistant 消息写 time.completed（tg-bridge 的 pumpInject 也用同一个信号等空闲）。
// ⚠️ R2376-fix2（2026-10-18）**修正**上面「刻意不提供陈旧兜底」的旧结论：
// 该结论的前提是「宿主终会消费排队注入」——但实测反例：宿主被中断/provider 断线后，最后一条
// assistant 会**永远** completed=0，而宿主自述**没有在途回合**（`POST /api/session/{id}/interrupt`
// → `{"interrupted":false}`）⇒ 该回合**永不结束**，`injectGateVerdict` 在**第一道闸**就永久拦死，
// 第二道权威闸 `idleVerdict`（它**早有** R2376「死回合逃生」：静置 > 阈值 + 尾段无活工具）根本没机会跑。
// 实证：bot4 `ses_sanitized02…` 2026-10-18 停滞 2.4h+（`in-flight-8671s`）而宿主 `interrupted:false`。
// 故此处与 ③/④/② 一致：静置超阈值**只做「移交给第二道权威闸」**，绝不强行注入
// （gate-2 仍会因「尾段有 running/pending 工具」或「未静置」而拒绝）。阈值同 `AC_STUCK_TURN_MS`，设 0 退回旧行为。
export const injectGateVerdict = (
  completed: number,
  updated: number,
  now: number,
): { go: boolean; why: string } => {
  if (completed > 0) return { go: true, why: "completed" }
  if (!(updated > 0) || !Number.isFinite(updated)) return { go: false, why: "no-updated-ts" }
  const ageS = Math.max(0, Math.round((now - updated) / 1000))
  const stuckMs = Number(process.env.AC_STUCK_TURN_MS ?? 300_000)
  if (stuckMs > 0 && ageS * 1000 > stuckMs) {
    return { go: true, why: `stale-in-flight-${ageS}s(→gate2)` }
  }
  return { go: false, why: `in-flight-${ageS}s` }
}

// 旧判据曾是子串正则 LOOP_PAUSE_RE，**报告里提及标记就会停机**（真实事故：
// 2026-09-28 01:57:32，报告里写「与 `[LOOP:PAUSE]` 同一条恢复路径」就把循环停了）。
// 现在判据在 loop-guard.ts（loopPauseDecl）：独占一行 + 围栏/行内代码挖空 —— 靠判据，
// 不靠"写报告时记得拆写"的纪律。
// R2686：readCtl 已上收到 state-io.ts 的 readLoopCtl（主路径 + /tmp 旧路径回落）。
// R1724（用户指令「不同机器人的循环设置要求单独」）：
// loop-ctl.json 原先是**三 bot 共用的单一全局闸** → 任一 Bot 的 /loop stop 会停掉全部。
// 现在扩成兼容式双层：
//   { stopped, by, ts, bots: { "<botId>": { stopped, by, reason, ts, sids: [...] } } }
//   * `stopped`（顶层）= **全局闸**，语义不变（守卫 PROBLEM/WEBSEARCH 仍用它停全部）；
//   * `bots[x].stopped` = **单 Bot 闸**，只停该 Bot 当前 front 会话（按 sids 匹配）。
// 判定优先级：全局闸 true → 一律停；否则看该 sid 命中的单 Bot 条目。
// 纯函数、无 IO —— 单测可直接钉行为，且桥与本侧共用同一套判据（防两边漂移）。
//
// R2879：实现上收到 state-io.loopGateCovers（tg-bridge 的注入泵也要用同一份）；
// 这里保留原名/导出，既有调用点（含 resume-once / 测试）不变。
export const loopGateStopped = loopGateCovers
// 停止总闸只允许最新实例写：热重载后陈旧实例仍可能收到 assistant 中断事件，
// 误写 stopped=true 会把用户正在跑的循环静默停掉。代号放 globalThis，
// 因为热重载会重新求值模块，模块级变量每个实例各有一份。
const CTL_WRITER_KEY = "__acCtlWriter"
let ctlInstanceGen = 0
const claimCtlWriter = (gen: number): void => {
  ctlInstanceGen = gen
  ;(globalThis as Record<string, unknown>)[CTL_WRITER_KEY] = gen
}
const ownsCtlWriter = (): boolean => {
  if (ctlInstanceGen <= 0) return true
  return (globalThis as Record<string, unknown>)[CTL_WRITER_KEY] === ctlInstanceGen
}
// R1915：守卫拉闸粒度从「全局单闸」改为「按会话所属 bot 的单 Bot 闸」。
// 用户反馈（2026-10-08）：「停止应只停有问题的那个 bot，其他 bot 继续循环」。
// 此前守卫写顶层 stopped=true（全局闸）→ 任一 bot 的 [SIGNAL:PROBLEM] 连坐停全部，
// 恢复也要 /loop start all 清全部，与 R1724「不同机器人的循环设置要求单独」冲突。
// 现在与桥侧 persistLoopStop(scopeAll=false) 同一模型：写 bots[<botId>].stopped=true，
// 顶层 stopped 不动；该 bot 之后的 eval 被 loopGateStopped 命中即停，其他 bot 照常注入。
// sid→bot 归属：从现有 loop-ctl 的 bots.<id>.sids 账本反查；单 bot 未写 sids（旧版本）
// 或多 bot 共享同 sid 等无法唯一归属的场合，**降级回全局闸**（宁可全停也不错放）。
const findOwnerBotId = (raw: unknown, sessionID: string): string | undefined => {
  const j = (raw ?? {}) as { bots?: unknown }
  const bots = j.bots
  if (!bots || typeof bots !== "object") return undefined
  let owner: string | undefined
  for (const [bid, v] of Object.entries(bots as Record<string, unknown>)) {
    const e = (v ?? {}) as { sids?: unknown }
    const sids = Array.isArray(e.sids) ? (e.sids as unknown[]).filter((x): x is string => typeof x === "string") : []
    if (sids.includes(sessionID)) {
      if (owner !== undefined) return undefined // 多 bot 同 sid：无法唯一归属
      owner = bid
    }
  }
  return owner
}
const writeCtlBotStopped = (sessionID: string, by: string, reason = ""): boolean => {
  if (!ownsCtlWriter()) return true // 非最新实例：不自作主张（调用侧仍可继续按已停处理）
  try {
    const prev = readLoopCtl()
    const bid = findOwnerBotId(prev, sessionID)
    if (bid === undefined) {
      // 找不到唯一归属（罕见：桥未绑定 sids / 多 bot 同 sid）→ 兜底写全局闸，保底别漏停。
      writeCtlStopped(true, by, reason)
      return true
    }
    // R2776：只停本 Bot；顶层 stopped 原样保留（/loop stop all 的全局硬闸不能
    // 被单 Bot 的守卫/停止操作解除，否则其它 Bot 会静默复活）。
    const out = mergeBotStop({ ...prev }, bid, by, reason, Date.now())
    atomicWriteJson(LOOP_CTL_PATH, out)
    return true
  } catch {
    writeCtlStopped(true, by, reason)
    return true
  }
}
/** SKIP 日志用：读该会话所属 bot 条目的 by/reason（bot 级闸的备注），供排队展示。 */
const botStopMeta = (raw: unknown, sessionID: string): { by?: string; reason?: string } => {
  try {
    const j = (raw ?? {}) as { bots?: unknown }
    const bots = j.bots
    if (!bots || typeof bots !== "object") return {}
    for (const v of Object.values(bots as Record<string, unknown>)) {
      const e = (v ?? {}) as { stopped?: unknown; sids?: unknown; by?: unknown; reason?: unknown }
      if (e.stopped !== true) continue
      const sids = Array.isArray(e.sids) ? (e.sids as unknown[]).filter((x): x is string => typeof x === "string") : []
      if (!sids.includes(sessionID)) continue
      return { by: String(e.by ?? ""), reason: String(e.reason ?? "") }
    }
    return {}
  } catch {
    return {}
  }
}
const writeCtlStopped = (stopped: boolean, by: string, reason = ""): void => {
  if (!ownsCtlWriter()) return
  try {
    // R1849：总闸跨进程共享，与 tg-bridge 的 `mutateLoopCtlFile` 同一文件。裸写有
    // O_TRUNC 窗口，读侧（本侧 `readCtl`、桥侧 `loopStopped`）会 parse 失败 → 误判
    // 为「没停」。改用 atomicWriteJson（tmp+rename）。
    // O_TRUNC 窗口，读侧（本侧 `readCtl`、桥侧 `loopStopped`）会 parse 失败 → 误判
    // 为「没停」。改用 atomicWriteJson（tmp+rename）。
    // R1891：必须**合并**而非覆盖。本文件按 loopGateStopped 的 schema 同时收两套账本：
    // 顶层 `stopped`（全局闸）+ `bots[<id>].{stopped,sids}`（单 Bot 闸，由 tg 侧
    // writeLoopCtl / syncLoopCtlSids 维护）。旧写法每拍写一个裸 {stopped,by,reason,ts}，
    // 把 `bots` 账本整体抹掉 →「停一次全局闸」连坐把各 Bot 的单 Bot 暂停（含 sids 绑定）
    // 清零，此后单 Bot 闸匹配不到 sid → 永不停该 bot。读旧值合并，保留 bots。
    const prev = readLoopCtl()
    const out = { ...prev, stopped, by, reason, ts: Date.now() }
    atomicWriteJson(LOOP_CTL_PATH, out)
  } catch {
    /* best-effort */
  }
}
// /quiet 压缩设置（tg-bridge 写入 tg-chats.json，本侧 10 秒 TTL 读取）：auto=false 停掉一切自动压缩
// R2686：TG_STATE_PATH 由 state-io.ts 统一提供（支持 AC_TG_STATE_PATH 覆盖）。

// ── 桥的"死人开关"（2026-09-26）────────────────────────────────────────────
// 缺口：桥若整个挂掉，**它自己的心跳也没了** —— `state save heartbeat` 是桥写的，
// 桥死了就只剩沉默，用户侧表现为"机器人不响了"而**无人知晓**。
// auto-continue 是**独立服务**（R979 发现有两个入口两个服务），桥死了它还在，正好当这个开关。
// 判据用**桥写的状态文件 mtime**：实测落盘规律（心跳 last 在 3–118s 之间），
// 阈值 300s 足够宽松，不会误报；文件读不到也算异常。
// ⚠️ 本函数刻意**不调用 log**（log 定义在工厂内，模块级调用会 TS2304 —— 今天已踩过一次），
//    只做纯计算并返回年龄（秒）；由工厂内的 loopTick 负责记日志。
export const BRIDGE_STALE_S = 300
// R2789：错误重启演练标记（时间门用一次性 deadline，不再靠 60s tick 顺带检查）。
const SIM_DRILL_PATH = "/tmp/opencode/sim-err-restart"
let bridgeStaleFlag = false
/** 判据的**纯函数**版本：路径与时间可注入 → 三种状态都能被单测覆盖，
 *  而不必去改真实服务的环境变量再重启（那属于配置变更，不该由我单方面做）。
 *  以前判据写死在模块里、依赖真实环境，导致"告警触发路径无法验证"（R985 遗留缺口）。 */
export const bridgeLivenessState = (
  path: string = TG_STATE_PATH,
  nowMs: number = Date.now(),
): "ok" | "stale" | "unreadable" => {
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return "unreadable"
  }
  const ageSec = Math.max(0, Math.round((nowMs - mtimeMs) / 1000))
  return ageSec > BRIDGE_STALE_S ? "stale" : "ok"
}
export const bridgeStateAgeSec = (): number => {
  try {
    return Math.max(0, Math.round((Date.now() - statSync(TG_STATE_PATH).mtimeMs) / 1000))
  } catch {
    return -1
  }
}
// 实例标签（primary / alt...）：用于日志与"双实例同目标"护栏
const AC_SCOPE = process.env.AC_SCOPE ?? "primary"
const AC_DIAG_PATH =
  process.env.AC_DIAG_PATH ?? `/tmp/opencode/tg-ac-instance${AC_SCOPE === "primary" ? "" : `-${AC_SCOPE}`}.log`
// R2686：isSessionID 由 state-io.ts 统一提供（与 resume-once / quota-tail-marker 同源）。

// R2675/R2700（运营者：「没有429的会话不需要换会话」；「改成1就换会话，重置为0」）：
// 插件日志里的 session id 会被 shrinkLogIds
// 截断，CI 无法据此推出完整会话。这里把**完整的 sid + 首次/最近 429 时间 + run id**
// 落到持久文件（~/.config/opencode，随环境快照跨 run 存活）；CI 的 failure_guard 再
// 与当前绑定的 Bot 会话求交集，只有真正在本轮 429 过的会话才可能被换。
// 只记录 this_run=true 的证据：恢复出来的旧错误（restored pre-run error）不算。
export const QUOTA_429_EVIDENCE_PATH = `REDACTED_ROOT/.config/opencode/quota-429-evidence.json`
// R2814（运营者：「先修429换会话问题，全面排查」）：rollover seed 标记必须
// 在 successor **成功跑完第一个回合**后立即消费。否则 bridge 直接注入种子提示、
// 不消耗 attempts 的实现会让标记存活 24h；同一会话几小时后再 429 时，CI 写入器
// 会把正常额度耗尽误判成「seed 首回合 synthetic 429」，跳过本该发生的换会话，
// 导致同一个会话被反复恢复（2026-11-18 20:37–20:47 连续 429 的根因）。
// 这里由 auto-continue 在健康回合计账时顺手删除；resume-once 还会在下一 run
// 用消息形状兜底清理一次。
export { ROLLOVER_SEED_DIR }
// R2826（2026-11-19 04:20:17 重复报告）：429 换会话请求/交换映射存在时，旧会话
// 已经（或即将）被 successor 取代。auto-continue 不得再向旧会话注入「继续」——
// 否则旧回合被续起来，和 successor 各产出一份接近相同的报告。
const ROLLOVER_PENDING_TTL_MS = 10 * 60_000
const rolloverPendingFor = (sessionID: string): boolean => {
  if (!sessionID || !/^ses_[A-Za-z0-9_-]+$/.test(sessionID)) return false
  // ① 还未被认领的 durably 换会话请求。
  try {
    if (existsSync(`${ROLLOVER_REQUEST_DIR}/${sessionID}.json`)) return true
  } catch {
    /* directory may not exist */
  }
  // ② 已被某个 Bot 认领、正在换会话（请求文件被 rename 成 .claimed-*）。
  try {
    for (const name of readdirSync(ROLLOVER_REQUEST_DIR)) {
      if (name.startsWith(`${sessionID}.json.claimed-`)) return true
    }
  } catch {
    /* directory may not exist */
  }
  // ③ 交换映射已落盘（rollover 的 remap 与 429 fork 共用）：10 分钟 TTL 内
  //    旧会话仍属于“正在进行中的换会话”，不注入。
  try {
    for (const name of readdirSync(QUOTA_FORK_REMAP_DIR)) {
      if (!name.endsWith(".json")) continue
      try {
        const j = JSON.parse(readFileSync(`${QUOTA_FORK_REMAP_DIR}/${name}`, "utf8")) as any
        if (j?.old !== sessionID) continue
        const ts = Number(j?.ts ?? 0)
        if (Number.isFinite(ts) && Date.now() - ts <= ROLLOVER_PENDING_TTL_MS) return true
      } catch {
        /* malformed/partial remap: ignore */
      }
    }
  } catch {
    /* directory may not exist */
  }
  return false
}
export const clearRolloverSeedForSession = (sessionID: string, healthyCreatedAt = 0): boolean => {
  if (!isSessionID(sessionID)) return false
  const path = `${ROLLOVER_SEED_DIR}/${sessionID}.json`
  try {
    if (!existsSync(path)) return false
    const j = JSON.parse(readFileSync(path, "utf8"))
    if (String(j?.sid ?? "") !== sessionID) return false
    const at = Number(j?.at ?? 0)
    if (!(at > 0)) return false
    // 健康回合必须发生在 seed 之后；防止一个旧回合的重复评估误删刚写下的标记。
    if (healthyCreatedAt > 0 && healthyCreatedAt < at - 1000) return false
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}
// R2790（运营者：「🩹 恢复…可能会造成第2次429」）：quotaRecover=1 只证明出口变了，
// 不证明 provider 账号额度恢复。同一账号的多个出口共享同一条 `Free usage limit`，
// 换 IP 后注入 recover 会稳定撞第二次 429。这里把 429 自带的 retry_after 归一成
// 「provider 额度耗尽截止时间」硬闸，独立于出口，跨 run 持久。
const PROVIDER_GATE_MAX_RETRY_S = 7 * 24 * 3600
export type ProviderQuotaGate = {
  blocked: boolean
  resetAt: number
  retryAfterSec: number
  at: number
  sessionID: string
  run: string
}
const readQuotaEvidence = (): any => {
  try {
    return JSON.parse(readFileSync(QUOTA_429_EVIDENCE_PATH, "utf8"))
  } catch {
    return null
  }
}
export const providerQuotaGate = (nowMs: number = Date.now()): ProviderQuotaGate => {
  const p = readQuotaEvidence()?.provider
  const resetAt = Number(p?.resetAt ?? 0)
  return {
    blocked: Number.isFinite(resetAt) && resetAt > nowMs,
    resetAt: Number.isFinite(resetAt) ? resetAt : 0,
    retryAfterSec: Number(p?.retryAfterSec ?? 0) || 0,
    at: Number(p?.at ?? 0) || 0,
    sessionID: String(p?.sessionID ?? ""),
    run: String(p?.run ?? ""),
  }
}
// 健康回合 = provider 已恢复可用；下一个额度序列重新计时（证据 sessions 保留）。
export const clearProviderQuotaGate = (): void => {
  try {
    const cur = readQuotaEvidence()
    if (!cur?.provider) return
    delete cur.provider
    cur.updatedAt = Date.now()
    atomicWriteJson(QUOTA_429_EVIDENCE_PATH, cur)
  } catch {
    /* best-effort */
  }
}
// R2806（运营者：「429之后不是会重启ci吗」）：本 run 内产生的 quota/429 **不再**
// in-run recover。egress-watch 的 QUOTA_LIMIT=1 已经用首个验证过的 429 结束本轮，
// workflow 随即 relay 新 run（新出口）→ 下一轮 boot 的尾恢复负责把被打断的输出
// 续完。实测 18:57:30 的 in-run recover 距 429 仅 5.8s，18ms 后再次 429；历史
// ≤60s 的 quota 恢复 216/216 失败，61–120s 的 boot 恢复 7/7 成功。
// 只抑制「本轮 + 额度错误」；pre-boot 尾条仍由 boot 恢复路径（auto-continue 的
// pre-boot quota tail / resume-once）处理，transport/abort 也照旧 in-run recover。
// 而且只在 egress-watch 真在监管本轮时才抑制：本地/TUI 没有 watcher 结束本轮，
// 抑制 recover 只会把会话永久停住。CI 的 run-opencode.sh 会导出
// EGRESS_STATE_DIR；TG_BRIDGE_FORCE_SERVE=1 是桥/CI 生产模式的信号。
export const egressWatchActive = (): boolean =>
  Boolean(String(process.env.EGRESS_STATE_DIR ?? "").trim()) ||
  String(process.env.TG_BRIDGE_FORCE_SERVE ?? "") === "1"
export const suppressInRunQuotaRecover = (o: {
  hasError: boolean
  rateLimit: boolean
  completedThisRun: boolean
  egressWatchActive: boolean
}): boolean => Boolean(o.hasError && o.rateLimit && o.completedThisRun && o.egressWatchActive)
// egress-watch 在 drain 之前先写 `<EGRESS_STATE_DIR>/stop`；这个窗口里注入任何
// recover 都只会和即将到来的 TERM 抢跑。把 marker 当作 recover 的硬闸，真正的
// 尾恢复留给下一 run。没有 EGRESS_STATE_DIR（本地/TUI）时保持原行为。
export const egressStopRequested = (): boolean => {
  const dir = String(process.env.EGRESS_STATE_DIR ?? "").trim()
  if (!dir) return false
  try {
    return existsSync(`${dir}/stop`)
  } catch {
    return false
  }
}
// R2806 的安全网：R2806 删掉了 quota 的 in-run recover，也删掉了它顺带产生的
// “再错两次 → END-ROUND-CI” 兜底。egress-watch 正常情况下会在 probe（≤90s）后
// 写 stop；若 watcher 自己失联，这里在宽限期后结束本轮，仍然走 workflow relay。
// probe 返回 200 时 watcher 会保留本轮并 fork 会话（meta 写 action=kept-round），
// 或本轮已经出现健康回合时，都不结束。
export const quotaRestartFallbackAction = (o: {
  elapsedMs: number
  graceMs: number
  stopRequested: boolean
  probeKeptRound: boolean
  roundHadSuccess: boolean
}): "wait" | "end" => {
  if (o.stopRequested || o.probeKeptRound || o.roundHadSuccess) return "wait"
  return Number(o.elapsedMs) >= Number(o.graceMs) ? "end" : "wait"
}
/** 读取 quota probe meta：只有本轮（mtime >= since）写下的 kept-round 才算数。 */
export const quotaProbeKeptRound = (metaPath: string, sinceMtimeMs = 0): boolean => {
  const p = String(metaPath ?? "").trim()
  if (!p) return false
  try {
    if (statSync(p).mtimeMs < Number(sinceMtimeMs ?? 0)) return false
    return /^action=kept-round\s*$/m.test(readFileSync(p, "utf8"))
  } catch {
    return false
  }
}
export const recordQuota429Evidence = (
  sessionID: string,
  atMs: number,
  retryAfterSec = 0,
  userInitiated = false,
): void => {
  if (!isSessionID(sessionID)) return
  const at = Number.isFinite(atMs) && atMs > 0 ? atMs : Date.now()
  const run = String(process.env.GITHUB_RUN_ID ?? "")
  try {
    const cur = readQuotaEvidence()
    const sessions =
      cur?.sessions && typeof cur.sessions === "object" && !Array.isArray(cur.sessions) ? cur.sessions : {}
    const prev = sessions[sessionID] && typeof sessions[sessionID] === "object" ? sessions[sessionID] : {}
    const prevFirst = Number(prev.first429At ?? 0)
    const prevLast = Number(prev.last429At ?? 0)
    sessions[sessionID] = {
      // Keep the earliest 429 of the consecutive quota sequence so CI can order
      // multiple sessions by "who hit 429 first" across rounds.
      first429At: prevFirst > 0 ? Math.min(prevFirst, at) : at,
      last429At: prevLast > 0 ? Math.max(prevLast, at) : at,
      // 同一连续 429 序列里只要有一次是真实用户触发，就按“用户正在等”处理。
      // 后续 synthetic 续跑命中同一额度窗口不能把结论改回 false。
      userInitiated: prev.userInitiated === true || userInitiated === true,
      run,
      updatedAt: Date.now(),
    }
    // 只接受合理范围的 retry_after：超长值（异常/单位错误）不能把闸门锁死一周以上。
    const retry = Number(retryAfterSec)
    const prevProvider = cur?.provider && typeof cur.provider === "object" ? cur.provider : null
    let provider = prevProvider
    if (Number.isFinite(retry) && retry > 0 && retry <= PROVIDER_GATE_MAX_RETRY_S) {
      const resetAt = at + Math.ceil(retry) * 1000
      const prevReset = Number(prevProvider?.resetAt ?? 0)
      // 同一未过期窗口里保留更晚的截止时间：多见于多出口先后撞同一条账号额度。
      if (!(prevReset > resetAt)) {
        provider = {
          retryAfterSec: Math.ceil(retry),
          resetAt,
          sessionID,
          at,
          run,
          updatedAt: Date.now(),
        }
      }
    } else if (prevProvider && !(Number(prevProvider?.resetAt ?? 0) > Date.now())) {
      // 旧的窗口已过期且本次 429 没带可用 retry_after：不再保留过期证据。
      provider = null
    }
    atomicWriteJson(QUOTA_429_EVIDENCE_PATH, {
      updatedAt: Date.now(),
      run,
      sessions,
      ...(provider ? { provider } : {}),
    })
  } catch {
    /* best-effort evidence; the watcher still stops the round */
  }
}
// 自动循环只允许当前 TG 目标会话；否则历史报告/其它会话的“循环”字样会误启动它们。
let stateParseFails = 0
let stateParseLastLog = 0
const readLoopTarget = (): string => {
  // 读坏了要说出来。以前这里是 catch 成"没有目标"，循环那一拍静默跳过 ——
  // 症状是"循环莫名停一下又自己好了"，事后完全查不出原因。
  // 写侧已改原子写（tmp+rename），所以真读坏通常是文件本身损坏，必须留痕。
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const j = JSON.parse(readFileSync(TG_STATE_PATH, "utf8")) as any
      stateParseFails = 0
      // front 是当前真实用户活动；pinned 可能被另一条 TG 会话临时钉选，
      // 不能让自动循环跟着它跨会话漂移。仅在 front 缺失时回退 pinned。
      if (isSessionID(j?.front)) return j.front
      if (isSessionID(j?.pinned)) return j.pinned
      return ""
    } catch {
      stateParseFails++
    }
  }
  if (Date.now() - stateParseLastLog > 300_000) {
    stateParseLastLog = Date.now()
    // 注意：这里在**模块作用域**，工厂里的 log() 不可见 —— 直接调会 ReferenceError
    // 然后被自己的 catch 吞掉，等于没记。console.* 是否被宿主捕获也不确定，
    // 所以以**写文件**为准（可 grep、可证），console 仅作兜底。
    const msg = `[auto-continue] LOOP_TARGET_UNREADABLE scope=${AC_SCOPE} path=${TG_STATE_PATH} — 本轮不注入`
    try {
      appendFileSync(AC_DIAG_PATH, `${new Date().toISOString()} ${msg}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
    } catch {
      /* ignore */
    }
    try {
      console.error(msg)
    } catch {
      /* nothing else available */
    }
  }
  return ""
}
// 多目标：单实例同时驱动**多个 Bot 的目标会话**。
// 为什么不是"每个 Bot 一个 auto-continue 实例"：同进程多实例会互相踩代号/租约/事件
// 订阅（实测主实例定时器直接不触发，排查成本极高）。一个定时器 + 多个目标没有这个问题。
// 附加目标由 AC_EXTRA_TARGETS 指定（逗号分隔的状态文件路径），各自 front 优先、pinned 兜底。
//
// R1899：env 缺省时**从 Bot 注册表自动发现**。此前本 env 从未在任何配置里出现过 →
// EXTRA_TARGET_PATHS 恒空 → 单实例只驱动 tg-chats.json（primary）的目标，bot2/bot3
// 的 front 会话从不进目标集、也永不注册进 loop-sessions → 用户实测「另外那个会话
// 也不能自动循环」（2026-10-07）。而"多目标单实例"本就是设计架构（见上文注释），
// 只是入口一直没人配。自动发现的状态文件命名与 tg-bridge 装载器的 statePath 推导
// 完全一致（首个沿用 tg-chats.json，其余 tg-chats-<id>.json，sfx=`-${id}`），
// 这样保住「往注册表加一个 bot 即一键接入（含循环目标）」的性质——env 显式配置时
// 仍优先生效（显式覆盖推导）。纯函数导出可单测（不碰文件系统/进程 env）。
export const resolveExtraTargetPaths = (
  envVal: string | undefined,
  registryJson: string | null,
  root = `REDACTED_ROOT`,
): string[] => {
  const fromEnv = (envVal ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.startsWith("/"))
  if (fromEnv.length > 0) return fromEnv
  if (!registryJson) return []
  try {
    const j = JSON.parse(registryJson) as { bots?: unknown[] }
    const bots = Array.isArray(j.bots) ? j.bots : []
    const out: string[] = []
    bots.forEach((b, i) => {
      const raw = (b as { id?: unknown } | null)?.id
      const id = typeof raw === "string" ? raw : ""
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return
      const p = i === 0 ? `${root}/.config/opencode/tg-chats.json` : `${root}/.config/opencode/tg-chats-${id}.json`
      if (!out.includes(p)) out.push(p)
    })
    return out
  } catch {
    /* 注册表 JSON 坏了：退回"无附加目标"，不打断主目标 */
    return []
  }
}
const EXTRA_TARGET_PATHS = resolveExtraTargetPaths(
  process.env.AC_EXTRA_TARGETS,
  (() => {
    try {
      return readFileSync(process.env.TG_BOTS_PATH ?? `REDACTED_ROOT/.config/opencode/tg-bots.json`, "utf8")
    } catch {
      return null
    }
  })(),
)
// R2674：所有状态文件（去重；注册表第一项也常被 EXTRA_TARGET_PATHS 带上）。
const ALL_STATE_PATHS = [...new Set([TG_STATE_PATH, ...EXTRA_TARGET_PATHS])]
// 状态文件 → Bot id。必须与入口 tg-bridge-v2.ts 的命名一致：
// 首个 Bot 用 tg-chats.json，其余用 tg-chats-<id>.json。显式 AC_EXTRA_TARGETS
// 可能是自定义路径，此时退回文件名推导；再不行才用 AC_SCOPE。
const STATE_PATH_BOT_ID = (() => {
  const out = new Map<string, string>()
  try {
    const raw = readFileSync(
      process.env.TG_BOTS_PATH ?? `REDACTED_ROOT/.config/opencode/tg-bots.json`,
      "utf8",
    )
    const j = JSON.parse(raw) as { bots?: unknown[] }
    const bots = Array.isArray(j.bots) ? j.bots : []
    bots.forEach((b, i) => {
      const id = typeof (b as { id?: unknown } | null)?.id === "string" ? (b as { id: string }).id : ""
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return
      const p = i === 0 ? TG_STATE_PATH : `REDACTED_ROOT/.config/opencode/tg-chats-${id}.json`
      out.set(p, id)
    })
  } catch {
    /* 注册表读不到：后面按文件名推导 */
  }
  return out
})()
const botIdFromStatePath = (path: string): string => {
  const known = STATE_PATH_BOT_ID.get(path)
  if (known) return known
  const base = path.slice(path.lastIndexOf("/") + 1)
  if (base === "tg-chats.json") return "primary"
  const m = /^tg-chats-([A-Za-z0-9_-]+)\.json$/.exec(base)
  if (m?.[1]) return m[1]
  return AC_SCOPE
}
// 会话 → 所属 Bot 状态文件。front/pinned 是权威归属；watch（镜像会话）次之。
// 2s 缓存与 currentLoopTargets 同节拍，避免每次评估把每个 Bot 的状态文件都重读一遍。
let sessionOwnerCache = { ts: 0, owners: new Map<string, string>() }
const rebuildSessionOwners = (): void => {
  const owners = new Map<string, string>()
  const parsed: Array<[string, any]> = []
  for (const p of ALL_STATE_PATHS) {
    try {
      parsed.push([p, JSON.parse(readFileSync(p, "utf8"))])
    } catch {
      /* 某个状态文件读不到：跳过 */
    }
  }
  // front/pinned 是权威归属；watch（镜像会话）次之。
  for (const [p, j] of parsed) {
    for (const sid of [j?.front, j?.pinned]) {
      if (isSessionID(sid) && !owners.has(sid)) owners.set(sid, p)
    }
  }
  for (const [p, j] of parsed) {
    const watch = Array.isArray(j?.watch) ? j.watch : []
    for (const sid of watch) if (isSessionID(sid) && !owners.has(sid)) owners.set(sid, p)
  }
  sessionOwnerCache = { ts: Date.now(), owners }
}
const statePathForSession = (sessionID: string): string => {
  if (Date.now() - sessionOwnerCache.ts > 2_000) rebuildSessionOwners()
  return sessionOwnerCache.owners.get(sessionID) ?? TG_STATE_PATH
}
const botIdForSession = (sessionID: string): string => botIdFromStatePath(statePathForSession(sessionID))
const readTargetFrom = (path: string): string => {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as any
    if (isSessionID(j?.front)) return j.front
    if (isSessionID(j?.pinned)) return j.pinned
  } catch {
    /* unreadable target file: skip it this round */
  }
  return ""
}
let loopTargetCache = { ts: 0, targets: [] as string[] }
const currentLoopTargets = (): string[] => {
  const now = Date.now()
  if (now - loopTargetCache.ts < 2000) return loopTargetCache.targets
  const out: string[] = []
  for (const p of [TG_STATE_PATH, ...EXTRA_TARGET_PATHS]) {
    const t = readTargetFrom(p)
    // 备用 Bot 的目标与主目标相同时必须去重：同一会话被两个来源驱动会重复注入。
    if (t && !out.includes(t)) out.push(t)
  }
  loopTargetCache = { ts: now, targets: out }
  return out
}
const currentLoopTarget = (): string => currentLoopTargets()[0] ?? ""
const isLoopTarget = (sessionID: string): boolean => currentLoopTargets().includes(sessionID)

// R2686：事件到达时状态可能刚变（front/pinned/新增目标）；先失效 2s 缓存，
// 否则“即时重评”仍会拿旧目标，用户看到按钮/命令延迟。
const invalidateStateCaches = (): void => {
  loopTargetCache = { ts: 0, targets: [] }
  sessionOwnerCache = { ts: 0, owners: new Map() }
}

/**
 * R1839：合并 loop 注册表时的「当前目标保命」规则。
 *
 * 旧实现 `[...new Set([...currentLoopTargets(), ...loopSessions])].slice(-8)` 把**当前目标放在最前**，
 * 再用 `slice(-8)` 取最后 8 条 —— 当 sticky 注册表已有 ≥8 条时，`currentLoopTargets()` 会被**整体挤掉**。
 * 后果：用户刚 `/use` 钉选的新前台（未发过标记词、只靠本函数“粘”进注册表）永远进不了注册表 →
 * 下一轮 `loop = loopSessions.has(sid)` 为假 → `eval begin … loop=no -> skip` → 症状正是「自动循环没了」。
 * 修法：把目标从 sticky 里剔除后**追加到末尾**，保证它们优先占据 cap 的末尾名额（目标 ≤3、cap 8，恒能容纳）。
 * 纯函数、无 IO，可单测。
 */
export const mergeLoopRegistry = (
  sticky: Iterable<string>,
  targets: readonly string[],
  cap = 8,
): string[] => {
  const tg = [...new Set(targets.filter((x) => typeof x === "string" && x.startsWith("ses_")))]
  const others = [...new Set([...sticky])].filter((x) => !tg.includes(x))
  const room = Math.max(0, cap - tg.length)
  return [...others.slice(-room), ...tg].slice(-cap)
}
// R1909：串行评估链的「楔子（wedge）」计时必须从**链真正开始**那一刻起算，绝不能在每次
// 入队时重置。否则：定时器每 60s 对每个目标调一次 evaluateQueued，而阈值 EVAL_WEDGE_MS=90s
// —— 每次入队都把计时归零，`held` 永远 <90s，看门狗永不触发。症状：某会话评估链一旦挂起
// （promptAsync/fetch 悬挂）就**永久静默停摆**（实测 bot2 停摆 30+ 分钟、无 loop wedge 日志）。
// 规则：无在途链（prevSince===undefined）或刚判定 wedge（需另起新链）时才取 now；否则保留原起点。
export const advanceQueueSince = (
  prevSince: number | undefined,
  now: number,
  wedged: boolean,
): number => (prevSince === undefined || wedged ? now : prevSince)
// R1918：把「链入队 + 完成即清理」抽成可测过程。
// 原实现在 finally 回调里判 `queue.get(sid) === next` —— 但 queue 存的是 `next.finally(cb)`
// 返回的**另一个** promise，它永不等于 next，于是 `queue.delete/queueSince.delete` **从不执行**。
// 后果：queueSince 永远停在首拍，`held` 持续增长，看门狗每隔 ~120s 就对每个会话误报一次
// `loop wedge detected`（≈90 次/小时/会话，实测 3 会话 ~270 次/小时），把真正的挂起淹没在噪声里。
// 修法：先造 finally 包装 `tracked`，用 `tracked` 自身做身份校验（旧链完成时若 queue 已被
// 更新的链替换，则不得误清新链）。
export const trackQueuedChain = (
  next: Promise<unknown>,
  queue: Map<string, Promise<unknown>>,
  queueSince: Map<string, number>,
  sessionID: string,
  prevSince: number | undefined,
  now: number,
  wedged: boolean,
): Promise<unknown> => {
  queueSince.set(sessionID, advanceQueueSince(prevSince, now, wedged))
  let tracked: Promise<unknown>
  tracked = next.finally(() => {
    if (queue.get(sessionID) === tracked) {
      queue.delete(sessionID)
      queueSince.delete(sessionID)
    }
  })
  queue.set(sessionID, tracked)
  return tracked
}
// R2774（运营者：「回合后和循环会抢占吗」）：用户消息优先的判定必须把**正在注入**
// 的那条也算上。泵在发 promptAsync 之前就把条目从 pinqueue 移到 pininflight 并落盘；
// 旧实现只数 pinqueue ⇒ 这段窗口里循环看漏用户消息，可能先发车，用户消息反而排在
// 循环轮次后面（idle 模式要再等一整个回合）。
//
// pininflight 重启后**不重放**（at-most-once），所以崩溃残留不能用 claimedAt 永久
// 挡住循环：只认 PINFLIGHT_GRACE_MS 内的认领。正常发送是亚秒级，2 分钟足够覆盖
// promptAsync 卡顿；超时说明发送已异常，继续让循环推进比永久停摆更安全。
export const PINFLIGHT_GRACE_MS = 120_000
// R2857：退休表（429 换会话的旧→successor）的跟随上限，与 tg-bridge 的 RETIRED_TTL_MS
// 对齐。过期记录既不写入也不会被装载，这里再挡一次，防止手工/历史状态文件把它们带回来。
const RETIRED_CHAIN_TTL_MS = 7 * 24 * 3600_000
export const countPendingUserInjects = (
  states: ReadonlyArray<{ pinqueue?: unknown; pininflight?: unknown; retired?: unknown } | null | undefined>,
  sessionID: string,
  now: number,
): number => {
  // R2857（运营者：「注入消息不能代替循环提示词被注入」/「也可能是注入消息被静默抛弃」）：
  // 429 换会话后，队列条目的 `sid` 会在「retired 已登记、磁盘队列尚未归一」的窗口里
  // 停在旧会话；链式 A→B→C 时还可能只改了链首。此处若仍按精确 `sid` 计数，循环就
  // 看不见正在排队的用户消息，抢先注入 recover/round 提示词，用户消息只能再等一轮。
  // 与泵共用同一判据：先把各状态文件的退休表汇成 old→new，再沿链解析条目与目标。
  const retired = new Map<string, { newSid: string; ts: number }>()
  for (const j of states) {
    const arr = j?.retired
    if (!Array.isArray(arr)) continue
    for (const ent of arr) {
      if (!Array.isArray(ent)) continue
      const oldSid = String(ent[0] ?? "")
      const newSid = String(ent[1] ?? "")
      const ts = Number(ent[2] ?? 0)
      if (!oldSid.startsWith("ses_") || !newSid.startsWith("ses_") || oldSid === newSid) continue
      // 与桥的装载口径一致：无时间戳/超过 7 天的退休记录不再跟随（避免陈旧链把
      // 两条无关会话误并成一条，挡住循环）。
      if (!(ts > 0) || now - ts > RETIRED_CHAIN_TTL_MS) continue
      const prev = retired.get(oldSid)
      if (prev && prev.ts >= ts) continue
      retired.set(oldSid, { newSid, ts })
    }
  }
  const liveSid = (sid: string): string => {
    let cur = sid
    for (let i = 0; i < 8; i++) {
      const next = retired.get(cur)?.newSid ?? ""
      if (!next || next === cur) break
      cur = next
    }
    return cur
  }
  const target = liveSid(sessionID)
  const ids = new Set<string>()
  let anonymous = 0
  const add = (arr: unknown, inflight: boolean): void => {
    if (!Array.isArray(arr)) return
    for (const it of arr) {
      const o = it as any
      if (liveSid(String(o?.sid ?? "")) !== target) continue
      if (inflight) {
        // 旧版本的 pininflight 没有 claimedAt（只有入队时刻 ts）；新条目以认领时刻为准。
        const claimedAt = Number(o?.claimedAt ?? 0)
        const at = claimedAt > 0 ? claimedAt : Number(o?.ts ?? 0)
        // 没有时间戳 = 无法证明它还在发送中；宁可不信，也不能让它永久挡住循环。
        if (!(at > 0) || now - at > PINFLIGHT_GRACE_MS) continue
      }
      const id = String(o?.id ?? "")
      if (id) ids.add(id)
      else anonymous++
    }
  }
  for (const j of states) {
    add(j?.pinqueue, false)
    add(j?.pininflight, true)
  }
  return ids.size + anonymous
}
// R1107：用户主动中断（⏹ doStop 成功）的会话。halted 逐会话持久化在各 Bot 状态文件的
// halted 数组里（tg-bridge 侧 doStop → savePersistedState）。auto-continue 必须尊重它，
// 否则"用户主动终止后循环仍继续"。不清共享总闸 → 其它会话/Bot 不受影响；用户新消息
//（pump 投递成功）或 /loop start 会清除 halted。2s 缓存避免每次 eval 都重读文件。
let haltedSessionsCache = { ts: 0, sids: [] as string[] }
const haltedSessions = (): string[] => {
  const now = Date.now()
  if (now - haltedSessionsCache.ts < 2_000) return haltedSessionsCache.sids
  // R2500：先读**共享解除表**。halted 是各 Bot 状态文件的并集，而清除只由「当前那个 Bot」
  // 写自己的文件 → 跨 Bot 的停机**永远解不掉**（2026-10-18 实测：bot4 文件里的本会话停机
  // 让 primary 的循环永久跳过）。解除表是唯一能跨实例生效的通道，故并集必须先减它。
  // R2572：统一走 halt-release.ts；文件缺失/损坏时返回 {}（停机保持有效）。
  const rel = readHaltRelease()
  const out: string[] = []
  for (const p of [TG_STATE_PATH, ...EXTRA_TARGET_PATHS]) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as any
      const hl = Array.isArray(j?.halted) ? (j.halted as unknown[]) : []
      for (const s of hl)
        if (typeof s === "string" && s.startsWith("ses_") && !(s in rel) && !out.includes(s)) out.push(s)
    } catch {
      /* 个别状态文件读不到：跳过该文件 */
    }
  }
  haltedSessionsCache = { ts: now, sids: out }
  return out
}
// 主实例的 front（多实例护栏用）。备用实例若与主实例指向同一会话，两套循环会同时
// 注入同一个会话 -> 轮次翻倍/互相打断，因此这种情况备用实例直接放弃注入。
const primaryFront = (): string => {
  if (AC_SCOPE === "primary") return ""
  try {
    const j = JSON.parse(readFileSync(`REDACTED_ROOT/.config/opencode/tg-chats.json`, "utf8")) as any
    return typeof j?.front === "string" && j.front.startsWith("ses_") ? j.front : ""
  } catch {
    return ""
  }
}
const SYNTHETIC_PROMPT_PREFIXES = ["继续自动筛查循环", "上一轮自动筛查应答因可恢复错误中断"]
const isSyntheticPrompt = (text: string): boolean => {
  const t = text.trimStart()
  return SYNTHETIC_PROMPT_PREFIXES.some((prefix) => t.startsWith(prefix))
}
// R2674：压缩设置是**每个 Bot 自己**的（tg-bridge 的推送过滤页写入各自的
// tg-chats[-<id>].json）。此前这里固定读 primary 的 tg-chats.json → bot5/bot6
// 在菜单里关掉自动压缩/改阈值，对它们自己的循环会话完全不生效。
const readCompactPrefsFrom = (path: string): { auto: boolean; threshold: number } => {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as any
    const c = j?.compact
    const th = Number(c?.threshold)
    return {
      auto: c?.auto !== false,
      threshold: th >= 0.5 && th <= 0.95 ? th : COMPACT_THRESHOLD,
    }
  } catch {
    return { auto: true, threshold: COMPACT_THRESHOLD }
  }
}

// R2607（用户指令：纠正会话长度计算与自动压缩）：
// 每会话**真实模型窗口**解析。tg-bridge 抓取的窗口表（provider.list / HttpApi /api/model）
// 经 globalThis + 落盘文件双通道共享给本模块（同进程不同模块实例，不能直接 import）。
// 此前 maybeCompact 一律除以硬编码 1M：200k/262k 模型的 70% 阈值被算松 5 倍
// （真实 140k 只算 13.4%），自动压缩形同虚设 —— 与 tg-bridge 界面「窗口未知就显示 ?」
// 的诚实口径直接矛盾。表不可用时回退 1M（保持旧行为，避免误压还有 headroom 的会话）。
export const resolveContextWindow = (modelID: string, providerID: string): number | null => {
  const mid = String(modelID ?? "")
  const pid = String(providerID ?? "")
  if (!mid) return null
  const key = `${pid}/${mid}`
  try {
    const g = (globalThis as Record<string, unknown>).__oc_model_windows__ as { windows?: Record<string, number> } | undefined
    const v = Number(g?.windows?.[key])
    if (Number.isFinite(v) && v > 0) return v
  } catch {
    /* ignore */
  }
  try {
    const j = JSON.parse(readFileSync(MODEL_WINDOWS_PATH, "utf8")) as { windows?: Record<string, number> }
    const v = Number(j?.windows?.[key])
    if (Number.isFinite(v) && v > 0) return v
  } catch {
    /* ignore */
  }
  return null
}
// R2607：token 全量口径（与 tg-bridge / 宿主 TUI 一致的 in+out+rea+cr+cw）。
// 保留导出名给既有调用/测试；实现统一收口到 ctx-usage.ts，避免四份口径漂移。
export const tokenSumOf = (tk: any): number => tokenTotalOf(tk)
const LOOP_USER_MARKERS = ["筛查循环", "自动筛查"]
const STATUS_RE = /\[\s*STATUS\s*:/
const isLoopControlUserText = (t: string): boolean =>
  LOOP_USER_MARKERS.some((m) => t.includes(m)) || STATUS_RE.test(t)
const isNeutralUserText = (t: string): boolean => {
  const s = t.trim()
  return s === "" || s.startsWith("/")
}

const SOURCE = (() => {
  try {
    return new URL(import.meta.url).pathname
  } catch {
    return "unknown"
  }
})()
const sanitizeLog = (s: unknown): string =>
  shrinkLogIds(stripLogControls(String(s))).slice(0, 200)

// 一轮里除了文本还有没有别的产出（tool / reasoning / step-finish）。
// 纯工具轮（有命令执行、有思考）不是"空转"：把这种轮次算进空转熔断会让
// 自动循环在正常干活时熔断退避（用户看到"没有自动循环"）。
const hasNonTextWork = (m: any): boolean => {
  const parts = m?.parts
  if (!Array.isArray(parts)) return false
  return parts.some((p: any) => {
    const t = String(p?.type ?? "")
    if (t === "text") return String(p?.text ?? "").trim().length > 0
    return t === "tool" || t === "reasoning" || t === "step-finish" || t === "step_finish"
  })
}
// R1092: 只有【工具/步骤产出】才算"实质性干活"；reasoning 纯思考不算。
// hasNonTextWork 把 reasoning 算进去是为了豁免 empty-stall（防 R1065 熔断误伤），
// 但不能因此把"还在想的回合"当成完成注入循环文本。
const hasRealToolWork = (m: any): boolean => {
  const parts = m?.parts
  if (!Array.isArray(parts)) return false
  return parts.some((p: any) => {
    const t = String(p?.type ?? "")
    return t === "tool" || t === "step-finish" || t === "step_finish"
  })
}

const textOf = (m: any): string => {
  const parts = m?.parts
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p: any) => p?.type === "text")
    .map((p: any) => p.text ?? "")
    .join("")
}

const rowRoleOf = (r: any): string => String(r?.info?.role ?? r?.role ?? r?.type ?? "")
const rowPartsOf = (r: any): any[] =>
  Array.isArray(r?.parts) ? r.parts : Array.isArray(r?.info?.parts) ? r.info.parts : []
const rowTextOf = (r: any): string => {
  const direct = typeof r?.text === "string" ? r.text : ""
  if (direct) return direct
  return rowPartsOf(r)
    .filter((p: any) => p?.type === "text")
    .map((p: any) => String(p?.text ?? ""))
    .join("")
}
// R2795（运营者：「为什么不会429重启，为什么需要我手动点」）：429 证据必须区分
// 「真实用户消息触发的回合」和「循环/恢复注入的 synthetic 回合」。
//   · 真实用户 → 即使 Bot 的循环已停、调用方也明确点过 /loop stop，这次 429
//     仍应结束整轮并自动换会话：用户正在等这条回复，不能静默留在坏会话里；
//   · synthetic → 旧行为（R2785）继续保留：已停 Bot 的在途恢复提示命中 429
//     不应打断仍在服务其它 Bot 的整轮。
// 只看 errored assistant **之前最近的一条** user/synthetic 行；新用户消息开的新
// 回合不能拿旧的真实发言来冒充。
//
// R2886（运营者：「刚刚10分钟两个bot都卡了」）：并非所有 synthetic 都是陈旧
// 注入。429 换会话的续跑提示（`阅读（ses_…）对话历史，继续任务`）和 CI 重启
// 恢复提示（`CI 在上一回合…`）是**当前正在推进的工作**；它们命中 429 时若按
// R2785 忽略，本轮不会结束，所有 Bot 一起卡到用户再发消息为止
// （2026-11-21 10:44→10:56 双 Bot 停摆）。把这类回合单独归为 continuation：
// 仍不算真实用户，但足以触发换轮；循环注入 / 恢复摘录 / role=synthetic 继续忽略。
export type QuotaTurnKind = "user" | "continuation" | "synthetic"
const CONTINUATION_PROMPT_PREFIXES = ["阅读（ses_", "CI 在上一回合", "自动恢复：上一轮 run"]
export const quotaTurnKind = (rows: unknown[]): QuotaTurnKind => {
  const list = Array.isArray(rows) ? rows : []
  let at = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (rowRoleOf(list[i]) === "assistant") {
      at = i
      break
    }
  }
  if (at < 0) return "synthetic"
  for (let i = at - 1; i >= 0; i--) {
    const r = list[i]
    const role = rowRoleOf(r)
    if (role !== "user" && role !== "synthetic") continue
    if (role === "synthetic") return "synthetic"
    if (rowHasLoopInjectMeta(r)) return "synthetic"
    const raw = rowTextOf(r)
    if (!raw.trim()) continue
    // R2794 结构护栏：带摘录标记的行是注入器自己的产物，无论前缀如何都不能
    // 反向冒充真实用户/续跑回合。
    if (raw.includes(EXCERPT_MARKER)) return "synthetic"
    const t = raw.trimStart()
    // 必须排在 isSyntheticUserText 之前：这些前缀同时也在合成清单里。
    if (CONTINUATION_PROMPT_PREFIXES.some((prefix) => t.startsWith(prefix))) return "continuation"
    // 与 lastRealUserExcerpt 同一套前缀判据：rollover/resume/循环注入都可能是
    // role=user，但都不是“用户正在等”的那条消息。
    if (isSyntheticUserText(raw)) return "synthetic"
    return "user"
  }
  return "synthetic"
}
export const quotaTurnUserInitiated = (rows: unknown[]): boolean => quotaTurnKind(rows) === "user"
export const quotaTurnContinuation = (rows: unknown[]): boolean => quotaTurnKind(rows) === "continuation"
const rowHasNormalOutput = (r: any): boolean => {
  if (r?.info?.error || r?.error) return false
  if (rowTextOf(r).trim().length > 0) return true
  return rowPartsOf(r).some((p: any) => String(p?.type ?? "") === "tool")
}
export const revertableSyntheticPrompt = (rows: unknown[]): string | null => {
  const list = Array.isArray(rows) ? rows : []
  let candidate: string | null = null
  let assistantAfterCandidate = false
  for (let i = list.length - 1; i >= 0; i--) {
    const r: any = list[i]
    const role = rowRoleOf(r)
    if (role === "assistant") {
      if (rowHasNormalOutput(r)) {
        if (candidate) break
        return null
      }
      assistantAfterCandidate = true
      continue
    }
    if (role === "user" || role === "synthetic") {
      // R2659/R2663：循环注入（simple 的「继续」/ custom 任意文案）靠 metadata
      // 标明合成身份，不能被当成可回退的真实用户消息；否则一次无产出回合会把
      // 用户输入 revert 掉。full 的注入仍由文本前缀识别。
      if (!rowHasLoopInjectMeta(r) && !isSyntheticUserText(rowTextOf(r))) break
      const id = String(r?.info?.id ?? r?.id ?? "")
      if (id) candidate = id
      continue
    }
    if (role === "idle") continue
    break
  }
  return candidate && assistantAfterCandidate ? candidate : null
}

/**
 * R2781（运营者：「当某回合结束时如果开启循环并且有回合结束注入的消息时，
 * 不需要注入循环提示」）：判断一条 assistant 消息是不是某个 user/synthetic
 * 消息的**第一个**应答。首应答就意味着这条 user 消息是在上一回合结束时注入的
 * （用户 pinQueue / 429 换会话提示 / resume-once 提示 / 循环自己的提示都算）。
 *
 * 只要中间已经隔了别的 assistant 步，就说明当前错误发生在一个持续回合的中途，
 * 不是“回合结束注入”的产物 —— 返回 null，保留原有 recover 路径。
 *
 * 这是纯函数，便于回归：R2781 实证的两条坏序列
 *   · 02:59:47 注入「阅读（ses_…）对话历史，继续任务」→ 02:59:48 失败
 *     → 02:59:55 又注入「继续」；
 *   · 03:19:19 注入「继续」→ 03:19:19 失败 → 03:19:26 再注入「继续」。
 * 两次都是“上一条注入消息的首应答已经失败，却又叠一条循环提示”。
 */
export const turnStartMessageOfAssistant = (
  rows: unknown[],
  assistantID: string,
): { id: string; role: string; text: string; created: number } | null => {
  const list = Array.isArray(rows) ? rows : []
  const target = String(assistantID ?? "")
  if (!target) return null
  for (let i = list.length - 1; i >= 0; i--) {
    const r: any = list[i]
    const id = String(r?.info?.id ?? r?.id ?? "")
    if (id !== target) continue
    for (let j = i - 1; j >= 0; j--) {
      const p: any = list[j]
      const isCompaction =
        p?.info?.compaction === true ||
        p?.compaction === true ||
        String(p?.info?.type ?? p?.type ?? "") === "compaction"
      if (isCompaction) continue
      const role = rowRoleOf(p)
      if (role === "idle") continue
      // 当前 assistant 是同一回合的后续一步：不是回合结束注入。
      if (role === "assistant") return null
      if (role !== "user" && role !== "synthetic") return null
      return {
        id: String(p?.info?.id ?? p?.id ?? ""),
        role,
        text: rowTextOf(p),
        created: Number(p?.info?.time?.created ?? p?.time?.created ?? 0),
      }
    }
    return null
  }
  return null
}

/**
 * R2788（运营者：「当某回合结束时如果开启循环并且有回合结束注入的消息时，
 * 不需要注入循环提示」）：判断一条 assistant 消息之后是否已经存在**本 run 的
 * 回合结束注入消息**。存在时，下一轮由那条消息自然驱动，不能再叠一条 ROUND_PROMPT。
 *
 * 只认会在回合结束后开启新回合的消息：
 *   · 真实用户消息（TG 的 `[TG …]` / TUI 的普通 user 行）；
 *   · pinQueue/桥注入的 `[TG …]` 消息（用户优先，循环不得抢答）；
 *   · 自动循环/恢复提示（metadata.loopInject 或固定前缀）；
 *   · 429 换会话提示（`阅读（ses_…）对话历史，继续任务`）；
 *   · CI 重启恢复提示（`CI 在上一回合…`）；
 *   · 后台命令完成通知（`<shell …>`，宿主会用它续起回合）。
 *
 * compaction/idle 行不是回合边界；assistant 行说明 M 已不是尾条，返回 null。
 * pre-boot 的 user 尾条也不在这里处理 —— 它由 preBootUserTail 的恢复路径负责，
 * 不能用本闸门挡住（否则重启后的合法恢复会被永久 defer）。
 */
const TURN_END_PROMPT_PREFIXES = [
  "阅读（ses_",
  "CI 在上一回合",
  "继续自动筛查循环",
  "上一轮自动筛查应答因可恢复错误中断",
] as const

const isTurnEndInjectionRow = (r: any): boolean => {
  const role = rowRoleOf(r)
  if (role !== "user" && role !== "synthetic") return false
  if (rowHasLoopInjectMeta(r)) return true
  const raw = rowTextOf(r)
  const trimmed = raw.trimStart()
  if (trimmed.startsWith("[TG ")) return true
  if (TURN_END_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true
  if (/^<shell\b/i.test(trimmed)) return true
  // 没有 synthetic 标记的 user 行 = TUI/宿主的真实用户消息。
  const synthetic = r?.info?.synthetic === true || r?.info?.type === "synthetic" || role === "synthetic"
  return !synthetic
}

export const turnEndInjectionAfterAssistant = (
  rows: unknown[],
  assistantID: string,
  bootAt = 0,
): { id: string; role: string; text: string; created: number } | null => {
  const list = Array.isArray(rows) ? rows : []
  const target = String(assistantID ?? "")
  if (!target) return null
  let at = -1
  for (let i = 0; i < list.length; i++) {
    const r: any = list[i]
    if (String(r?.info?.id ?? r?.id ?? "") === target) at = i
  }
  if (at < 0) return null
  for (let i = at + 1; i < list.length; i++) {
    const p: any = list[i]
    const isCompaction =
      p?.info?.compaction === true ||
      p?.compaction === true ||
      String(p?.info?.type ?? p?.type ?? "") === "compaction"
    if (isCompaction) continue
    const role = rowRoleOf(p)
    if (role === "idle") continue
    if (role === "assistant") return null
    if (role !== "user" && role !== "synthetic") continue
    const created = Number(p?.info?.time?.created ?? p?.time?.created ?? 0)
    // pre-boot 尾条走既有恢复路径，不算“本回合结束注入”。
    if (created > 0 && bootAt > 0 && created < bootAt) return null
    if (!isTurnEndInjectionRow(p)) continue
    return {
      id: String(p?.info?.id ?? p?.id ?? ""),
      role,
      text: rowTextOf(p),
      created,
    }
  }
  return null
}

const errorName = (m: AssistantMessage): string => {
  const e = m?.error as any
  if (!e || typeof e !== "object") return "unknown"
  return String(e.name ?? e.type ?? "unknown")
}

// R2496：取错误文案（用于网络类错误匹配，触发自动切节点）。
const errorText = (m: AssistantMessage): string => {
  const e = m?.error as any
  if (!e) return ""
  if (typeof e === "string") return e
  return String(e.message ?? e.data?.message ?? "")
}
const errorStatus = (m: AssistantMessage): number => {
  const e = m?.error as any
  if (!e || typeof e !== "object") return 0
  return Number(e.statusCode ?? e.status ?? e.data?.statusCode ?? e.data?.status ?? 0) || 0
}

// R2565: free-tier 429 carries retryAfterMs (observed ~12.9h, longer than the
// operator's 6h blacklist). Log the provider's reset hint so egress-watch can
// keep that egress out of selection until its quota actually resets.
const errorRetryAfterSec = (m: AssistantMessage): number => {
  const e = m?.error as any
  if (!e || typeof e !== "object") return 0
  const ms = Number(e.retryAfterMs ?? e.data?.retryAfterMs ?? 0)
  if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms / 1000)
  const h = e.response?.headers ?? e.data?.response?.headers ?? e.headers ?? {}
  const raw = Number(h["retry-after"] ?? h["Retry-After"] ?? 0)
  if (Number.isFinite(raw) && raw > 0) return Math.ceil(raw)
  return 0
}

const isAbortSignal = (e: any): boolean => {
  if (!e) return false
  if (typeof e === "string") return /aborted|interrupt|step interrupted/i.test(e)
  return /MessageAborted|aborted|interrupt|step interrupted/i.test(
    `${e.name ?? ""} ${e.type ?? ""} ${e.message ?? ""}`
  )
}

const isFatal = (m: AssistantMessage): boolean => {
  const e = m?.error as any
  if (!e) return false
  if (isAbortSignal(e)) return true
  if (e.name === "APIError" && e.data && e.data.isRetryable === false) return true
  return false
}

export const AutoContinuePlugin: Plugin = async ({ client }) => {
  // Invalidate callbacks left by an older hot-reloaded instance before any
  // serve/TUI early-return.  Old r61 code checks this same generation key.
  const bootGen = globalThis as Record<string, unknown>
  bootGen[AC_GEN_KEY] = (typeof bootGen[AC_GEN_KEY] === "number" ? (bootGen[AC_GEN_KEY] as number) : 0) + 1
  // Only the long-lived service owns automatic continuation.  The interactive
  // TUI also loads plugins; running both copies caused two independent loops
  // (and an old TUI copy could overwrite loop-ctl after /stop).
  const isServe = typeof process !== "undefined" && process.argv.some((arg) => arg === "serve")
  if (!isServe) {
    // TUI 不跑续跑循环：按 ESC 只应「暂停该会话本轮」（R1553，per-session），
    // 不写全局停门；TUI 是独立进程，内存 skipState 传不到 serve 侧，只落盘遥测，
    // serve 侧 ≤60s 一拍 evaluate 会看到该消息 error=aborted 并走 pause，用户下条消息自然恢复。
    return {
      event: async ({ event }: any) => {
        if (event?.type !== "message.updated") return
        const props: any = event?.properties ?? {}
        const info: any = props?.info ?? props
        const err: any = info?.error
        const signal = typeof err === "string" ? err : `${err?.name ?? ""} ${err?.type ?? ""} ${err?.message ?? ""}`
        if (info?.role === "assistant" && isAbortSignal(err) && /aborted|interrupt/i.test(signal)) {
          // R1553：ESC = 仅暂停该会话本轮，**不写全局 loop-ctl 硬闸**（此前写
          // stopped=true 导致整循环死透）。TUI 侧是独立进程/实例，内存 skipState
          // 传不到 serve 侧 —— 只落盘遥测，serve 侧下一拍 evaluate（≤60s）会看到
          // 该消息 error=aborted 并走 pause（per-session），用户下条消息自然恢复。
          noteAbortEvent({
            ts: Date.now(),
            session: String(info?.sessionID ?? ""),
            name: typeof err === "string" ? err : String(err?.name ?? err?.type ?? "unknown"),
            verdict: "pause",
            fresh: true,
            userAfter: false,
            src: "tui-event",
          })
        }
      },
    }
  }
  const banner = `[auto-continue] plugin loaded (version=${VERSION}, source=${SOURCE})`
  // 启动自检：身份/代号/状态文件/解析出的目标。多实例场景下这行是唯一能立刻
  // 判断"某个实例为什么不动"的入口（此前主实例静默了很久无从查证）。
  const bootSelfCheck = `[auto-continue] boot self-check: scope=${AC_SCOPE} state=${TG_STATE_PATH} target=${currentLoopTarget().slice(0, 12) || "(none)"} marker=${MARKER_STATE_PATH}`
  try {
    await client.app.log({ body: { service: "auto-continue", level: "info", message: banner } })
    await client.app.log({ body: { service: "auto-continue", level: "info", message: bootSelfCheck } })
  } catch (err) {
    console.log(`${banner} (app.log failed: ${String(err)})`)
  }
  const decided = new Set<string>()
  // 重启孤儿只记一次日志（每个 msg.id）—— 必须与 decided 同处提前声明（闭包引用安全）
  const orphanLogged = new Set<string>()
  // R704：重启后最后一条是 **preboot user 尾条**（如后台任务完成通知）而其后没有 assistant。
  // 旧逻辑只解锁 preboot assistant，遇到 user 尾条会停在 decided/空闲复核，表现为 bot4
  // 「有通知但永远不回复」。按 sid 记尾条 id，成功注入后删除，避免影响后续真实用户回合。
  const preBootUserTail = new Map<string, string>()
  const pending = new Map<string, number>()
  const emptyStreak = new Map<string, number>()
  // R2235：已完成但只有 reasoning 的回合是“死回合”，不是仍在生成。
  // 连续完成仍无文本/工具时允许有限续跑，超过 3 次再走 empty-stall 退避，
  // 避免 2026-10-20 09:10 CST 的 47 分钟零注入重现，同时不无限空转。
  const completedDeadStreak = new Map<string, number>()
  // 已回源核对过的消息（避免同一条反复打 API）
  const refetchedEmpty = new Set<string>()
  // 粘性"这是循环会话"标志：此前循环资格只靠**用户消息里的关键字**（筛查循环 / [STATUS: /
  // 合成提示）点亮 —— 对话术不同的第二个会话（另一个项目）随时可能因没有匹配而被判
  // "不是循环会话"→不再续跑，表现为"另一个会话总是不循环"。
  // 安全性：isLoopTarget 已把范围限制在"各 Bot 自己的 front/pinned"，粘性标志不可能
  // 让循环去驱动无关会话；停止仍走 /loop stop（全局闸）。
  const LOOP_SESSIONS_PATH = `REDACTED_ROOT/.config/opencode/loop-sessions.json`
  const loopSessions = new Set<string>()
  try {
    const arr = JSON.parse(readFileSync(LOOP_SESSIONS_PATH, "utf8"))
    if (Array.isArray(arr)) for (const x of arr) if (typeof x === "string" && x.startsWith("ses_")) loopSessions.add(x)
  } catch {
    /* first run */
  }
  // R1048：显式关闭的会话（`/loop off`）。
  // 为什么必须单独一张清单：`persistLoopSessions` 会把 `currentLoopTargets()`
  // （各 Bot 的 front/pinned）**重新并回** loop-sessions —— 所以"从正向名单里删掉"
  // 对当前 front 会话**无效**，下一次落盘又回来了。关闭必须是**显式否定**。
  const LOOP_OFF_PATH = `REDACTED_ROOT/.config/opencode/loop-sessions-off.json`
  const loopOffSessions = new Set<string>()
  try {
    const arr = JSON.parse(readFileSync(LOOP_OFF_PATH, "utf8"))
    if (Array.isArray(arr)) for (const x of arr) if (typeof x === "string" && x.startsWith("ses_")) loopOffSessions.add(x)
  } catch {
    /* first run */
  }
  const persistLoopOff = (): void => {
    try {
      // R2777：否定名单**不截断**。旧实现与正向粘性名单共用 slice(-LOOP_SESSIONS_CAP)，
      // 第 17 条写入会把数组头部的 /loop off 目标挤掉；下一轮该会话若是 front/pinned 就会
      // 按默认规则重新入循环（用户没点过 /loop start）。正向名单的条数仍由
      // mergeLoopRegistry 控制。
      atomicWriteJson(LOOP_OFF_PATH, [...loopOffSessions])
    } catch (err) {
      void log("error", `loop off list persist failed: ${sanitizeLog(err).slice(0, 100)}`)
    }
  }
  // R2680：标题标记每次重算都以**盘上**的 loop-off 名单为准，最多滞后 5s。
  // 不直接用上面的 loopOffSessions：它只在 eval 时刷新（约 60s），/loop off 后
  // 标题会继续挂 [LOOP] 一小会儿，正好是用户截图质疑“到底停没停”的窗口。
  const isLoopOffNow = (sessionID: string): boolean => {
    try {
      const arr = JSON.parse(readFileSync(LOOP_OFF_PATH, "utf8"))
      return Array.isArray(arr) && arr.includes(sessionID)
    } catch {
      return false
    }
  }

  let loopSessionsDirty = false
  const persistLoopSessions = (): void => {
    if (!loopSessionsDirty) return
    loopSessionsDirty = false
    // R1847：落盘前先并入**盘上**注册表。三个 Bot 各一份 auto-continue 进程共享同一文件，
    // 纯内存 sticky 落盘时，别进程刚写的条目会被本进程覆盖（后写者胜）。先读盘并集，
    // 再走"目标保命"合并（R1839）。cap 也从 8 对齐到 16 —— 桥的 writeIdList 用的是 16，
    // 旧 cap 8 会在每次 auto-continue 落盘时把第 9..16 条历史直接截掉（跨进程名单震荡）。
    try {
      const arr = JSON.parse(readFileSync(LOOP_SESSIONS_PATH, "utf8"))
      if (Array.isArray(arr)) for (const x of arr) if (typeof x === "string" && x.startsWith("ses_")) loopSessions.add(x)
    } catch {
      /* 读不到 = 无盘上条目 */
    }
    const keep = mergeLoopRegistry(loopSessions, currentLoopTargets(), LOOP_SESSIONS_CAP)
    try {
      atomicWriteJson(LOOP_SESSIONS_PATH, keep)
      void log("info", `loop sessions persisted: ${keep.map((x) => x.slice(0, 12)).join(",")}`)
    } catch (err) {
      // 静默失败会让"粘性标志"变成死代码而无人察觉
      void log("error", `loop sessions persist failed: ${sanitizeLog(err).slice(0, 120)}`)
    }
  }
  const giveupCount = new Map<string, number>()
  const loopSeen = new Map<string, number>()
  const lastRoundAt = new Map<string, number>()
  const lastUserNote = new Map<string, number>()
  // R2674：按 Bot 状态文件缓存压缩设置（每个 Bot 自己一套 auto/threshold）。
  const prefsCache = new Map<string, { ts: number; auto: boolean; threshold: number }>()
  const skipState = new Map<string, { lastId: string; reason: string; ts?: number }>()
  const queue = new Map<string, Promise<void>>()
  const usage = new Map<string, number>()
  const deferLoggedAt = new Map<string, number>()
  const sharedTargetLogAt = new Map<string, number>()
  // Telegram 注入队列里该会话还排着几条用户消息（用户优先，循环不得抢跑）。
  // R2674：pinqueue 是**每个 Bot 自己**的状态文件字段 —— bot5 的用户消息只在
  // tg-chats-bot5.json 里。此前固定读 primary 的 tg-chats.json ⇒ bot5/bot6 的
  // 用户消息看不到，「用户优先」对它们失效（循环可能抢在用户消息前注入）。
  // 按 id 去重：极少数迁移/双写场景同一队列条目可能出现在两个文件里，只算一次。
  // R2774：除 pinqueue 外也必须看到 pininflight —— 泵已认领、promptAsync 尚未到宿主
  // 的那条用户消息仍是「用户先发」；只看 pinqueue 会让循环在这个窗口里抢跑。
  const pendingUserInjects = (sessionID: string): number => {
    const states: any[] = []
    for (const p of ALL_STATE_PATHS) {
      try {
        states.push(JSON.parse(readFileSync(p, "utf8")))
      } catch {
        /* 某个 Bot 的状态文件读不到：跳过，不影响其余 */
      }
    }
    return countPendingUserInjects(states, sessionID, Date.now())
  }
  // 被注入闸拦下的时刻（诊断用：连续拦多久 = 宿主侧回合卡了多久）
  const heldInject = new Map<string, number>()
  // R2660b：宿主自己宣布的回合结束时刻（session_v2.time_idle / session.status=idle）。
  // 死回合（completed=0、finish=tool-calls）此前要等 AC_STUCK_TURN_MS（默认 5 分钟）
  // 才放行 —— 用户实报「停止很久后才注入」。有这个权威边界就不必等。
  const hostIdleAt = new Map<string, number>()
  const noteHostIdle = (sid: string, at?: number): void => {
    if (!sid) return
    const ts = Number(at ?? 0) > 0 ? Number(at) : Date.now()
    if (ts <= (hostIdleAt.get(sid) ?? 0)) return
    hostIdleAt.delete(sid)
    hostIdleAt.set(sid, ts)
    if (hostIdleAt.size > 64) {
      const cutoff = Date.now() - 10 * 60_000
      for (const [k, v] of hostIdleAt) if (v < cutoff) hostIdleAt.delete(k)
    }
  }
  const fatalStreak = new Map<string, number>()
  // R2512：按会话的连续错误计数（旧版是全局 streak，任意空闲会话的正常消息
  // 会把它清零 → 失败会话永远停在 1/2）。同一 msg.id 只计一次；健康回合只 reset 自己。
  let errBySession: Record<string, number> = {}
  let errSeen: string[] = []
  const noteErrorStreak = (
    sessionID: string,
    msgID: string,
  ): { streak: number; max: number; added: boolean } => {
    const next = nextSessionErrorStreak(
      { bySession: errBySession, seen: errSeen },
      sessionID,
      `${sessionID}:${msgID}`,
    )
    errBySession = next.bySession
    errSeen = next.seen
    return { streak: next.streak, max: next.max, added: next.added }
  }
  // R2535：恢复会话的尾部 assistant 可能在本次进程启动前就已完成；decided/skipState
  // 都是进程内状态，重启后首次 eval 会重新看到它。只有本进程启动后 created/completed
  // 的回合才算"本轮成功"，否则每轮启动都会凭上一轮旧消息误清零 streak。
  // R2566（运营者最高优先级：200 预检后仍普遍 429）：只看 `time.created`。
  // `time.completed` 可能在恢复/结算时被刷新成启动时刻，旧错误就会伪装成本轮
  // 新错误，把健康出口误判成 200→quota。created 缺失时保守返回 false。
  const messageCompletedThisRun = (m: any): boolean => {
    const t = m?.time ?? {}
    const created = Number(t.created ?? 0)
    return created > 0 && created >= AC_BOOT_AT
  }
  const noteHealthyRound = (sessionID: string, healthyCreatedAt = 0): void => {
    AC_ROUND_HAD_SUCCESS = true
    const first = markRoundHadSuccess()
    // R2536：egress watcher 需要一条**结构化**的健康信号。此前它把
    // `injected round prompt` 当成健康回合，但那只是注入动作，不代表上游可用：
    // 实测 03:24:32 注入后同一 upstream 立即 provider.free-limit，误报了
    // "healthy turn after rotation"。这里只在真实正常回合写日志。
    // R2647：同一轮只记一次，避免每次 eval 重复刷健康信号。
    if (first) void log("info", `auto-continue: healthy turn (session=${sanitizeLog(sessionID)})`)
    // R2814：seed 回合已经成功 => 这个 successor 不再可能是 DOA。立即消费
    // 标记，避免几小时后的正常 429 被 CI 误判成 seed 首回合 429 而拒绝换会话。
    if (clearRolloverSeedForSession(sessionID, healthyCreatedAt)) {
      void log("info", `auto-continue: rollover seed consumed by healthy turn (session=${sanitizeLog(sessionID)})`)
    }
    const next = resetSessionErrorStreak({ bySession: errBySession, seen: errSeen }, sessionID)
    errBySession = next.bySession
    errSeen = next.seen
  }
  // R210：错误停滞墙钟表（见 AC_ERR_STALL_MS 注释）。返回 true = 持续错误已超过阈值。
  const errStallSince = new Map<string, number>()
  const stallExceeded = (sid: string): boolean => {
    const t0 = errStallSince.get(sid)
    if (t0 === undefined) {
      errStallSince.set(sid, Date.now())
      return false
    }
    return Date.now() - t0 >= AC_ERR_STALL_MS
  }
  const coldCompacted = new Set<string>()
  const lastCompactCount = new Map<string, number>()
  const lastCompactAttempt = new Map<string, number>()
  const lastCompactSuccessAt = new Map<string, number>()
  // R-pending：宿主在部分事件里会把"会话生命周期累计 token"报成 input
  // （实测 f339 报 ~24.9M / 窗口 1M = 2490%，tg-bridge 的 ctxUsage 早已 reject 同族值）。
  // 误用累计值判压缩会**强压还有大量 headroom 的会话、清空其上下文** —— 用户视角就是
  // "这个 bot 的自动循环没了"。守卫：单次调用输入不可能超过窗口，超过即累计值，丢弃。
  let ctxLifetimeRejected = 0
  const COMPACT_RETRY_MS = 30 * 60_000
  const COMPACT_SUCCESS_GAP_MS = 5 * 60_000
  // Per-invocation identity (module top-level may be shared across hot-reloads
  // via ESM cache): newest instantiation in this process wins.
  const GAC = globalThis as Record<string, unknown>
  GAC[AC_GEN_KEY] = (typeof GAC[AC_GEN_KEY] === "number" ? (GAC[AC_GEN_KEY] as number) : 0) + 1
  const myGenAc = GAC[AC_GEN_KEY] as number
  claimCtlWriter(myGenAc)
  const myAcId = `ac-p${typeof process !== "undefined" ? process.pid : 0}-g${myGenAc}-${Date.now().toString(36)}`
  // Sessions seen via message.updated (idle events may never arrive; the
  // fallback interval below evaluates these instead of depending on idle).
  const activeSidAt = new Map<string, number>()
  const touchSid = (sid: string): void => {
    if (!sid) return
    activeSidAt.delete(sid)
    activeSidAt.set(sid, Date.now())
    if (activeSidAt.size > 20) {
      const oldest = activeSidAt.keys().next().value
      if (oldest !== undefined) activeSidAt.delete(oldest)
    }
  }

  const log = async (level: "info" | "error", message: string) => {
    try {
      await client.app.log({ body: { service: "auto-continue", level, message } })
    } catch (err) {
      console.error(`[auto-continue] ${level}: ${message} (log failed: ${String(err)})`)
    }
  }

  // R2623 (operator: "前几轮ci429后都没有重启啊"): a this-run quota 429 must
  // reach egress-watch even when the auto loop is stopped (`/stop`). The
  // watcher is what ends the round and relays a fresh run with a new egress;
  // before this, the loop gate returned before the quota log, so a stopped
  // session's 429 was invisible and the run sat idle until a manual restart.
  // Deduplicate by message id: the same error is observed on several ticks.
  const quotaLoggedForMsg = new Set<string>()
  const logQuotaSignal = async (sessionID: string, msg: any, turn: QuotaTurnKind = "synthetic"): Promise<void> => {
    if (!msg?.error) return
    if (!isRateLimitError(errorName(msg), errorText(msg), errorStatus(msg))) return
    const userInitiated = turn === "user"
    const continuation = turn === "continuation"
    const id = String(msg?.id ?? "")
    if (id) {
      if (quotaLoggedForMsg.has(id)) return
      quotaLoggedForMsg.add(id)
      if (quotaLoggedForMsg.size > MAX_TRACKED) {
        const oldest = quotaLoggedForMsg.values().next()
        if (!oldest.done) quotaLoggedForMsg.delete(oldest.value)
      }
    }
    const quotaThisRun = messageCompletedThisRun(msg)
    const quotaMsgAt = Number(msg?.time?.created ?? 0)
    const quotaRetryAfterSec = errorRetryAfterSec(msg)
    // R2675: durable evidence for the CI rollover decision. Only a 429 observed
    // in THIS run counts; restored pre-run errors must not invent a session.
    // R2790: retry_after also becomes the provider-account-level reset gate.
    if (quotaThisRun) recordQuota429Evidence(sessionID, quotaMsgAt, quotaRetryAfterSec, userInitiated)
    const quotaMsgAtIso = quotaMsgAt > 0 ? new Date(quotaMsgAt).toISOString() : "?"
    const quotaCreated = Number(msg?.time?.created ?? 0)
    const quotaCompleted = Number(msg?.time?.completed ?? 0)
    // R2566: `src=auto-continue` is the watcher's positive marker. Only
    // this line may trigger the 200->quota stop; generic eval/tg-bridge
    // lines that merely mention the error name are not evidence.
    await log(
      "info",
      `auto-continue: rate-limit/quota error (src=auto-continue, session=${sanitizeLog(sessionID)}, this_run=${quotaThisRun}, user_initiated=${userInitiated ? "true" : "false"}, continuation=${continuation ? "true" : "false"}, turn=${turn}, msg_at=${quotaMsgAtIso}, msg_created=${quotaCreated || "?"}, msg_completed=${quotaCompleted || "?"}, boot_at=${new Date(AC_BOOT_AT).toISOString()}, retry_after_s=${quotaRetryAfterSec || "?"}, name=${sanitizeLog(errorName(msg))}, status=${errorStatus(msg)}, text=${sanitizeLog(errorText(msg)).slice(0, 240)}, ${exitProxySummary()}) -> ${quotaThisRun ? `counted toward the ${ERR_CONSECUTIVE_LIMIT}-consecutive-error limit` : "restored pre-run error; watcher must ignore"}`,
    )
  }

  const markerApplied = new Map<string, string>()
  // R1916：三态标记。state: "running" → [LOOP]；"stopped" → [LOOP:OFF]；"clear" → 剥标记。
  const applyMarker = async (sessionID: string, state: "running" | "stopped" | "clear"): Promise<void> => {
    // R1832：换代护栏（唯一写入入口统一拦截）。applyMarker 由多个 caller 异步触发
    // （loopTick/boot），而 loopTick 的 AC_GEN_KEY 判定在其回调**末尾**
    // （末尾判定是为保留最后一次 superseded 日志）：被换代的实例在让出前，
    // 仍会用**最长 2s 缓存**的 currentLoopTarget() 应用一次标题标记，可能给旧会话临时
    // 挂上 [LOOP]（新实例一般 5s 内自愈，但这本可避免）。在此统一拦一道，任何 caller
    // 的时序都不会再让陈旧实例写标记。判断只拦**过期**实例，当前实例恒等于 myGenAc。
    if ((globalThis as Record<string, unknown>)[AC_GEN_KEY] !== myGenAc) return
    if (!isSessionID(sessionID)) return
    const sessionAny = (client as any)?.session
    const get = sessionAny?.get
    const update = sessionAny?.update
    if (typeof get !== "function" || typeof update !== "function") return
    let title = ""
    try {
      const got = await get.call(sessionAny, { path: { id: sessionID } })
      const session = got?.data ?? got
      title = String(session?.title ?? "")
    } catch {
      return
    }
    const base = stripLoopTitle(title)
    const mark = state === "running" ? LOOP_TITLE_MARK_ON : state === "stopped" ? LOOP_TITLE_MARK_OFF : ""
    const desired = mark ? `${base}${base ? " " : ""}${mark}` : base
    const visible = state === "running" || state === "stopped"
    if (desired === title) {
      markerApplied.set(sessionID, desired)
      if (visible && !readMarkedSids().includes(sessionID)) writeMarkedSids([...readMarkedSids(), sessionID])
      return
    }
    if (markerApplied.get(sessionID) === desired) return
    try {
      await update.call(sessionAny, { path: { id: sessionID }, body: { title: desired || "未命名会话" } })
      markerApplied.set(sessionID, desired)
      const marked = readMarkedSids().filter((x) => x !== sessionID)
      writeMarkedSids(visible ? [...marked, sessionID] : marked)
      await log(
        "info",
        `loop title marker ${state} (session=${sanitizeLog(sessionID).slice(0, 12)}, title=${sanitizeLog(desired).slice(0, 60)})`,
      )
    } catch (err) {
      await log("error", `loop title marker failed (session=${sanitizeLog(sessionID).slice(0, 12)}): ${sanitizeLog(err).slice(0, 120)}`)
    }
  }

  const syncLoopMarker = async (sessionID = currentLoopTarget()): Promise<void> => {
    if (!sessionID || !isSessionID(sessionID)) return
    // R1916：闸门关 → [LOOP:OFF]（显式「循环停止」），闸门开 → [LOOP]。
    // R2680：`/loop off`（loop-sessions-off）也算停止 —— 否则标题 [LOOP] 与
    // auto-continue 的 `loop=no -> skip` / 状态卡的「未开启自动循环」互相矛盾。
    let state: "running" | "stopped" | "clear" = "running"
    try {
      state = loopTitleState(loopGateStopped(readLoopCtl(), sessionID), isLoopOffNow(sessionID))
    } catch {
      state = "running"
    }
    await applyMarker(sessionID, state)
  }

  let markerLastSig = ""
  // R1916d：sig 只含 sid:state，察觉不了「标题标记被宿主侧剥掉」这类漂移。每
  // 60s 对全部目标强制重跑一次 syncLoopMarker：applyMarker 内部先 GET 实时标题——
  // 标记已就位则 desired===title 早退（仅 GET、零 PATCH/零日志），被剥则自动补挂。
  // R2789：节流必须按**时间**（事件机下 tick 不再是 5s 一拍）。
  let markerSelfHealAt = 0
  const MARKER_SELF_HEAL_MS = 60_000
  const refreshLoopMarkerIfChanged = (): void => {
    // R1916：必须遍历**全部**循环目标，而非只第一个。三种 bot（primary/bot2/bot3）
    // 共享同一 auto-continue 实例（EXTRA_TARGET_PATHS 来自 tg-bots.json 的三个状态文件），
    // 若只对 currentLoopTarget()[0] 写标题，bot2/bot3 的 front 会话标题永远没有
    // 循环状态标记（实测：R1916 三态上线后 bot2/bot3 仍是裸标题）。
    const tgts = currentLoopTargets()
    const sig = tgts
      .map((t) => {
        let st = "running"
        try {
          st = loopTitleState(loopGateStopped(readLoopCtl(), t), isLoopOffNow(t))
        } catch {
          /* keep default */
        }
        return `${t}:${st}`
      })
      .join("|")
    // 目标切换/停止后，凡**不是任何目标**的被标记会话都要清掉 [LOOP]/[LOOP:OFF]，
    // 否则会留下“仍在循环”的假标记。集合来自落盘状态，热重载后照样生效。
    // 放在 sig 判断之前：落盘状态可能在本进程启动后才被补写（例如修复残留），
    // 此时 sig 未变，但残留标记仍需清掉。清理后集合即收敛为空，不会反复调 API。
    for (const sid of readMarkedSids()) {
      if (tgts.includes(sid)) continue
      void applyMarker(sid, "clear")
    }
    if (sig === markerLastSig) {
      // R1916d：sig 未变但标题可能被剥标记 → 定期强制自愈检查（见上注释）。
      if (Date.now() - markerSelfHealAt < MARKER_SELF_HEAL_MS) return
      markerSelfHealAt = Date.now()
      for (const t of tgts) void syncLoopMarker(t)
      return
    }
    markerLastSig = sig
    for (const t of tgts) void syncLoopMarker(t)
  }
  setTimeout(() => {
    refreshLoopMarkerIfChanged()
  }, 1000)
  // R2789：标题标记不再 5s 轮询。loop 状态变化、状态文件落盘、DB 事件都会触发
  // loopTick（内部调 refreshLoopMarkerIfChanged）；没有变化时不需要任何定时器。

  const track = (key: string) => {
    if (decided.size > MAX_TRACKED) {
      const oldest = decided.values().next().value
      if (oldest !== undefined) decided.delete(oldest)
    }
    if (pending.size > 32) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
  }

  const settle = (msg: AssistantMessage) => {
    decided.add(msg.id)
    pending.delete(msg.id)
    track(msg.id)
  }

  // 压缩通道失败不是「宿主永久限制」。2026-11-16 实测本宿主 v2.3.0 原生 compact 可用，
  // 旧代码却把一次失败写成进程级闩锁，随后 ctx 卡片一直说“本桥不能主动压缩”。
  // 现在失败只做**节流日志**，退避后照常重试；/migrate 只是兜底，不是唯一出路。
  const compactFailLoggedAt = new Map<string, number>()
  const COMPACT_FAIL_LOG_MS = 30 * 60_000
  const isCompactChannelMissing = (e: unknown): boolean =>
    /no ctx\.session\.compact|missing.*compact|local API fallback is cooling/i.test(
      String((e as any)?.message ?? e),
    )
  const logCompactFailure = async (sessionID: string, why: string): Promise<void> => {
    const now = Date.now()
    if (now - (compactFailLoggedAt.get(sessionID) ?? 0) < COMPACT_FAIL_LOG_MS) return
    compactFailLoggedAt.set(sessionID, now)
    if (compactFailLoggedAt.size > 200) {
      const first = compactFailLoggedAt.keys().next()
      if (!first.done) compactFailLoggedAt.delete(first.value)
    }
    await log(
      "info",
      `auto-continue: compact 尝试失败（不是永久限制；退避后自动重试，/migrate 可兜底）` +
        `(session=${sanitizeLog(sessionID)}): ${sanitizeLog(why).slice(0, 140)}`,
    )
  }
  // R724：压缩成功 → 共享总线（globalThis `__oc_compaction_events__`），供 tg-bridge 消费
  // 补发「已压缩」卡。为什么要总线：宿主事件路每事件只投一个 handler（非拥有者收到
  // 就丢）、API 路时间戳可能滞留、ctx 骤降路依赖回填样本 —— R722 实证三路在自动压缩时全漏。
  // compactNow 成功点是**唯一确知压缩发生**的位置。消费侧做会话归属判据 + 180s/会话去重
  // （与其它三路互斥）；事件带 TTL，重启积压不补发。best-effort：失败不阻断压缩主链。
  const publishCompactionEvent = (sessionID: string, reason: string): void => {
    try {
      const G = globalThis as Record<string, unknown>
      const arr: Array<Record<string, unknown>> = Array.isArray(G.__oc_compaction_events__)
        ? (G.__oc_compaction_events__ as Array<Record<string, unknown>>)
        : []
      const at = Date.now()
      arr.push({ sid: sessionID, at, reason: String(reason).slice(0, 80) })
      while (arr.length > 20) arr.shift()
      G.__oc_compaction_events__ = arr
      // R2789：同进程即时通知桥；总线数组仍保留给跨实例/诊断读取。
      emit("compaction:done", { sessionID, at, reason: String(reason).slice(0, 80) })
    } catch {
      /* best-effort */
    }
  }
  const compactNow = async (sessionID: string, reason: string): Promise<boolean> => {
    const base = (client as unknown as { _client?: { post?: (o: any) => Promise<unknown> } })._client
    let lastErr: unknown = null
    // 1) 宿主自带认证的内部通道（_client）。实测 2026-11-16 14:03:31 成功。
    if (base?.post) {
      try {
        await base.post({ url: `/api/session/${encodeURIComponent(sessionID)}/compact` })
        await log("info", `auto-continue: compacted session=${sanitizeLog(sessionID)} (${reason})`)
        publishCompactionEvent(sessionID, reason)
        return true
      } catch (err) {
        lastErr = err
      }
    }
    // 2) compat 层：native ctx.session.compact → slash command → 带凭据的本地 HTTP。
    const compatCompact = (client as unknown as { session?: { compact?: (o: any) => Promise<unknown> } }).session?.compact
    if (typeof compatCompact === "function") {
      try {
        await compatCompact({ path: { id: sessionID } })
        await log("info", `auto-continue: compacted session=${sanitizeLog(sessionID)} (${reason})`)
        publishCompactionEvent(sessionID, reason)
        return true
      } catch (err) {
        lastErr = err
      }
    }
    // 不是永久限制：本轮失败只记一次，退避窗口过后会重新尝试。
    if (lastErr && !isCompactChannelMissing(lastErr)) {
      await log("error", `auto-continue: compact failed (session=${sanitizeLog(sessionID)}): ${sanitizeLog(lastErr)}`)
    } else {
      await logCompactFailure(sessionID, sanitizeLog(lastErr ?? "no compact channel").slice(0, 140))
    }
    return false
  }

  const maybeCompact = async (sessionID: string, usage: number, assistantCount: number): Promise<void> => {
    if (CONTEXT_WINDOW <= 0) return
    const nowMs = Date.now()
    const ownerPath = statePathForSession(sessionID)
    let pc = prefsCache.get(ownerPath)
    if (!pc || nowMs - pc.ts > 10_000) {
      pc = { ts: nowMs, ...readCompactPrefsFrom(ownerPath) }
      prefsCache.set(ownerPath, pc)
    }
    if (!pc.auto) return
    const TH = pc.threshold
    const last = lastCompactCount.get(sessionID) ?? 0
    // 窗口口径必须是「最近一次请求的窗口占用」，不是生命周期累计。
    // session_v2.tokens_* 在当前宿主是累计值（实测 8.9M input / 245M cache.read），
    // 拿它比窗口会永远判超限 → 每 30 分钟撞一次注定失败的压缩。旧代码在事件值
    // 缺失时回退 ledger，正是假超限的来源；现在只认事件/消息的五字段样本。
    let u = Number(usage)
    let uSrc = "event"
    // R2607（用户指令）：分母 = **该会话模型的真实窗口**（tg-bridge 抓取 → globalThis/文件共享）；
    // 拿不到表时才回退 1M（旧行为）。此前一律 1M：200k 模型真实 70%（140k）只算 13.4%，
    // 自动压缩几乎永不触发。readSessionUsage 只用来取 modelID/providerID（其 tokens_* 是累计值）。
    let dbRow: { input: number; output: number; reasoning: number; modelID: string; providerID: string } | null = null
    try {
      dbRow = await readSessionUsage(sessionID)
    } catch {
      /* keep event value */
    }
    const realWin = dbRow ? resolveContextWindow(dbRow.modelID, dbRow.providerID) : null
    const win = realWin ?? CONTEXT_WINDOW
    // 口径守卫：单次请求的窗口占用不可能超过模型窗口；超过即判为宿主把累计值
    // 混进来了。丢弃样本后 u=0，下面的消息数策略仍会生效 —— 不再回退 ledger，
    // 避免把累计值当窗口再判一次。
    if (!Number.isFinite(u) || u <= 0) {
      u = 0
      uSrc = "none"
    } else if (u > win) {
      u = 0
      uSrc = "rejected"
      ctxLifetimeRejected++
      if (ctxLifetimeRejected <= 5 || ctxLifetimeRejected % 50 === 0) {
        // R1736：用 info 而非 error。**这是一个已被成功处理的正常动作**，不是失败：
        // 守卫识别出宿主把生命周期累计值当窗口值丢了，随后交给消息数策略继续判定。
        // 记成 error 会污染"error 级日志数 = 0"这个健康判据 —— R1736 就因为它一度
        // 看到 10 条 error 而白查一轮（真问题只有 0 条）。日志文本保持可 grep。
        await log(
          "info",
          `auto-continue: ctx usage rejected (lifetime counter, not window): sid=${sanitizeLog(sessionID).slice(0, 12)} u=${Math.round(usage)} win=${win}${realWin ? "" : " (fallback)"} (rejected x${ctxLifetimeRejected})`
        )
      }
    }
    if (u > 0 && u / win >= TH) {
      const lastTry = lastCompactAttempt.get(sessionID) ?? 0
      const lastOk = lastCompactSuccessAt.get(sessionID) ?? 0
      // 30 分钟退避只约束失败尝试；成功后只保留 5 分钟防抖。
      // 否则一次成功的 73%→38% 会让会话在随后 30 分钟内即使重新涨到 86% 也不能再压缩。
      if (Date.now() - lastTry < COMPACT_RETRY_MS) return
      if (Date.now() - lastOk < COMPACT_SUCCESS_GAP_MS) return
      lastCompactAttempt.set(sessionID, Date.now())
      lastCompactCount.set(sessionID, assistantCount)
      const usagePct = Math.round((u / win) * 100)
      if (await compactNow(sessionID, `ctx=${usagePct}% >= ${Math.round(TH * 100)}%`)) {
        lastCompactSuccessAt.set(sessionID, Date.now())
        lastCompactAttempt.delete(sessionID)
        resetSessionTokens(sessionID)
      }
      return
    }
    if (!coldCompacted.has(sessionID) && assistantCount >= STALL_SESSION_MSGS) {
      coldCompacted.add(sessionID)
      lastCompactCount.set(sessionID, assistantCount)
      if (await compactNow(sessionID, `msgs=${assistantCount} >= ${STALL_SESSION_MSGS} (cold start, no token info)`)) resetSessionTokens(sessionID)
      return
    }
    if (assistantCount - last >= COMPACT_EVERY) {
      lastCompactCount.set(sessionID, assistantCount)
      if (await compactNow(
        sessionID,
        `msgs=${assistantCount} delta=${assistantCount - last} >= ${COMPACT_EVERY} (msg-count policy)`
      )) resetSessionTokens(sessionID)
      return
    }
    const nxtMsg = last === 0 ? STALL_SESSION_MSGS : last + COMPACT_EVERY
    const uTxt =
      Number.isFinite(u) && u > 0 ? ((u / win) * 100 < 1 ? "<1%" : `${Math.min(100, Math.round((u / win) * 100))}%`) : "unknown"
    await log(
      "info",
      `auto-continue: eval session=${sanitizeLog(sessionID)} msgs=${assistantCount} ctx=${uTxt} win=${win}${realWin ? "" : "(fb)"} src=${uSrc} (next compact ~${nxtMsg} msgs, no compact)`
    )
  }

  // R2607：usage 取值兜底链与 ctxTotal 口径对齐（避免 `msg.tokens.input` 单值口径
  // 把界面 21% 报成 <1% 的老问题）；usage 表 → 消息 tokens 全量 → step tokens 全量 → 0。
  const usageOf = (sid: string, msg: any): number => {
    const u = usage.get(sid)
    if (typeof u === "number" && u > 0) return u
    const s = tokenSumOf(msg?.tokens)
    if (s > 0) return s
    // 第三兜底：step.ended 的最新五字段样本（含缓存前缀），不是累计账本。
    return sessionTokens(sid).total
  }

  const backoffMs = (attempts: number): number => {
    const base = RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)] ?? RETRY_MS[RETRY_MS.length - 1]
    return base * Math.min(attempts, 16)
  }

const CLAIM_PATH = "/tmp/opencode/round-claims.json"
  const claimInject = (sessionID: string, msgID: string): boolean => {
    // 跨代去重：热重载并存期各代实例内存 decided 互不可见，文件认领是唯一共同语言（同步读写，无 await 间隙）。
    try {
      let j: any = {}
      try {
        j = JSON.parse(readFileSync(CLAIM_PATH, "utf8"))
      } catch {
        j = {}
      }
      if (typeof j !== "object" || j === null || Array.isArray(j)) j = {}
      const key = `${sessionID}:${msgID}`
      if (j[key] === true) return false
      j[key] = true
      const keys = Object.keys(j)
      if (keys.length > 300) {
        for (const k of keys.slice(0, keys.length - 300)) delete j[k]
      }
      // R1849：round-claims.json 跨代/跨进程共享；裸写 O_TRUNC 窗口里的半截会被
      // 并发读当作"无认领" → 同一轮可能被重复注入。atomicWriteJson 保证读者见完整版。
      atomicWriteJson(CLAIM_PATH, j)
      return true
    } catch {
      return true // 文件不可用时不挡路（内存 decided 仍在）
    }
  }
  const unclaimInject = (sessionID: string, msgID: string): void => {
    try {
      const j = JSON.parse(readFileSync(CLAIM_PATH, "utf8")) as any
      if (j && typeof j === "object") {
        delete j[`${sessionID}:${msgID}`]
        atomicWriteJson(CLAIM_PATH, j)
      }
    } catch {
      /* best-effort */
    }
  }
  // R2232：循环注入的「消息级落定窗口」。宿主一步 completed 后 ~20ms 就会落盘下一步
  // 继续跑（多步工具循环里很常见），要求 `completed` 距今 ≥ 此值才注入，给"下一步即将
  // 落盘"留时间。实测那次碰撞是 20ms，4s 有充足余量（宁可晚 4s 也不插进活着的回合）。
  const ROUND_SETTLE_MS = Number(process.env.AC_ROUND_SETTLE_MS ?? 4_000)
  // 落定窗口到点后的重评。若此刻下一步已在生成中，会有 message.updated 触发复查；
  // 但若回合**真的结束**了，就不会再有事件 —— 只靠 60s 间隔太慢。每会话至多一个在途定时器。
  const settleRetry = new Map<string, ReturnType<typeof setTimeout>>()
  const scheduleSettleReeval = (sid: string): void => {
    if (settleRetry.has(sid)) return
    const h = setTimeout(() => {
      settleRetry.delete(sid)
      evaluateQueued(sid)
    }, ROUND_SETTLE_MS + 500)
    if (typeof (h as any)?.unref === "function") (h as any).unref()
    settleRetry.set(sid, h)
  }
  // R2660（运营者：「有时候还在输出就会注入 / 停止很久后才注入」）：
  // 旧链路只有 session.idle（宿主实测不发）和 60s tick 会触发评估 → 回合结束后
  // 最坏要等约 64 秒才注入。现在用「终态 message.updated / session.status=idle /
  // session_v2.time_idle 跃迁」三条轻量信号做 300ms 去抖的快速评估；60s tick 仍保留
  // 作为事件全部丢失时的兜底。去抖只合并同一会话的连发，不会延迟超过 300ms。
  const FAST_EVAL_DEBOUNCE_MS = 300
  const fastEvalTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const scheduleFastEval = (sid: string): void => {
    if (fastEvalTimers.has(sid)) return
    const h = setTimeout(() => {
      fastEvalTimers.delete(sid)
      evaluateQueued(sid)
    }, FAST_EVAL_DEBOUNCE_MS)
    if (typeof (h as any)?.unref === "function") (h as any).unref()
    fastEvalTimers.set(sid, h)
  }
  // R2660b：宿主刚宣布 idle 的前 1s 是刻意的落定窗（idleVerdict 持有）。若快速评估
  // 恰好落在窗内，之后不会再有 idle 跃迁（同一时间戳）→ 就要白等 60s tick。
  // 到点后补一拍，让 host-idle 死回合在 ~1.5s 内真正放行。
  const hostIdleRetry = new Map<string, ReturnType<typeof setTimeout>>()
  const scheduleAfterHostIdle = (sid: string, ms: number): void => {
    if (hostIdleRetry.has(sid)) return
    const h = setTimeout(() => {
      hostIdleRetry.delete(sid)
      evaluateQueued(sid)
    }, Math.max(200, ms))
    if (typeof (h as any)?.unref === "function") (h as any).unref()
    hostIdleRetry.set(sid, h)
  }
  // 注入闸的唯一入口。返回 false 时**不做任何状态变更**（不 settle、不计数），
  // 这样这一轮仍然算"未处理"：宿主把回合标记 completed 后会有新事件再次评估。
  // ⚠️ 这里的 session id **必须打全**，不能 `slice(0,12)`：相邻的
  // `injected round prompt (session=<完整 id>)` 与 `eval session=<完整 id>` 都是全的。
  // R1020 实测：只有这一行是 12 位 → 统计脚本按等值连接时，会话级数据全成假数
  // （每个会话都显示"100% 拦截 / 0% 注入"）。**同一份信息在相邻日志行里两种写法，
  // 迟早让人连不上** —— 与其在分析脚本里做前缀匹配，不如把日志本身统一。
  // R213 END-ROUND-CI 真正落地（2026-10-19 03:45 实证）：插件跑在 `opencode serve` 子进程里，
  // 旧实现 `process.exit(0)` 只杀死 serve —— 客户端 `opencode --standalone` 与 `timeout` 包裹层
  // 仍然活着 ⇒ CI 步骤永不收尾、relay 不触发，运营者只能人工取消（观感「并没有重启，仍然空跑」）。
  // 新实现：先给**其他** opencode 进程（客户端）发 SIGKILL ⇒ 外层 `timeout` 以 137 返回，
  // 而 iterate.yml 把 124/137 视为「时间预算到期=成功」⇒ 步骤 success ⇒ relay 自动重启；
  // 再自我 exit(0)。非生产（无 TG_BRIDGE_FORCE_SERVE=1）保持旧行为，绝不误杀。
  const endRunNow = (reason: string): void => {
    try {
      const dir = String(process.env.RUNNER_TEMP ?? "")
      if (dir) {
        writeFileSync(
          `${dir}/round-end.json`,
          JSON.stringify({ reason: reason.slice(0, 300), success: AC_ROUND_HAD_SUCCESS, at: new Date().toISOString() }),
        )
      }
    } catch {
      /* best-effort marker */
    }
    if (String(process.env.TG_BRIDGE_FORCE_SERVE ?? "") === "1") {
      killOtherOpencodeProcesses()
    }
    try {
      setTimeout(() => process.exit(0), 450)
    } catch {
      process.exit(0)
    }
  }
  // R2806：quota 的 in-run recover 删除后，egress-watch 是唯一的正常结束路径。
  // 宽限期覆盖 probe（≤90s）+ drain（≤60s），到点仍未看到 stop / kept-round /
  // 健康回合才由插件兜底结束本轮；不会在 429 后立刻再打一次。
  const QUOTA_RESTART_GRACE_MS = (() => {
    const v = Number(process.env.AC_QUOTA_RESTART_GRACE_MS ?? "180000")
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 180_000
  })()
  const quotaRestartTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const armQuotaRestartFallback = (sid: string, msg: AssistantMessage, seenAt: number): void => {
    const prev = quotaRestartTimers.get(sid)
    if (prev) clearTimeout(prev)
    const startedAt = Date.now()
    const dir = String(process.env.EGRESS_STATE_DIR ?? "").trim()
    const probeMeta = dir ? `${dir}/quota-probe.meta` : ""
    const h = setTimeout(() => {
      quotaRestartTimers.delete(sid)
      const kept = probeMeta ? quotaProbeKeptRound(probeMeta, seenAt) : false
      const action = quotaRestartFallbackAction({
        elapsedMs: Date.now() - startedAt,
        graceMs: QUOTA_RESTART_GRACE_MS,
        stopRequested: egressStopRequested(),
        probeKeptRound: kept,
        roundHadSuccess: AC_ROUND_HAD_SUCCESS,
      })
      if (action !== "end") {
        void log(
          "info",
          `auto-continue: quota restart fallback skipped (session=${sanitizeLog(sid)}, stop=${egressStopRequested() ? "yes" : "no"}, probeKeptRound=${kept ? "yes" : "no"}, roundSuccess=${AC_ROUND_HAD_SUCCESS ? "yes" : "no"})`,
        )
        return
      }
      void log(
        "warn",
        `auto-continue: quota 429 -> END-ROUND-CI fallback after ${Math.round(QUOTA_RESTART_GRACE_MS / 1000)}s (session=${sanitizeLog(sid)}, msg=${sanitizeLog(String((msg as any)?.id ?? ""))}; egress-watch neither stopped nor kept the round; workflow relay will start a fresh run)`,
      )
      if (String(process.env.TG_BRIDGE_FORCE_SERVE ?? "") === "1") {
        endRunNow(`quota 429; egress-watch neither stopped nor kept the round within ${Math.round(QUOTA_RESTART_GRACE_MS / 1000)}s`)
      }
    }, QUOTA_RESTART_GRACE_MS)
    if (typeof (h as any)?.unref === "function") (h as any).unref()
    quotaRestartTimers.set(sid, h)
  }
  const injectAllowed = async (sid: string, m: any, tag: string): Promise<boolean> => {
    const t = (m as any)?.time ?? {}
    // 重启孤儿（创建早于本进程启动 + 未完成）：生成者已死，不可能是活回合。
    // 这里**跳过两道空闲闸**：回源看到的 completed 永远是 0（没人会补写），
    // 会被 idleVerdict 判成"回合未结束"，而这正是 2026-10-18 08:12 重启后
    // 12 分钟零注入的根因。
    if (preBootOrphan({ completed: Number(t.completed ?? 0), created: Number(t.created ?? 0), bootAt: HOST_BOOT_AT })) {
      if (!orphanLogged.has(String(m?.id ?? ""))) {
        orphanLogged.add(String(m?.id ?? ""))
        await log(
          "info",
          `auto-continue: orphan turn escaped idle gates (${tag}, session=${sanitizeLog(sid)}, msg=${String(m?.id ?? "").slice(0, 20)}, created=${new Date(Number(t.created)).toISOString()} < host boot ${new Date(HOST_BOOT_AT).toISOString()})`,
        )
      }
      return true
    }
    // R704：preboot user 尾条（后台完成通知等）后没有 assistant，生成者已死；
    // 它不是活回合，必须跳过 idle 闸，否则 bot4 会一直停在 user-active note。
    if (preBootUserTail.has(sid)) {
      if (!orphanLogged.has(`usertail:${sid}`)) {
        orphanLogged.add(`usertail:${sid}`)
        await log(
          "info",
          `auto-continue: preboot user-tail escaped idle gates (${tag}, session=${sanitizeLog(sid)}, tail=${String(preBootUserTail.get(sid) ?? "").slice(0, 20)})`,
        )
      }
      return true
    }
    const hold = async (why: string): Promise<boolean> => {
      heldInject.set(sid, Date.now())
      await log(
        "info",
        `auto-continue: hold inject (${tag}, session=${sanitizeLog(sid)}, msg=${String(m?.id ?? "").slice(0, 20)}, ` +
          `${why}) —— 回合未结束，不往活着的回合里注入（等 completed 事件再来判）`,
      )
      return false
    }
    const v = injectGateVerdict(Number(t.completed ?? 0), Number(t.updated ?? t.created ?? 0), Date.now())
    if (!v.go) return hold(v.why)
    // R2232：`completed > 0` 只代表**这一步**完成，**不代表回合结束**。宿主会在一步
    // completed 后 ~20ms 落盘下一步继续跑；此刻注入会把 ROUND_PROMPT 插进正在跑的回合
    // （用户实报「循环提示词在没有输出完成时注入」；DB 实证见 _v2compat.idleVerdict 注释）。
    // 回源确认整会话确实空闲，判据与泵的 turnActuallyIdle 共用 idleVerdict（防两侧漂移）。
    try {
      const res = await withTimeout(client.session.messages({ path: { id: sid } }), "session.messages")
      const rows = res?.data ?? []
      if (Array.isArray(rows)) sortRowsByCreatedTime(rows) // R208：序归一化（seq 跨进程重计，行序 ≠ 时序）
      const hid = hostIdleAt.get(sid) ?? 0
      // R2810（运营者：「🩹 恢复…容易导致再次429修复了吗」）：R2806 只压掉了
      // auto-continue 的 **recover** 注入；循环自己的 **round** 注入仍把
      // `finish=error` 当回合结束，429 后 0.1–0.2s 又发一条「继续」再撞 429
      // （23:17:22 / 23:29:33 bot5 实证）。round 一律要求正常 stop；recover
      // 保持不要求（它要恢复的就是错误尾条）。只在 egress-watch 监管本轮时
      // 生效——本地/TUI 没有 relay 出口，强行扣住会把循环永久停死。
      const iv = idleVerdict({
        rows,
        now: Date.now(),
        settleMs: ROUND_SETTLE_MS,
        hostIdleAt: hid,
        requireNormalEnd: egressWatchActive() && tag.startsWith("round"),
      })
      if (!iv.idle) {
        // 宿主 idle 的 1s 落定窗内先持有，到点补一拍（否则同时间戳不会再触发评估）。
        const hostIdleAge = hid > 0 ? Date.now() - hid : -1
        if (hostIdleAge >= 0 && hostIdleAge < 1_000) {
          scheduleAfterHostIdle(sid, 1_000 - hostIdleAge + 250)
        } else if (iv.why.startsWith("settling-")) {
          // 仅"落定窗口未到"需要补一拍重评（已在生成中会有 message.updated 来复查）。
          scheduleSettleReeval(sid)
        }
        return hold(`idle=${iv.why}`)
      }
    } catch (err) {
      // 回源失败：保守不注入 —— 客户端故障时提前注入会插进正在跑的回合。
      heldInject.set(sid, Date.now())
      await log(
        "info",
        `auto-continue: hold inject (${tag}, session=${sanitizeLog(sid)}) —— 空闲复核查询失败，保守不注入: ${sanitizeLog(err).slice(0, 100)}`,
      )
      return false
    }
    return true
  }

  const coalescedRecoveryAt = new Map<string, number>()
  const coalesceFailedRecovery = async (sessionID: string): Promise<void> => {
    const sdk = client.session as any
    if (!sdk?.revert?.stage || !sdk?.revert?.commit) return
    try {
      const res = await withTimeout(client.session.messages({ path: { id: sessionID } }), "session.messages(coalesce)")
      const rows = (res as any)?.data
      if (!Array.isArray(rows)) return
      sortRowsByCreatedTime(rows)
      const target = revertableSyntheticPrompt(rows)
      if (!target) return
      const last = coalescedRecoveryAt.get(sessionID) ?? 0
      if (Date.now() - last < 30_000) return
      coalescedRecoveryAt.set(sessionID, Date.now())
      const stage = async (): Promise<void> => {
        try {
          await withTimeout(sdk.revert.stage({ path: { id: sessionID }, body: { messageID: target, files: false } }), "session.revert.stage")
        } catch {
          await withTimeout(sdk.revert.stage({ params: { sessionID }, payload: { messageID: target, files: false } }), "session.revert.stage(v2)")
        }
      }
      const commit = async (): Promise<void> => {
        try {
          await withTimeout(sdk.revert.commit({ path: { id: sessionID } }), "session.revert.commit")
        } catch {
          await withTimeout(sdk.revert.commit({ params: { sessionID } }), "session.revert.commit(v2)")
        }
      }
      await stage()
      await commit()
      await log("info", `auto-continue: recover coalesced (session=${sanitizeLog(sessionID)}, reverted failed auto-injection at msg=${sanitizeLog(target)})`)
    } catch (err) {
      try {
        await sdk.revert.clear({ path: { id: sessionID } })
      } catch {
        try {
          await sdk.revert.clear({ params: { sessionID } })
        } catch {
          /* best-effort */
        }
      }
      await log("warn", `auto-continue: recover coalesce skipped (session=${sanitizeLog(sessionID)}): ${sanitizeLog(err).slice(0, 160)}`)
    }
  }

  // R2826：换会话进行中（请求/认领/remap 任一存在）时拒绝向旧会话注入。
  // 按会话节流，避免每 5s 评估刷一行日志。
  const rolloverHoldLoggedAt = new Map<string, number>()
  const holdRollover = async (sid: string, tag: string): Promise<"deferred"> => {
    const last = rolloverHoldLoggedAt.get(sid) ?? 0
    if (Date.now() - last > 60_000) {
      rolloverHoldLoggedAt.set(sid, Date.now())
      await log(
        "info",
        `auto-continue: 429 rollover pending; session=${sanitizeLog(sid).slice(0, 12)} -> no inject (${tag})`,
      )
    }
    return "deferred"
  }

  const inject = async (
    sessionID: string,
    msg: AssistantMessage,
    text: string,
    kind: "round" | "recover"
  ): Promise<"ok" | "backoff" | "duplicate" | "stopped" | "deferred" | "quota-exclusive"> => {
    // R2806：egress-watch 已经判定本轮要结束（stop 标记已落盘），drain 期间不再
    // 注入 recover。否则恢复提示会和即将到来的 TERM 抢跑，既浪费一次额度，也
    // 可能在进程死亡时留下半截回合。下一 run 的 boot 尾恢复会接住。
    if (kind === "recover" && egressStopRequested()) {
      await log("info", `auto-continue: recover-inject suppressed (egress stop marker present; round is ending, session=${sanitizeLog(sessionID)})`)
      return "stopped"
    }
    // R2826：旧会话正在被 429 换会话替换，绝不能再续跑。检查放在所有认领之前。
    if (rolloverPendingFor(sessionID)) return holdRollover(sessionID, `${kind}:pre-claim`)
    // 评估与实际 promptAsync 之间仍可能发生 ESC/主动停止；发送前再过一道总闸。
    // R1724：按会话判定（全局闸 + 该 sid 命中的单 Bot 闸）。
    if (loopGateStopped(readLoopCtl(), sessionID)) {
      await log("info", `auto-continue: ${kind}-inject suppressed before claim (session=${sanitizeLog(sessionID)})`)
      return "stopped"
    }
    if (kind === "recover") await coalesceFailedRecovery(sessionID)
    // 用户消息优先：Telegram 注入队列里还有待注入的用户消息时，本轮不抢跑。
    // 旧行为直连 promptAsync 绕过 pinQueue，导致循环轮次插到用户消息前面，
    // 用户消息反复延后（“注入时机不对 / 队列里有过早的消息”）。
    const pf = primaryFront()
    if (pf && pf === sessionID) {
      const lastShared = sharedTargetLogAt.get(sessionID) ?? 0
      if (Date.now() - lastShared > 10 * 60_000) {
        sharedTargetLogAt.set(sessionID, Date.now())
        await log("info", `inject skipped (scope=${AC_SCOPE}): target is also the primary bot's target (${sanitizeLog(sessionID).slice(0, 12)})`)
      }
      return "deferred"
    }
    const waiting = pendingUserInjects(sessionID)
    if (waiting > 0) {
      const last = deferLoggedAt.get(sessionID) ?? 0
      if (Date.now() - last > 60_000) {
        deferLoggedAt.set(sessionID, Date.now())
        await log(
          "info",
          `auto-continue: ${kind}-inject deferred (${waiting} user message(s) queued in tg; user first)`
        )
      }
      return "deferred"
    }
    // R2788：回合已结束后，若已经有“回合结束注入”的消息（用户消息/换会话/CI 恢复/
    // 循环自己的提示），下一轮由它自然驱动；此时再注入 ROUND_PROMPT 就是两条叠在
    // 同一个回合间隙里。只拦 round —— recover 有自己的 R2781 首应答复核。
    if (kind === "round") {
      try {
        const res = await withTimeout(client.session.messages({ path: { id: sessionID } }), "session.messages(turn-end gate)")
        const rows = Array.isArray(res?.data) ? res.data : []
        sortRowsByCreatedTime(rows)
        // R2838：pre-boot 尾条只看宿主进程启动时刻；插件热重载不能把本进程早先
        // 合法落盘的回合结束注入当成 pre-boot 忽略（否则会重复叠一条 ROUND_PROMPT）。
        const tail = turnEndInjectionAfterAssistant(rows, msg.id, HOST_BOOT_AT)
        if (tail) {
          const last = deferLoggedAt.get(sessionID) ?? 0
          if (Date.now() - last > 60_000) {
            deferLoggedAt.set(sessionID, Date.now())
            await log(
              "info",
              `auto-continue: round-inject deferred (turn-end injection already present; session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(msg.id)}, trigger=${sanitizeLog(tail.id)}, role=${tail.role}, created=${tail.created > 0 ? new Date(tail.created).toISOString() : "?"})`,
            )
          }
          return "deferred"
        }
      } catch (err) {
        // 读不到会话时不能盲目叠加，也不能永久饿死循环：记录后按原路径继续，
        // 队列侧 pendingUserInjects 仍在注入前兜底。
        await log("error", `auto-continue: turn-end injection check failed (session=${sanitizeLog(sessionID)}): ${sanitizeLog(err).slice(0, 160)}`)
      }
    }
    if (!claimInject(sessionID, msg.id)) {
      await log("info", `auto-continue: ${kind}-inject duplicate suppressed (session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(msg.id)})`)
      return "duplicate"
    }
    // R2676（fix 1）：pre-boot 429 尾条的 recover 注入必须先拿 per-run 排他标记。
    // 早先的 eval 级检查与这里之间仍可能被 resume-once 抢先；`wx` 认领保证只有
    // 一方真正 promptAsync。round 注入不走这条路径，后续新 429 也不受影响。
    let quotaTailOwned = false
    let sent = false
    if (kind === "recover") {
      const t = (msg as any)?.time ?? {}
      const preBootQuotaTail = isPreBootQuotaTail({
        hasError: Boolean(msg.error),
        rateLimit: isRateLimitError(errorName(msg), errorText(msg), errorStatus(msg)),
        created: Number(t.created ?? 0),
        bootAt: AC_BOOT_AT,
      })
      if (preBootQuotaTail) {
        const quotaClaim = claimQuotaTail(sessionID, msg.id, "auto-continue")
        if (quotaClaim === "exists") {
          const owner = readQuotaTailMarker(sessionID, msg.id)?.owner ?? "?"
          unclaimInject(sessionID, msg.id)
          await log(
            "info",
            `auto-continue: ${kind}-inject skipped (quota tail already claimed this run by=${owner}, session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(msg.id)})`,
          )
          return "quota-exclusive"
        }
        if (quotaClaim !== "ok") {
          unclaimInject(sessionID, msg.id)
          const attempts = (pending.get(msg.id) ?? 0) + 1
          pending.set(msg.id, attempts)
          await log(
            "error",
            `auto-continue: ${kind}-inject deferred (quota-tail marker write failed, session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(msg.id)}, attempts=${attempts}, retryMs=${backoffMs(attempts)})`,
          )
          setTimeout(() => {
            evaluateQueued(sessionID)
          }, backoffMs(attempts))
          return "backoff"
        }
        quotaTailOwned = true
      }
    }
    // 用户指令：排队内容单独注入，不拼进循环文本（搭便车已下线）
    try {
      // claim 后、真正触网前再检查一次，避免 stop 落在 await/调度间隙。
      if (loopGateStopped(readLoopCtl(), sessionID)) {
        unclaimInject(sessionID, msg.id)
        if (quotaTailOwned) releaseQuotaTail(sessionID, msg.id, "auto-continue")
        await log("info", `auto-continue: ${kind}-inject suppressed after claim (session=${sanitizeLog(sessionID)})`)
        return "stopped"
      }
      // R2826：认领与 promptAsync 之间窗口内可能刚好写入/认领换会话请求。
      if (rolloverPendingFor(sessionID)) {
        unclaimInject(sessionID, msg.id)
        if (quotaTailOwned) releaseQuotaTail(sessionID, msg.id, "auto-continue")
        await log(
          "info",
          `auto-continue: ${kind}-inject suppressed after claim (429 rollover pending; session=${sanitizeLog(sessionID)})`,
        )
        return "deferred"
      }
      // promptAsync 同样可能挂起 —— 一次挂起就会堵死该会话的整条评估链（见 evaluateQueued）。
      // R227：尾部附自动注入提示（不动前缀，SYNTHETIC_LOOP_MARKERS 的 startsWith 判定不受影响）。
      // 运营者指令（2026-10-19）：「循环注入提示词增加上次用户注入的内容，避免ai忘记」——
      // 注入文本尾部再附最近一条真实用户消息原文（best-effort；取不到就照常注入，不阻塞）。
      //
      // R2659（运营者：「添加简单模式，只注入“继续”」）：simple 模式下**不拼**任何
      // 其它内容（不查 lastRealUserExcerpt、不附 AUTO_INJECT_HINT），正文就是“继续”。
      // R2663（运营者：「增加一个自动循环注入信息自定义模式」）：custom 模式发用户
      // 保存的文案，支持 {{base}}/{{last_user}}/{{hint}} 占位符；只有模板真的引用
      // {{last_user}} 时才去查历史（省一次 session.messages）。
      // 合成身份由 metadata 承载（宿主会把它存进 user 消息行）；不能只靠文本匹配 ——
      // 真实用户也可能打“继续”或与自定义文案相同的字。
      const mode = readLoopInjectMode()
      const customText = mode === "custom" ? readLoopInjectCustom() : ""
      const wantsLastUser = mode === "full" || (mode === "custom" && customText.includes("{{last_user}}"))
      let lastUserSection = ""
      if (wantsLastUser) {
        try {
          const lres = await withTimeout(client.session.messages({ path: { id: sessionID } }), "session.messages")
          const lrows = (lres as { data?: any[] })?.data
          if (Array.isArray(lrows)) {
            sortRowsByCreatedTime(lrows)
            lastUserSection = lastRealUserExcerpt(lrows)
          }
        } catch {
          /* 附带内容为增强项，缺失不影响循环注入 */
        }
      }
      const outText = composeLoopInjectText(mode, { base: text, lastUser: lastUserSection, custom: customText })
      const injectMeta = loopInjectMetaForMode(mode)
      await withTimeout(
        client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text: outText }],
            ...(injectMeta ? { metadata: injectMeta } : {}),
            resume: true,
            delivery: "queue",
          } as any,
        }),
        "session.promptAsync",
      )
      sent = true
      await log(
        "info",
        `auto-continue: ${kind}-inject sent (session=${sanitizeLog(sessionID).slice(0, 14)}, mode=${mode}, len=${outText.length})`,
      )
      // promptAsync 返回不等于回合已经启动完成；若停止在调用期间到达，立即补发中断。
      if (loopGateStopped(readLoopCtl(), sessionID)) {
        try {
          await (client.session as any).interrupt?.({ path: { id: sessionID } })
        } catch {
          /* best-effort */
        }
        unclaimInject(sessionID, msg.id)
        if (quotaTailOwned) releaseQuotaTail(sessionID, msg.id, "auto-continue")
        await log("info", `auto-continue: ${kind}-inject interrupted by stop gate (session=${sanitizeLog(sessionID)})`)
        return "stopped"
      }
      // R2228 循环注入提醒：注入成功后 fire（由拥有该会话的 Bot 侧发送；
      // fire-and-forget，通知失败/挂起绝不影响循环主链路）。
      fireInjectNotices(sessionID, kind)
      // 成功注入一轮 = 会话已恢复推进 → 清空该会话的停滞计时；
      // R923 的全局 5min 错误窗口故意不清空，旧错误按时间自然过期。
      if (kind === "round") {
        errStallSince.delete(sessionID)
      }
      return "ok"
    } catch (err) {
      unclaimInject(sessionID, msg.id)
      // 只有「还没成功发出」才释放排他标记；sent 之后紧接着的记账异常不能让
      // resume-once 把同一条 429 再恢复一次。
      if (quotaTailOwned && !sent) releaseQuotaTail(sessionID, msg.id, "auto-continue")
      const attempts = (pending.get(msg.id) ?? 0) + 1
      pending.set(msg.id, attempts)
      await log(
        "error",
        `auto-continue: ${kind}-inject failed (session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(msg.id)}, attempts=${attempts}, retryMs=${backoffMs(attempts)}): ${sanitizeLog(err)}`
      )
      setTimeout(() => {
        evaluateQueued(sessionID)
      }, backoffMs(attempts))
      return "backoff"
    }
  }

  // 提前返回的可观测性：这两处原来是**静默 return**，"循环不动"时日志里什么都不显示，
  // 只能靠猜（本次停摆 5 小时就是这么查不出来的）。现在按 60s 节流记一行。
  let skipTargetLogAt = 0
  let skipLeaseLogAt = 0
  // R2796：按会话节流。旧实现是一个全局时间戳：第一个 halted 会话（bot3/bot4 共用的
  // ses_e996）每分钟占满日志，bot5 的 front 被 halt 时**一行都不打**，看起来像循环
  // 无缘无故不动。每个会话各自 60s 一条，才能同时看见多个被停会话。
  const skipHaltedLogAt = new Map<string, number>()
  // 挂起防护：宿主 HTTP 调用（session.messages / session.prompt）**可能永不 settle**。
  // 一次挂起会把该会话的评估链永久卡死（见 evaluateQueued 的串行链），而且完全静默。
  const HOST_CALL_TIMEOUT_MS = 25_000
  const withTimeout = async <T,>(p: Promise<T>, label: string, ms = HOST_CALL_TIMEOUT_MS): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const evaluate = async (sessionID: string) => {
    // R2237：热重载后旧实例仍可能收到 session.idle。若旧实例在 owner 租约
    // 里抢赢新实例，会把 R2236 已能续跑的 completed-empty 重新打成
    // GIVEUP(empty x5)（2026-10-20 03:08Z bot3 实证）。进入任何状态机前
    // 先按代际短路，确保只有当前插件实例能评估/写租约。
    if ((globalThis as Record<string, unknown>)[AC_GEN_KEY] !== myGenAc) return
    try {
      // 单会话作用域：TG 当前钉选/前台会话之外的任何事件都不得续跑。
      if (!isLoopTarget(sessionID)) {
        if (Date.now() - skipTargetLogAt > 60_000) {
          skipTargetLogAt = Date.now()
          await log(
            "info",
            `auto-continue: eval skipped (not loop target: session=${sanitizeLog(sessionID).slice(0, 14)} target=${sanitizeLog(currentLoopTarget()).slice(0, 14) || "(none)"})`,
          )
        }
        return
      }
      // R1107：用户 ⏹ 主动终止的会话不驱动 —— 否则"主动终止后自动循环仍进行"。
      // halted 由 doStop 写各 Bot 状态文件；用户新消息或 /loop start 清除后自然恢复。
      if (haltedSessions().includes(sessionID)) {
        const now = Date.now()
        if (now - (skipHaltedLogAt.get(sessionID) ?? 0) > 60_000) {
          skipHaltedLogAt.set(sessionID, now)
          await log("info", `auto-continue: eval skipped (user-halted: session=${sanitizeLog(sessionID).slice(0, 14)})`)
        }
        return
      }
      // owner singleton (claim → delay → verify): only the newest loaded
      // instance proceeds; older instances return here (kills duplicate
      // ROUND injects after hot-reload).
      try {
        const ownerPath = process.env.AC_OWNER_PATH ?? "/tmp/opencode/tg-poll-owner.json"
        let j: any = {}
        try {
          j = JSON.parse(readFileSync(ownerPath, "utf8"))
        } catch {
          j = {}
        }
        try {
          // R2237：owner 租约带代际；代际更大的实例持有时，旧实例不得覆盖。
          // 这修的是 R2236 热重载后“旧插件收到 idle → 抢到租约 → 对 completed-empty
          // 打 GIVEUP”的竞态；旧实例在 evaluate 入口已有代际短路。
          const prevGen = Number(j?.ac?.gen ?? 0)
          if (Number.isFinite(prevGen) && prevGen > myGenAc) return
          // R1849 同类缺口修复：tg-poll-owner.json 与 tg-bridge 的 claimPollOwner/amPollOwner
          // 跨进程（多 Bot 进程）读写；裸 writeFileSync 的 O_TRUNC 窗口会让并发读者 parse 失败
          // → 误判「无主」重复抢主 / 误判「无 ac 主」双实例各注入一次。改用 atomicWriteJson（tmp+rename）。
          atomicWriteJson(ownerPath, { ...j, ac: { id: myAcId, gen: myGenAc, ts: Date.now() } })
        } catch {
          /* best-effort */
        }
        await new Promise((r) => setTimeout(r, 500))
        try {
          const cur = (JSON.parse(readFileSync(ownerPath, "utf8")) as any)?.ac
          if (cur && typeof cur.id === "string" && cur.id !== myAcId) {
            // 租约被别人持有 = 本实例不注入。静默 return 会让"循环停摆"完全无迹可寻。
            if (Date.now() - skipLeaseLogAt > 60_000) {
              skipLeaseLogAt = Date.now()
              await log(
                "info",
                `auto-continue: eval skipped (ac lease held by another instance: holder=${sanitizeLog(String(cur.id)).slice(0, 24)} mine=${sanitizeLog(myAcId).slice(0, 24)})`,
              )
            }
            return
          }
        } catch {
          /* best-effort: proceed */
        }
      } catch {
        /* best-effort: proceed */
      }
      const res = await withTimeout(client.session.messages({ path: { id: sessionID } }), "session.messages")
      const messages = res.data ?? []
      if (!Array.isArray(messages)) {
        await log(
          "error",
          `auto-continue: eval begin session=${sanitizeLog(sessionID)} messages-API shape unexpected (type=${typeof messages}${Array.isArray(messages) ? "" : ` json=${sanitizeLog(JSON.stringify(messages)).slice(0, 160)}`}) -> skip`
        )
        return
      }
      // R208：行序归一化（宿主 seq 跨进程可重计 ⇒ 行序 ≠ 时序，见 sortRowsByCreatedTime）
      sortRowsByCreatedTime(messages)

      // R2655: 每轮都数（不只在"还没有成功回合"时），否则首个成功之后新增的
      // 200 永远不计数，<10 的阈值就退化成布尔值。scan 自带去重与上限。
      scanRound200(messages)

      // R2647（运营者："上一轮没有200吗，为什么增加429统计了"）：健康回合是
      // **出口可用**的证据，与「本会话是否在自动循环」无关。旧实现只在通过
      // loop/停机闸之后才 noteHealthyRound；用户 /loop stop 后仍照常聊天得到的
      // 200 完全不被记录，随后配额 429 被误判成"整轮没有 200"，CI_429_STREAK
      // 仍然 +1。这里在判定 loop 之前扫描本进程启动后的任意无错 assistant 回合。
      if (!AC_ROUND_HAD_SUCCESS) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const info = (messages[i] as any)?.info
          if (info?.role !== "assistant" || info?.error) continue
          if (!messageCompletedThisRun(info)) continue
          noteHealthyRound(sessionID, Number(info?.time?.created ?? 0))
          break
        }
      }

      // 粘性：该会话此前已被识别为循环会话（见 loopSessions 注释）
      // 每轮重读**两个**名单：/loop on|off 是**桥**（另一个模块）写的，本进程内存可能还是旧的。
      // 刻意**每轮读盘**：低频循环（60s 一次），代价可忽略，换来"立刻生效"。
      // ⚠️ R1048 踩过一次：最初**只**给关闭清单加了每轮重读，正向名单仍在启动时读一次
      //   → `/loop on` 之后不重启就一直 `loop=no`（实测 34/34 全是 loop=no 才暴露）。
      //   两个名单必须**同等对待**，否则"开"不生效、"关"生效 = 最难查的那种半吊子。
      try {
        loopSessions.clear()
        const arr = JSON.parse(readFileSync(LOOP_SESSIONS_PATH, "utf8"))
        if (Array.isArray(arr)) for (const x of arr) if (typeof x === "string" && x.startsWith("ses_")) loopSessions.add(x)
      } catch {
        /* 读不到 = 没有登记项 */
      }
      try {
        loopOffSessions.clear()
        const arr = JSON.parse(readFileSync(LOOP_OFF_PATH, "utf8"))
        if (Array.isArray(arr)) for (const x of arr) if (typeof x === "string" && x.startsWith("ses_")) loopOffSessions.add(x)
      } catch {
        /* 读不到 = 没有关闭项 */
      }
      // R1048：关闭清单**优先于**粘性标志 —— 用户显式 /loop off 的会话，
      // 即使历史上被登记过、或消息里带标记词，也不该被驱动。
      let loop = loopSessions.has(sessionID) && !loopOffSessions.has(sessionID)
      // R1896：front/pinned 目标会话默认入循环（「默认一直跑，/loop stop 才停」是
      // /loop help 承诺的语义）。缺口：正向注册表 loop-sessions.json 只有「消息带标记词」
      // 或「/loop on」时才会被创建；文件不存在（新装/清库/迁移）时，R1839 的"目标保命"
      // 合并（persistLoopSessions 内）又被 loopSessionsDirty 挡住永不执行 → front 会话
      // 恒 loop=no → 每分钟 `eval begin … loop=no -> skip`，用户看到"自动循环没生效"，
      // 而标题上却还挂着 [LOOP]（marker 由 syncLoopMarker 按闸门状态写，与注册表无关，
      // 两套状态因此漂移）。标记词检测只是补充判据，不是唯一入口；显式 /loop off 仍然最优先。
      if (!loop && !loopOffSessions.has(sessionID) && isLoopTarget(sessionID)) {
        loop = true
        if (!loopSessions.has(sessionID)) {
          loopSessions.add(sessionID)
          loopSessionsDirty = true
        }
      }
      let assistantCount = 0
      let lastUserTime = 0
      let lastAssistant: { info: AssistantMessage; text: string; parts: any[] } | undefined
      for (const m of messages) {
        if (!m || typeof m !== "object") continue
        const t = textOf(m)
        if (m.info?.role === "user") {
          lastUserTime = Number((m.info as any)?.time?.created ?? 0)
        }
        if (m.info?.role === "assistant") {
          assistantCount++
          lastAssistant = { info: m.info, text: t, parts: Array.isArray(m.parts) ? m.parts : [] }
          // 窗口占用 = tokenSumOf = input+output+reasoning+cache.read+cache.write，
          // 与 tg-bridge ctxTotal **五字段**完全一致（R2607 尾款：此前此处只算
          // input+cache.read，而兜底路径 tokenSumOf 与界面都是五字段 → 同一会话
          // eval% 比界面低 out+rea，压缩触发点两套口径各算各的）。cache.read 仍是
          // 大头（f339 实测 in=664 / cr=214k），只看 input 会把 21% 报成 <1%。
          const tk = (m.info as any)?.tokens
          const win = tokenSumOf(tk)
          if (win > 0) usage.set(sessionID, win)
        }
        // 只有真实用户消息才能登记循环；助手报告和自动注入的 ROUND/RECOVER
        // 不得把其它历史会话误判为循环会话。R2663：custom 文案不一定以固定前缀
        // 开头，合成身份以 metadata 标记为准。
        if (
          !loopOffSessions.has(sessionID) &&
          m.info?.role === "user" &&
          (rowHasLoopInjectMeta(m) || isSyntheticPrompt(t) || t.includes("筛查循环") || /\[\s*STATUS\s*:/.test(t))
        ) {
          loop = true
          if (!loopSessions.has(sessionID)) {
            loopSessions.add(sessionID)
            loopSessionsDirty = true
          }
        }
      }

      if (!loop) {
        // 200 行窗口里没有循环控制消息时，用专用查询再看最近 60 条真实用户消息。
        // （f312 就是这么被判成 loop=no 而停摆的：重会话里标记消息被工具行挤出窗口。）
        const userTexts = loopOffSessions.has(sessionID) ? [] : await readRecentUserTexts(sessionID, 60)
        for (const t of userTexts) {
          if (isSyntheticPrompt(t) || t.includes("筛查循环") || t.includes("自动筛查") || STATUS_RE.test(t)) {
            loop = true
            break
          }
        }
        if (loop) {
          await log(
            "info",
            `auto-continue: loop marker recovered outside 200-msg window (session=${sanitizeLog(sessionID).slice(0, 12)}, scanned=${userTexts.length} user msgs)`
          )
        }
      }
      // R2795（运营者：「为什么不会429重启，为什么需要我手动点」）：配额信号必须
      // 在 loop-off / loop-stopped 提前返回**之前**发出。旧顺序先 `!loop -> skip`
      // 再 logQuotaSignal，导致循环已停的 Bot 收到真实用户消息后 429 时既不落
      // 证据、也不触发换轮/换会话，用户只能手动点按钮。这里只要求存在 assistant
      // 尾条；是否计入本轮仍由 messageCompletedThisRun 判定（恢复的旧错误不算）。
      if (lastAssistant) {
        await logQuotaSignal(sessionID, lastAssistant.info as any, quotaTurnKind(messages))
      }
      if (!loop || !lastAssistant) {
        await log(
          "info",
          `auto-continue: eval begin session=${sanitizeLog(sessionID)} msgs=${assistantCount} lastAssistant=${lastAssistant ? "yes" : "no"} loop=${loop ? "yes" : "no"} -> skip`
        )
        return
      }
      // 循环标记会话登记：静默无事件时由 interval 按 idle 节律带驾（一直循环）
      loopSeen.set(sessionID, Date.now())
      if (loopSeen.size > 50) {
        const fk = loopSeen.keys().next()
        if (!fk.done) loopSeen.delete(fk.value)
      }
      // v32 gates: newest-message tracking for user-takeover suspend + dormant skip.
      // messages are oldest->newest; last assignment wins.
      let newestId = ""
      let newestTs = 0
      let latestUserText: string | undefined
      let newestUserTs = 0
      for (const m of messages) {
        if (!m || typeof m !== "object") continue
        const mid = String((m as any)?.id ?? (m as any)?.info?.id ?? "")
        if (mid) newestId = mid
        const created = Number((m as any)?.info?.time?.created ?? 0)
        if (Number.isFinite(created) && created > newestTs) newestTs = created
        if ((m as any)?.info?.role === "user") {
          const t = textOf(m)
          // R2659/R2663：循环注入的正文（simple 的「继续」/ custom 任意文案）不能被
          // 当成“真实用户发言”去更新 newestUserTs（空转熔断的豁免依据）。真实用户
          // 打「继续」同样安全：这里只影响一行日志与空转豁免，不会把会话判进/判出循环。
          if (!rowHasLoopInjectMeta(m) && !isNeutralUserText(t) && !isSyntheticPrompt(t) && !isSimpleContinueText(t)) {
            latestUserText = t
            if (Number.isFinite(created) && created > newestUserTs) newestUserTs = created
          }
        }
      }
      // ── R211 死循环跳闸（运营者 2026-10-19 03:16 指令：「任何错误都应该触发」）──
      // 事故实证（10-18 夜 5.5h 静默，run 39168964380）：错误尾条出现后，decided 闉锁 /
      // 持久认领 / in-flight-hold / fatal-giveup / empty-stall 熔断**任意一层短路**，
      // 都能让其后的所有守卫（墙钟 L1846、连错计数）静默失效 → 既不输出也不重启。
      // 本检查位于**全部短路之前**，只看「尾条是错误 + 错误态已持续 + 会话确已空闲」：
      //   · t0 = 本进程内首次见到错误尾条的墙钟（跨进程重置；新进程给 5min 自愈期）
      //   · quiet = 尾条自 updated/completed/created 起 ≥ ROUND_SETTLE_MS 无动静（不在宿主重试里）
      //   · injectAllowed 复核 = 宿主确认会话空闲（活回合/流式中 ⇒ 永不跳闸）
      //   · 用户显式停（user-abort-pause/agent-paused/loop-stopped/auto-guard）永不跳闸
      // 三者齐备且 ≥ AC_ERR_STALL_MS ⇒ END-ROUND-CI（exit 0 → relay 重启 CI；运营者授权）。
      {
        const sk = skipState.get(sessionID)
        const userExcluded =
          !!sk &&
          (sk.reason === "loop-stopped" ||
            sk.reason === "auto-guard" ||
            sk.reason === "user-abort-pause" ||
            sk.reason === "agent-paused")
        if (userExcluded) {
          errStallSince.delete(sessionID)
        } else if ((lastAssistant!.info as any)?.error) {
          const la: any = lastAssistant!.info
          // R2568 (operator: "怎么一直死循环？"): a restored pre-run error used to
          // satisfy `quiet` immediately because its created/updated/completed was
          // ~24h old. After AC_ERR_STALL_MS the pre-latch trip ended every fresh
          // run before it could do any work (observed: 8 runs relayed every
          // ~7.8min with `dead-loop trip ... idle=87241s`). Only an error created
          // by this process may trip; a restored one is handled by the normal
          // preboot recovery path.
          if (!messageCompletedThisRun(la)) {
            errStallSince.delete(sessionID)
          } else {
            const t = la?.time ?? {}
            const activity = Math.max(Number(t.updated ?? 0), Number(t.completed ?? 0), Number(t.created ?? 0))
            if (errStallSince.get(sessionID) === undefined) errStallSince.set(sessionID, Date.now())
            const quiet = activity > 0 && Date.now() - activity >= ROUND_SETTLE_MS
            if (quiet && stallExceeded(sessionID) && (await injectAllowed(sessionID, la, "stall-trip"))) {
              await log(
                "info",
                `auto-continue: dead-loop trip (pre-latch; session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(String(la?.id ?? ""))}, err=${errorName(la)}, idle=${Math.round((Date.now() - activity) / 1000)}s) -> END-ROUND-CI (exit 0; workflow relay restarts CI)`,
              )
              if (String(process.env.TG_BRIDGE_FORCE_SERVE ?? "") === "1") {
                endRunNow(`dead-loop trip: ${errorName(la)} idle=${Math.round((Date.now() - activity) / 1000)}s`)
              }
              return
            }
          }
        } else {
          errStallSince.delete(sessionID)
        }
      }
      // R-1720：全局 /loop stop 期间由 readCtl 分支写入的 "loop-stopped" 粘性条目，
      // 在 /loop start 重开闸后必须立即失效 —— 否则闸已开而 newestId 无新消息时，
      // 每拍命中下方 `skip.lastId === newestId` 静默 return，会话永久停摆
      // （实测 f1f1829d：13:52 停环期写入 → 14:47 /loop start 后至今零 eval，
      //   与 f260d5c5「熔断后再没循环过」同类，只有来新用户消息才侥幸解锁）。
      // 闸仍关（stop 未解除）时保持粘性静默；闸方开时清单条目一次性失效。
      {
        const loopStoppedSkip = skipState.get(sessionID)
        if (loopStoppedSkip && (loopStoppedSkip.reason === "loop-stopped" || loopStoppedSkip.reason === "auto-guard")) {
          let gateOpen = false
          try {
            // R1915：清闸判定按会话感知 bot 级闸 —— 顶层 stopped 只是全局闸一种形态，
            // 守卫/单 bot 停写在 bots[&lt;id&gt;].stopped。若只认顶层，单 bot 停期间
            // gateOpen 恒 true → 粘性 skip 被误清，守卫等于没停。
            gateOpen = !loopGateStopped(readLoopCtl(), sessionID)
          } catch {
            gateOpen = true
          }
          if (gateOpen) {
            skipState.delete(sessionID)
            await log(
              "info",
              `auto-continue: loop-stopped skip cleared (gate reopened, session=${sanitizeLog(sessionID).slice(0, 12)}, reason=${loopStoppedSkip.reason})`
            )
          }
        }
      }
      const skip = skipState.get(sessionID)
      if (skip) {
        // 粘性熔断 + 退避重开：自己产的空消息不解门；用户新发言或退避到期后自动恢复。
        //
        // 顺序很重要（2026-09-26 修）：**必须先判断退避是否到期，再做 lastId 短路**。
        // 此前 `if (skip.lastId === newestId) return` 在前，于是熔断后会话没有新消息 →
        // newestId 恒定 → 每拍都在第一行返回 → 退避到期也永远不 REARM → 该会话**永久停摆**
        // （实测 f260d5c5 在 02:21:57 熔断后再没循环过；f339 只是靠你发新指令才恢复）。
        const gc = giveupCount.get(sessionID) ?? 1
        const backoffMs = Math.min(90_000 * Math.pow(2, Math.max(0, gc - 1)), 30 * 60_000)
        const fuseOpen = skip.reason === "empty-stall-giveup" && !(newestUserTs > (skip.ts ?? 0))
        const expired = fuseOpen && Date.now() - (skip.ts ?? 0) > backoffMs
        // 退避期内且没有新消息 → 维持粘性静默
        if (!expired && skip.lastId === newestId) return
        if (fuseOpen) {
          if (!expired) {
            skip.lastId = newestId
            return
          }
          await log("info", `auto-continue: eval session=${sanitizeLog(sessionID)} -> REARM(fuse expired after ${Math.round(backoffMs / 60000)}m, giveup x${gc})`)
        }
        skipState.delete(sessionID)
      }
      try {
        const ctl = readLoopCtl()
        // R1915：SKIP 判定兼容 bot 级闸 —— 守卫单 bot 停（bots[&lt;id&gt;].stopped）后，
        // 该 bot 的会话也要能进这条统一 SKIP 路径（此前只认顶层 stopped，bot 级闸的
        // 会话会漏掉 SKIP、每拍白跑 eval 到 inject 才被 loopGateStopped 挡）。
        if (loopGateStopped(ctl, sessionID)) {
          // 停止是硬闸：只有桥接的显式 `/loop start` 才能解除。
          // 任意普通用户消息（包括含“循环”字样的历史消息）都不得自动复活自动续跑。
          const stopBy = ctl?.stopped === true ? (ctl?.by ?? "?") : botStopMeta(ctl, sessionID)?.by ?? "?"
          const stopReason = ctl?.stopped === true ? ctl?.reason : botStopMeta(ctl, sessionID)?.reason
          skipState.set(sessionID, { lastId: newestId, reason: "loop-stopped" })
          await log("info", `auto-continue: eval session=${sanitizeLog(sessionID)} msgs=${assistantCount} -> SKIP(loop stopped by=${stopBy}${stopReason ? ` reason=${sanitizeLog(stopReason).slice(0, 80)}` : ""}, /loop start to resume)`)
          return
        }
      } catch {
        /* no ctl file: loop enabled */
      }
      // 用户指令：用户主动停止之前一直循环 —— 真实用户发言不再挂起循环（5 分钟节流打一行日志）。
      if (latestUserText !== undefined && !isLoopControlUserText(latestUserText)) {
        const lastNote = lastUserNote.get(sessionID) ?? 0
        if (Date.now() - lastNote > 5 * 60_000) {
          lastUserNote.set(sessionID, Date.now())
          await log("info", `auto-continue: note session=${sanitizeLog(sessionID)} msgs=${assistantCount} user-active(真实用户发言; 循环照常续跑, 直至 /loop stop)`)
        }
      }
      // dormant 跳过已取消：用户主动停止之前一直循环（空会话由 empty-stall 熔断兜底）。
      const { info: msg } = lastAssistant

      // ── 重启孤儿回合解锁（2026-10-18 08:12 事故）─────────────────────────────
      // 取消/重启后，最后一条 assistant 常常 completed=null（写它的进程已死）。
      // 10s/20s/30s 重试后它会被 settle() 进 decided ⇒ 之后每次 eval 都在
      // `decided.has(id)` 静默返回，5 分钟时只打一条 HUNG-TURN 日志 ⇒ **永不注入**，
      // 直到用户发话（实测 08:12→08:24 共 12 分钟）。这里强制解锁：
      // 创建早于本进程启动 + 未完成 = 孤儿，不是活回合，允许继续走注入路径。
      {
        const t0 = (msg as any)?.time ?? {}
        if (preBootOrphan({ completed: Number(t0.completed ?? 0), created: Number(t0.created ?? 0), bootAt: HOST_BOOT_AT })) {
          decided.delete(msg.id)
          skipState.delete(sessionID)
          if (!orphanLogged.has(String(msg.id))) {
            orphanLogged.add(String(msg.id))
            await log(
              "info",
              `auto-continue: orphan turn detected (session=${sanitizeLog(sessionID)}, msg=${String(msg.id).slice(0, 20)}, created=${new Date(Number(t0.created)).toISOString()} before host boot ${new Date(HOST_BOOT_AT).toISOString()}) -> unlock decided, resume loop`,
            )
          }
        }
      }

      // R704：preboot user 尾条恢复。旧逻辑只覆盖 preboot assistant；若最后一条是
      // 重启前产生的 user（典型：后台任务完成通知），其后没有 assistant，则 decided
      // 仍锁住上一条 assistant，循环只打 user-active note 不注入。这里按“尾条 created
      // 早于 boot”解锁一次；只影响 preboot 数据，post-boot 活回合不受影响。
      // R2716：尾检跳过终态压缩行（failed/completed 不承载回合）；进行中的压缩保持
      // 不判（blocked），避免把提示词插进压缩流程。
      {
        const tailInfo = effectiveTail(messages)
        const tail: any = tailInfo.row
        if (!tailInfo.blocked && tail) {
          const tailId = tailInfo.id
          const tailRole = String(tail?.info?.role ?? tail?.role ?? "")
          const tailCreated = Number(tail?.info?.time?.created ?? tail?.time?.created ?? 0)
          if (
            tailRole === "user" &&
            tailId &&
            tailId !== String(msg.id) &&
            preBootDeadTurn({ created: tailCreated, bootAt: HOST_BOOT_AT })
          ) {
            decided.delete(msg.id)
            skipState.delete(sessionID)
            preBootUserTail.set(sessionID, tailId)
            if (!orphanLogged.has(`usertail:${tailId}`)) {
              orphanLogged.add(`usertail:${tailId}`)
              await log(
                "info",
                `auto-continue: preboot user tail detected (session=${sanitizeLog(sessionID)}, tail=${tailId.slice(0, 20)}, created=${new Date(tailCreated).toISOString()} before host boot ${new Date(HOST_BOOT_AT).toISOString()}) -> unlock decided, resume loop`,
              )
            }
          }
        }
      }

      // ── 宿主侧回合挂起告警（只检测 + 如实上报，**不**擅自中断用户的会话） ──
      // 实测：备用会话最后一个工具 state=running 挂了 11 分钟、time.completed 一直为空，
      // 宿主不再发任何事件 → 桥没有卡可推、循环也不该往"活着的回合"里注入。
      // 从外面看就是"机器人不说话了"，用户无从判断是自己卡了还是坏了 —— 必须说出来。
      {
        const t = (msg as any)?.time ?? {}
        const done = Number(t.completed ?? 0) > 0
        const touched = Number(t.updated ?? t.created ?? 0)
        if (!done && Number.isFinite(touched) && touched > 0) {
          const ageMin = Math.round((Date.now() - touched) / 60_000)
          if (ageMin >= HUNG_TURN_MIN) {
            const last = lastHungNote.get(sessionID) ?? 0
            if (Date.now() - last > 10 * 60_000) {
              lastHungNote.set(sessionID, Date.now())
              // 精确区分两种"未完成"：宿主在**等这个询问的回答**（question 工具待答，
              // 桥已把询问卡补推到 TG，等你回即可），和工具真的挂住。实测踩过：
              // 早期文案一律说"可能挂起"，把"等答案"说成了"坏了"，会误导排查方向。
              const pendingAsk = lastAssistant.parts.find(
                (p: any) =>
                  String(p?.type ?? "") === "tool" &&
                  String(p?.tool ?? "") === "question" &&
                  ["running", "pending"].includes(String((p as any)?.state?.status ?? "")),
              )
              // ⚠️ 这段文案原来写的是「回一条即可继续」—— **与询问卡上写的自相矛盾**：
              // 卡片明确说「本宿主没有回答询问的接口，回一条只是新消息、不一定结束这次询问」。
              // 实测（2026-09-26 15:11/15:12 两条答案 15:12 就 delivered）那一回合直到
              // 15:47 才动，中间 33 分钟零输出 —— "即可继续"是假的，而且会把排查引向
              // "用户没答对"这个错误方向。日志说错话比不说更贵：今晚"本宿主不可压缩"
              // 正是这么误导我的。
              const why = pendingAsk
                ? "宿主在等这个询问的回答（question 工具待答）。⚠️ 本宿主没有「回答询问」的接口：你在 TG 上回的内容只是新消息、排进宿主队列，不保证结束这次询问（与询问卡上写的同一件事）。若长时间没反应：用 ⏹ 停止，或在宿主侧按 Esc 中断该回合"
                : "最后一个工具可能真的挂住（无待答询问）"
              await log(
                "info",
                `auto-continue: eval session=${sanitizeLog(sessionID)} -> HUNG-TURN(宿主侧回合未完成且已 ${ageMin} 分钟无更新; ${why}) —— 前台会话由桥的回合静默看门狗在 15 分钟自动中断并续跑；非前台或循环已停仍需手动处理。循环不注入以免打断它`,
              )
            }
          }
        }
      }

      if (decided.has(msg.id)) return

      const fullText = lastAssistant.text.trimEnd()

      const len = fullText.length

      // AI 自主暂停：助手**独占一行**宣告 [LOOP: PAUSE[: 原因]] → 与用户暂停同等效力并持久化。
      // 文档/报告里提及该标记不再误触发（见 loop-guard.ts 的 loopPauseDecl）。
      const pm = loopPauseDecl(fullText)
      if (pm.declared) {
        const reason = pm.reason
        writeCtlStopped(true, "agent", reason)
        settle(msg)
        skipState.set(sessionID, { lastId: newestId, reason: "agent-paused" })
        await log("info", `auto-continue: eval session=${sanitizeLog(sessionID)} msgs=${assistantCount} -> SKIP(agent paused${reason ? `: ${sanitizeLog(reason)}` : ""}, /loop start to resume)`)
        return
      }

      if (!msg.error) {
        errStallSince.delete(sessionID)
        // R2512：正常 assistant 消息 = 该会话的一次成功回合，只打断**本会话**的连续错误链。
        // R2535：必须是本进程启动后创建/完成的回合；恢复的旧尾部不算本轮成功。
        if (messageCompletedThisRun(msg)) noteHealthyRound(sessionID, Number(msg?.time?.created ?? 0))
      } else if (messageCompletedThisRun(msg) && stallExceeded(sessionID)) {
        // R210（运营者指令）：错误停滞 ≥ 阈值（5 连错的墙钟等价物）→ 结束本轮 CI。
        // R2568：恢复的旧错误（created < 本进程 boot）不得触发；否则每个新 run
        // 都会在 5 分钟后凭 24h 前的 aborted 尾条自我结束，形成 ~8 分钟一次的
        // “死循环”接力（实测 8 个 run）。旧错误交给 preboot 恢复路径处理。
        await log(
          "info",
          `auto-continue: error stall ≥${Math.round(AC_ERR_STALL_MS / 60000)}min (session=${sanitizeLog(sessionID)}) -> END-ROUND-CI (exit 0; workflow relay restarts CI)`,
        )
        if (String(process.env.TG_BRIDGE_FORCE_SERVE ?? "") === "1") {
          endRunNow(`error stall >= ${Math.round(AC_ERR_STALL_MS / 60000)}min (${errorName(msg)})`)
        }
        return
      }
      if (msg.error) {
        settle(msg)
        // R942：出口代理**按轮换**（见 exit-proxy.ts）——本轮内没有可切换的出口，
        // Bun 启动时解析一次代理，运行期改 env 也不换隧道（实测）。
        // 429/配额类错误的正解是**换一轮**（新代理 ⇒ 新出口 IP ⇒ 新额度），
        // 这里只做记录，处置交给下面的"连续错误 → END-ROUND-CI"。
        // R2564（运营者最高优先级：zengate 200 后仍 429）：恢复的旧会话尾条也会
        // 走这里。旧实现把“上一轮遗留的 quota 错误”按**当前时刻**打印成
        // `provider.free-limit` 日志；egress-watch 只认日志墙钟时间，于是在新 run
        // 选中健康出口后 ~60s 内误判“200→quota”，停轮并把健康出口拉黑 6h。
        // 实测 2026-11-07 11:19/11:20/11:22 三个不同 relay 全部 64s 误杀，TUI
        // 日志里 provider.free-limit=0 且无健康回合。现在日志带 this_run/msg_at，
        // watcher 双重过滤；恢复的旧错误不计入连续失败。
        const quotaThisRun = messageCompletedThisRun(msg)
        const quotaMsgAt = Number((msg as any)?.time?.created ?? 0)
        const quotaMsgAtIso = quotaMsgAt > 0 ? new Date(quotaMsgAt).toISOString() : "?"
        // R2806：兜底 timer 只认这条 429 之后写下的 probe meta。取日志落盘前的
        // 时刻，避免 watcher 极快启动 probe 时 mtime 落在 startedAt 之前。
        const quotaSeenAt = Date.now()
        // R2623: already emitted before the /stop gate above; this call is a
        // no-op for the same message id and keeps the normal path unchanged.
        await logQuotaSignal(sessionID, msg, quotaTurnKind(messages))
        // R2676（fix 1）：本 run 内同一条 pre-boot 429 只允许一个恢复者。
        // resume-once 的额度尾恢复与这里的 fatal recover 会撞同一秒；已有标记
        // （任一方成功认领）就只跳过这一条尾消息。后续新 429 是新 message id，
        // 不受影响；没有时间窗/冷却，秒失败→换出口的节奏不变。
        const preBootQuotaTail = isPreBootQuotaTail({
          hasError: Boolean(msg.error),
          rateLimit: isRateLimitError(errorName(msg), errorText(msg), errorStatus(msg)),
          created: quotaMsgAt,
          bootAt: AC_BOOT_AT,
        })
        if (preBootQuotaTail) {
          const quotaOwner = readQuotaTailMarker(sessionID, msg.id)?.owner
          if (quotaOwner) {
            skipState.set(sessionID, { lastId: newestId, reason: "quota-tail-exclusive" })
            await log(
              "info",
              `auto-continue: eval session=${sanitizeLog(sessionID)} msg=${sanitizeLog(msg.id)} -> SKIP(quota-tail already recovered this run by=${quotaOwner}; no duplicate injection)`,
            )
            return
          }
        }
        // R942：全部会话连续 2 次错误 → END-ROUND-CI（exit 0）→ workflow relay 起新 run
        // → 新 run 重新挑出口代理（新出口 IP ⇒ 不再撞同一个额度）。
        // ESC/abort 是用户主动中断，不进入错误预算。
        // R2564：恢复的旧错误也不进入本轮的连续失败计数（否则 3 次旧错误即可
        // 结束一个尚未真正失败的 run）。
        if (!isAbortSignal(msg.error) && !quotaThisRun) {
          await log(
            "info",
            `auto-continue: restored pre-run error not counted (this_run=false, msg_at=${quotaMsgAtIso}, session=${sanitizeLog(sessionID)}, name=${sanitizeLog(errorName(msg))}, ${exitProxySummary()})`,
          )
        }
        if (!isAbortSignal(msg.error) && quotaThisRun) {
          const err = noteErrorStreak(sessionID, msg.id)
          if (err.added) {
            // R2512：按本会话 streak 决策；max 只用于日志（跨会话最高值）。
            const action = errorPolicyAction({ streak: err.streak })
            await log(
              "info",
              `auto-continue: error streak ${err.streak}/${ERR_CONSECUTIVE_LIMIT} for session ` +
                `(session=${sanitizeLog(sessionID)}, max=${err.max}/${ERR_CONSECUTIVE_LIMIT}, action=${action}, ${exitProxySummary()})`,
            )
            if (action === "end") {
              await log(
                "info",
                `auto-continue: error streak ${err.streak} -> END-ROUND-CI (exit 0; workflow relay restarts a fresh run; anonymous free quota is egress-IP-scoped, so the new run re-selects egress for a fresh IP; ${exitProxySummary()})`,
              )
              if (String(process.env.TG_BRIDGE_FORCE_SERVE ?? "") === "1") {
                endRunNow(`${err.streak} consecutive errors (last=${errorName(msg)}); anonymous free quota is egress-IP-scoped; relaying a fresh round with a new egress`)
              }
              return
            }
          }
        }
        // R2806：本轮自己撞上的 quota/429 不再 in-run recover。egress-watch 已经
        // 用第一个验证过的 429 结束本轮（QUOTA_LIMIT=1），relay 的新 run 换出口后
        // 由 boot 尾恢复续写。立即 recover 只是把同一个 429 再打一次（实测 18ms
        // 后再次 429；历史 ≤60s 的 quota 恢复 216/216 失败）。
        const inRunQuota = suppressInRunQuotaRecover({
          hasError: Boolean(msg.error),
          rateLimit: isRateLimitError(errorName(msg), errorText(msg), errorStatus(msg)),
          completedThisRun: quotaThisRun,
          egressWatchActive: egressWatchActive(),
        })
        if (inRunQuota) {
          settle(msg)
          fatalStreak.delete(sessionID)
          skipState.set(sessionID, { lastId: newestId, reason: "quota-429-egress-restart" })
          await log(
            "info",
            `auto-continue: eval session=${sanitizeLog(sessionID)} msg=${sanitizeLog(msg.id)} -> WAIT(quota 429 this run; no in-run recover; egress-watch ends this round for a fresh egress, next boot finishes the interrupted tail; ${exitProxySummary()})`,
          )
          armQuotaRestartFallback(sessionID, msg, quotaSeenAt)
          return
        }
        if (isFatal(msg)) {
          const n = errorName(msg)
          // R1548：ESC/宿主中断不再只认精确名 "MessageAbortedError"（host 实测写
          // error=aborted），中止族错误统一过 classifyAbort：
          //   新鲜且无用户后续  → 持久停闸（ESC//stop 语义）
          //   新鲜但有用户后续  → 不停闸不发恢复提示（用户消息自然续跑，防双发）
          //   陈旧（或无穷锚）  → 走既有 RECOVER（与 provider 瞬时错误同等待遇）
          if (isAbortSignal(msg.error)) {
            // R2739：连续重启时 bootAt 判据会漏（见 abort-classify）。会话里
            // 中止点附近的 synthetic restart 通知是跨实例成立的旁证。
            const abortAt = Number((msg as any).time?.completed ?? (msg as any).time?.created ?? 0)
            const restartNoticed = restartNoticeNear(messages, abortAt)
            const d = classifyAbort({
              completed: Number((msg as any).time?.completed ?? 0),
              created: Number((msg as any).time?.created ?? 0),
              lastUserTime,
              staleMs: ABORT_STALE_MS,
              bootAt: AC_BOOT_AT,
              restartNoticed,
            })
            noteAbortEvent({
              ts: Date.now(),
              session: sessionID,
              name: n,
              verdict: d.verdict,
              fresh: d.fresh,
              userAfter: d.userAfter,
              src: "eval",
            })
            if (d.verdict === "pause") {
              // R1553：ESC/宿主中断 = 仅暂停该会话本轮，**不写全局 loop-ctl 硬闸**、
              // 不注入恢复提示；该会话下一条真实用户消息自然解除暂停（skipState 的
              // lastId===newestId 短路逻辑保证）。其他会话照常循环，各会话相互独立。
              skipState.set(sessionID, { lastId: newestId, reason: "user-abort-pause" })
              await log("info", `auto-continue: eval session=${sanitizeLog(sessionID)} msg=${sanitizeLog(msg.id)} error=${n} -> PAUSE(session round paused; user message will resume, others continue)`)
              return
            }
            if (d.verdict === "skip") {
              // 用户在中止后继续发言：不自动注入恢复提示（避免与用户消息双发），
              // 也不停闸 —— 用户消息/下一次评估自然续跑。
              await log("info", `auto-continue: eval session=${sanitizeLog(sessionID)} msg=${sanitizeLog(msg.id)} error=${n} -> SKIP(abort but user active after; not reinjecting)`)
              return
            }
            const age = d.anchor > 0 ? Math.round((Date.now() - d.anchor) / 1000) : -1
            await log(
              "info",
              `auto-continue: eval session=${sanitizeLog(sessionID)} msg=${sanitizeLog(msg.id)} error=${n} -> RECOVER(abort, age=${age}s, userAfter=${d.userAfter}${restartNoticed ? ", restart=yes" : ""})`,
            )
          } else {
            const streak = (fatalStreak.get(sessionID) ?? 0) + 1
            fatalStreak.set(sessionID, streak)
            // R942：全局「2 连错 → 结束本轮」已在上层统一处置；这里的单会话 fatal ×3
            // 兜底保留（全局判定被 abort/去重短路时仍能收手）。
            if (streak >= 3) {
              await log("info", `auto-continue: eval session=${sanitizeLog(sessionID)} msg=${sanitizeLog(msg.id)} len=${len} error=${n} -> STOP(fatal x${streak}, giving up)`)
              return
            }
            await log("info", `auto-continue: eval session=${sanitizeLog(sessionID)} msg=${sanitizeLog(msg.id)} len=${len} error=${n} -> RECOVER(fatal streak=${streak})`)
          }
          // R2233：RECOVER 也必须过空闲复核（与 round 路径同一判据）。provider 瞬时错误若宿主
          // 已自行重试（尾部有更新的 in-flight 步），就不该再往活着的回合里插恢复提示——用户实报的
          // 「输出未完成就注入」同样覆盖 RECOVER 提示。尾部**孤立**的错误步（completed>0、
          // finish=error、其后无更新消息）仍判空闲 → 照常恢复，不破坏"可恢复错误不停机"。
          // 注意：本块入口（msg.error 处）已 settle(msg)，hold 时必须 decided.delete 以便下拍重评。
          // R2781：上一条消息是回合结束注入（用户 pinQueue / 429 换会话 / resume-once /
          // 循环提示）且这一条 assistant 是它的首应答 → 这一轮不注入 recover。
          // 否则会像 03:19 那样：注入「继续」失败后 7s 又注入一条「继续」。
          {
            const trigger = turnStartMessageOfAssistant(messages, msg.id)
            if (trigger && (trigger.created === 0 || trigger.created >= AC_BOOT_AT)) {
              skipState.set(sessionID, { lastId: newestId, reason: "turn-end-injection" })
              await log(
                "info",
                `auto-continue: recover suppressed (turn started by injected message; session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(msg.id)}, trigger=${sanitizeLog(trigger.id)}, role=${trigger.role}, created=${trigger.created > 0 ? new Date(trigger.created).toISOString() : "?"})`,
              )
              return
            }
          }
          if (!(await injectAllowed(sessionID, msg, "recover:fatal"))) {
            decided.delete(msg.id)
            return
          }
          await maybeCompact(sessionID, usageOf(sessionID, msg), assistantCount)
          settle(msg)
          let r = await inject(sessionID, msg, RECOVER_PROMPT, "recover")
          // R2676（fix 1）：resume-once 抢先认领了这条 pre-boot quota 尾 → 本次不注入。
          if (r === "quota-exclusive") {
            skipState.set(sessionID, { lastId: newestId, reason: "quota-tail-exclusive" })
            return
          }
          // R204（D4）**陈旧认领逃生**。实测症状：某 bot 的 front 目标末条是 12h 前的 abort，
          // claim（`${sid}:${msg.id}`，持久化于 /tmp/opencode/round-claims.json）在早期注入时
          // 已写盘但宿主从未产出回合 ⇒ 此后每拍 `recover-inject duplicate suppressed`、
          // **没有任何回退**，该会话永久 0 回合（目标饿死）。三者同时满足才判「陈旧」：
          // ① 末条错误消息本身已 ≥ STALE_CLAIM_MS（默认 30min）；② 空闲复核已通过
          // （injectAllowed=true ⇒ 尾部无活回合，不会插进正在跑的回合）；③ recover 去重命中。
          // 处置：释放陈旧 claim 后改注入 ROUND_PROMPT（正常循环驱动；成功注入还会清零连错计数）。
          // R2676（fix 1）：陈旧认领逃生只适用于普通错误。pre-boot 429 尾条由
          // resume-once/auto-continue 的单次恢复处理；把它升级成 ROUND 注入会
          // 绕开互斥标记，重新造成同一条额度尾被恢复两次。
          if (r === "duplicate" && !preBootQuotaTail) {
            const errAt = Number((msg as any).time?.completed ?? (msg as any).time?.created ?? 0)
            const errAgeMs = errAt > 0 ? Date.now() - errAt : 0
            if (errAgeMs >= STALE_CLAIM_MS) {
              unclaimInject(sessionID, msg.id)
              await log("info", `auto-continue: stale claim escape (session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(msg.id)}, errAge=${Math.round(errAgeMs / 1000)}s) -> ROUND inject`)
              r = await inject(sessionID, msg, ROUND_PROMPT, "round")
            }
          }
          if (r !== "ok") {
            decided.delete(msg.id)
            return
          }
          return
        }
        fatalStreak.delete(sessionID)
        await log("info", `auto-continue: eval session=${sanitizeLog(sessionID)} msg=${sanitizeLog(msg.id)} len=${len} error=${errorName(msg)} -> RECOVER`)
        // R941：错误预算/切 IP/结束本轮已在上方统一处理（fatal 与 recoverable 共用）。
        // R2233：同上——宿主已自行重试（尾部有更新的 in-flight 步）时不往活着的回合插恢复提示。
        // R2781：与 fatal 分支同一闸门，见上。
        {
          const trigger = turnStartMessageOfAssistant(messages, msg.id)
          if (trigger && (trigger.created === 0 || trigger.created >= AC_BOOT_AT)) {
            skipState.set(sessionID, { lastId: newestId, reason: "turn-end-injection" })
            await log(
              "info",
              `auto-continue: recover suppressed (turn started by injected message; session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(msg.id)}, trigger=${sanitizeLog(trigger.id)}, role=${trigger.role}, created=${trigger.created > 0 ? new Date(trigger.created).toISOString() : "?"})`,
            )
            return
          }
        }
        if (!(await injectAllowed(sessionID, msg, "recover"))) {
          decided.delete(msg.id)
          return
        }
        await maybeCompact(sessionID, usageOf(sessionID, msg), assistantCount)
        settle(msg)
        const r = await inject(sessionID, msg, RECOVER_PROMPT, "recover")
        // R2676（fix 1）：resume-once 抢先认领了这条 pre-boot quota 尾 → 本次不注入。
        if (r === "quota-exclusive") {
          skipState.set(sessionID, { lastId: newestId, reason: "quota-tail-exclusive" })
          return
        }
        if (r !== "ok") {
          decided.delete(msg.id)
          return
        }
        return
      }

      // ── 自动停止守卫（用户 2026-09-28 新增）──────────────────────────────
      // 检测到「问题」（助手自报 [SIGNAL:PROBLEM] / 本轮宣告 [STATUS: STOP]）或
      // 「网页搜索请求」（助手自报 [SIGNAL:WEBSEARCH] / 本回合真调了搜索工具）时，
      // **不再注入下一轮**，改为写停机总闸（by=auto-guard）。恢复路径与 [LOOP:PAUSE]/
      // /stop 完全同一条：/loop start（菜单「继续循环」）清闸即续跑。
      //
      // 位置很讲究：
      //  · 放在**错误处理之后** —— provider 瞬时错误（ECONNRESET 等）走既有 RECOVER，
      //    不受守卫影响（用户既有规则：可恢复错误不停机，只记症状继续跑）。
      //  · 放在**注入之前** —— 守卫的全部意义就是「这一轮不续跑」。
      //  · 判据只认**独占行**的标记（loop-guard 里有反例护栏）：报告里复述循环规则
      //    必然出现 [STATUS: CONTINUE/STOP] 的字面文本，子串匹配会让循环一装即死。
      {
        // R2674：守卫开关按**会话所属 Bot**读取。此前读共享 loop-guard.json ⇒
        // 在 bot5 菜单里关掉问题即停，bot6 也一起被关。触发本来就只停单 Bot
        // （R1915），现在开关与触发/判重记录的作用范围终于一致。
        const guardBotId = botIdForSession(sessionID)
        const gcfg = readGuardForBot(guardBotId)
        if (gcfg.problem || gcfg.websearch) {
          const gsig = detectGuardSignals(fullText, lastAssistant.parts)
          const gv = guardVerdict(gcfg, gsig)
          if (gv.trip && guardTripped.get(sessionID) !== msg.id) {
            // R1902 持久化判重：同一条消息只判停一次，跨进程重启生效。
            // 否则陈旧消息里的旧 [STATUS: STOP] 会在每次部署重启后重新拉全局闸
            // （in-memory guardTripped 随重启清零 → /loop start 清闸也活不过下次重启）。
            if (alreadyTripped(readGuardLastTripForBot(guardBotId), sessionID, msg.id)) {
              guardTripped.set(sessionID, msg.id)
              await log(
                "info",
                `auto-continue: guard trip skipped (message already judged, run continues; session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(msg.id)})`,
              )
            } else {
              guardTripped.set(sessionID, msg.id)
              // R1915：守卫按“出问题那个 bot”停单 bot 闸，其余 bot 照常循环（用户要求）。
              writeCtlBotStopped(sessionID, "auto-guard", gv.reason)
              noteGuardTripForBot(guardBotId, gv.kind, gv.reason, sessionID, msg.id)
              settle(msg)
              skipState.set(sessionID, { lastId: newestId, reason: "auto-guard" })
              await log(
                "info",
                `auto-continue: eval session=${sanitizeLog(sessionID)} msgs=${assistantCount} -> SKIP(auto-guard ${gv.kind}: ${sanitizeLog(gv.reason).slice(0, 120)}; /loop start or menu resume to continue)`,
              )
              return
            }
          }
        }
      }

      if (len === 0) {
        // ── pre-boot 死回合 + 空文本（2026-10-18 08:49 事故）────────────────────
        // 取消/重启瞬间被杀的回合常常只剩 1 个空 reasoning part（textChars=0）。
        // 生成者已死 ⇒ 不是"流式中"：`waiting(in-flight)` 会无限等待（实测 5 分钟
        // 零注入，直到用户发话）。这里把它按"已完成空回合"直接续跑。
        // 必须先确认它仍是**最后一条消息**：若已有更新的用户/助手消息（新回合已开始），
        // 交给常规路径，绝不往活回合里插提示词。
        {
          const t = (msg as any)?.time ?? {}
          if (preBootDeadTurn({ created: Number(t.created ?? 0), bootAt: HOST_BOOT_AT })) {
            let newest = ""
            try {
              const res = await withTimeout(client.session.messages({ path: { id: sessionID } }), "session.messages")
              const rows = Array.isArray(res?.data) ? res.data : []
              sortRowsByCreatedTime(rows) // R208：序归一化（尾检必须按 time.created）
              // R2716（bot5 实报：循环开着却不再注入）：尾部是**终态压缩**（completed/failed）
              // 时，它不是“更新的消息”，必须透明跳过再比较；只有进行中的压缩才持有本拍。
              const tail = effectiveTail(rows)
              if (tail.blocked) {
                const holdKey = `preboot-empty-hold:${sessionID}:${tail.blocked}`
                if (!orphanLogged.has(holdKey)) {
                  orphanLogged.add(holdKey)
                  await log(
                    "info",
                    `auto-continue: preboot-empty held (session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(msg.id)}, tail=${tail.blocked})`,
                  )
                }
                return
              }
              newest = tail.id
            } catch {
              return
            }
            // 取不到 id（API 异常/空数组）时也不放行：宁可下一拍再判，不做无证据注入。
            // R704：若最新消息是 preboot user 尾条（后台通知），assistant 不是 newest，
            // 但这正是需要恢复的空回合；preBootUserTail 已在 orphan 段校验过 created < boot。
            if (newest !== String(msg.id) && !preBootUserTail.has(sessionID)) return
            if (!(await injectAllowed(sessionID, msg, "round:preboot-empty"))) return
            emptyStreak.delete(sessionID)
            pending.delete(msg.id)
            giveupCount.delete(sessionID)
            skipState.delete(sessionID)
            lastRoundAt.set(sessionID, Date.now())
            settle(msg)
            const rr = await inject(sessionID, msg, ROUND_PROMPT, "round")
            if (rr !== "ok") {
              decided.delete(msg.id)
              return
            }
            preBootUserTail.delete(sessionID)
            await log(
              "info",
              `auto-continue: preboot-empty dead turn -> inject (session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(msg.id)}, created=${new Date(Number(t.created ?? 0)).toISOString()} < host boot ${new Date(HOST_BOOT_AT).toISOString()})`,
            )
            return
          }
        }
        // 事件流给的消息对象**可能不带 parts**（实测第二个会话：keys=id|role|time|error|
        // tokens|model，parts=0），于是"有内容"被误判成"空转"，连续 5 次就熔断 → 该会话
        // 表现为"总是不循环"。而走会话 API 读同一条消息是带 parts 的（桥接能渲染真实内容
        // 就是证据）。所以判空前先回源重读一次，用真实 parts 判定。
        // 一律回源一次（按消息 id 去重）：事件流对象可能没有 parts，**也可能**有 parts
        // 但全是 reasoning/工具态而算不出文本（len 仍为 0）。两种情况都会误判成空转。
        if (!refetchedEmpty.has(msg.id)) {
          refetchedEmpty.add(msg.id)
          if (refetchedEmpty.size > 500) {
            const first = refetchedEmpty.values().next()
            if (!first.done) refetchedEmpty.delete(first.value)
          }
          try {
            const again = await client.session.messages({ path: { id: sessionID } })
            const arr = Array.isArray(again?.data) ? again.data : []
            const hit = arr.find((x: any) => String(x?.id ?? x?.info?.id ?? "") === String(msg.id))
            const hp: any[] = Array.isArray(hit?.parts) ? (hit as any).parts : []
            const hText = hp.filter((q) => q?.type === "text").reduce((a, q) => a + String(q?.text ?? "").length, 0)
            const hReason = hp.filter((q) => q?.type === "reasoning").reduce((a, q) => a + String(q?.text ?? "").length, 0)
            const hTools = hp.filter((q) => q?.type === "tool").length
            const hKinds = [...new Set(hp.map((q) => String(q?.type ?? "?")))].join(",") || "(none)"
            if (hp.length > 0) {
              await log(
                "info",
                `empty-verdict refetch: msg=${String(msg.id).slice(0, 20)} parts=${hp.length}[${hKinds}] textChars=${hText} reasonChars=${hReason} tools=${hTools} → 事件流口径不可靠（无 parts 或算不出文本），改用 API 口径`,
              )
              // reasoning 有实质内容 = 模型在思考（回合被截断），不是空转。
              // 此前只看 text/tool，会把"只产出思考"的回合判成空转 → 熔断误伤
              // → 表现为"另一个会话总是不循环"。
              // R1092: 只有【文本/工具】产出才算"回合结束有输出"；纯思考(reasoning)不算——
              // 用户反馈「AI 没有输出时循环文本仍被注入」→ 仅思考的回合不注入，等待文本/工具产出。
              if (hText > 0 || hTools > 0) {
                // 有真实产出：不是空转，清计数并按正常节奏续跑
                if (!(await injectAllowed(sessionID, msg, "round:refetch"))) return
                // R1092: refetch 注入也遵守 R1090 最小间隔（此前绕过节流）
                {
                  const __acLast = lastRoundAt.get(sessionID) ?? 0
                  if (__acLast > 0 && Date.now() - __acLast < MIN_ROUND_MS) {
                    if (Date.now() - (throttleLogAt.get(sessionID) ?? 0) > 60_000) {
                      throttleLogAt.set(sessionID, Date.now())
                      await log('info', `auto-continue: round-inject throttled (refetch, session=${sanitizeLog(sessionID).slice(0, 12)}, sinceLast=${Math.round((Date.now() - __acLast) / 1000)}s)`)
                    }
                    return
                  }
                }
                emptyStreak.delete(sessionID)
                pending.delete(msg.id)
                giveupCount.delete(sessionID)
                skipState.delete(sessionID)
                lastRoundAt.set(sessionID, Date.now())
                settle(msg)
                const rr2 = await inject(sessionID, msg, ROUND_PROMPT, "round")
                if (rr2 !== "ok") decided.delete(msg.id)
                return
              }
              if (hReason >= 200) {
                // 纯思考无产出：AI 还没主动结束回合 → 不注入、不熔断、等待下拍
                noteReasoningOnly(String(msg.id))
                pending.delete(msg.id)
                if (Date.now() - (throttleLogAt.get(sessionID) ?? 0) > 60_000) {
                  throttleLogAt.set(sessionID, Date.now())
                  await log('info', `auto-continue: eval session=${sanitizeLog(sessionID).slice(0, 12)} msg=${String(msg.id).slice(0, 14)} -> reasoning-only(${hReason}字, 无文本/工具), 不注入,等待真实产出`)
                }
                return
              }
            } else {
              await log(
                "info",
                `empty-verdict refetch: msg=${String(msg.id).slice(0, 20)} API 侧同样没有 parts（真·空转）`,
              )
            }
          } catch (err) {
            await log("error", `empty-verdict refetch failed: ${sanitizeLog(err).slice(0, 120)}`)
          }
        }
        const attempts = (pending.get(msg.id) ?? 0) + 1
        pending.set(msg.id, attempts)
        const waitMs = 10_000 * Math.min(attempts, 6)
        if (attempts <= 3) {
          // 把"判为空"时**实际看到的东西**记下来：消息的字段形状、parts 的类型分布、
          // 文本长度、以及 info/parts 两种取值路径的结果。此前只说"text-empty"，
          // 导致"该会话明明有内容却一直被判空"这类问题无法定位（第二个会话长期不循环）。
          try {
            const anyMsg: any = msg
            const rawParts: any[] = Array.isArray(anyMsg?.parts) ? anyMsg.parts : []
            const infoParts: any[] = Array.isArray(anyMsg?.info?.parts) ? (anyMsg.info.parts as any[]) : []
            const kinds = (arr: any[]): string => {
              const m = new Map<string, number>()
              for (const p of arr) {
                const t = String(p?.type ?? "?")
                m.set(t, (m.get(t) ?? 0) + 1)
              }
              return [...m.entries()].map(([k, v]) => `${k}x${v}`).join(",") || "(none)"
            }
            const textChars = (arr: any[]): number =>
              arr.filter((p) => p?.type === "text").reduce((a, p) => a + String(p?.text ?? "").length, 0)
            const infoTextChars = (arr: any[]): number =>
              arr.filter((p) => p?.type === "text").reduce((a, p) => a + String(p?.text ?? "").length, 0)
            await log(
              "info",
              `empty-verdict shape: msg=${String(msg.id).slice(0, 20)} keys=${Object.keys(anyMsg ?? {}).slice(0, 8).join("|")} ` +
                `parts=${rawParts.length}[${kinds(rawParts)}] textChars=${textChars(rawParts)} ` +
                `info.parts=${infoParts.length}[${kinds(infoParts)}] infoTextChars=${infoTextChars(infoParts)} ` +
                `info.role=${String(anyMsg?.info?.role ?? "?")} completed=${Number(anyMsg?.time?.completed ?? 0) > 0} ` +
                // R1042：把 `error` 的**值**也打出来。
                // 为什么：keys 里一直有 `error` 字段，但形状日志只打"有这个键"、不打值 →
                // 我无法判断"空判定"到底是宿主报错造成的、还是消息本来就没内容。
                // 查 db 也查不到（那条消息已不在 session_message）→ 只能靠日志留痕。
                // 刻意**截断并压掉空白**：宿主错误文本可能很长或带 \n，进日志会糊成多行。
                `err=${JSON.stringify(anyMsg?.error ?? anyMsg?.info?.error ?? null).slice(0, 160).replace(/\s+/g, " ")}`,
            )
          } catch (err) {
            await log("error", `empty-verdict shape failed: ${sanitizeLog(err).slice(0, 120)}`)
          }
          // 用户反馈（2026-09-26）："发送时没有判断是否合法中间态" —— 判断正确，此处原本就分了两档：
          //   completed=false（流式中）→ 不计入空转、不熔断；completed 且无文本 → 才是真空转。
          // 但**日志措辞**没分：两种都写成 `stalling(text-empty)`，把合法的生成中中间态报成停滞。
          const __inFlight = Number((msg as any)?.time?.completed ?? 0) === 0
          await log(
            "info",
            __inFlight
              ? `auto-continue: eval session=${sanitizeLog(sessionID)} msg=${sanitizeLog(msg.id)} -> waiting(in-flight=生成中，属合法中间态，非空转)，${waitMs}ms 后再看`
              : `auto-continue: eval session=${sanitizeLog(sessionID)} msg=${sanitizeLog(msg.id)} -> stalling(text-empty 真空转), retry in ${waitMs}ms`,
          )
        }
        // 空转熔断：只有【已完成仍无文本】才计数；流式中一律视为瞬态（不计数、不熔断、不掐回合）。
        // 验尸 00:34:59：曾把首 token 到达 3 秒后的前台直播消息当空转掐掉（Step interrupted 误伤）。
        const completedTs = Number((msg as any)?.time?.completed ?? 0)
        // R2236：completed 且无 text/tool 的“死回合”也要走 workedAnyway 的有限续跑路径。
        // 旧实现只认 parts 里的 reasoning；API parts 缺失时 workedAnyway=false，
        // 会落入 empty-stall/GIVEUP 或永久等待（bot3 2026-10-20 02:52Z 复发的第二种形态）。
        const completedDead = completedTs > 0 && !hasRealToolWork(msg) && len === 0
        const workedAnyway = hasNonTextWork(msg) || completedDead
        if (attempts >= 2 && completedTs > 0 && !workedAnyway && !reasoningOnlyMsgs.has(String(msg.id))) {
          const n = (emptyStreak.get(sessionID) ?? 0) + 1
          emptyStreak.set(sessionID, n)
          if (n >= 5) {
            emptyStreak.delete(sessionID)
            completedDeadStreak.delete(sessionID)
            pending.delete(msg.id)
            giveupCount.set(sessionID, (giveupCount.get(sessionID) ?? 0) + 1)
            skipState.set(sessionID, { lastId: msg.id, reason: "empty-stall-giveup", ts: Date.now() })
            await log("info", `auto-continue: eval session=${sanitizeLog(sessionID)} msg=${sanitizeLog(msg.id)} -> GIVEUP(empty x${n}, waiting for new activity)`)
            // 注意：此处不再 interrupt。实测（00:34–01:08 共 8 次 abort）证明两点：
            // ① 掐不死服务端的空包生产（掐完照吐）；② 曾误伤前台直播回合。熔断观察 + 粘性静默已够用。
            return
          }
        }
        let completedDeadTurn = false
        if (workedAnyway) {
          // 真实文本/工具产出即恢复，清零连续 reasoning-only 计数。
          if (len > 0 || hasRealToolWork(msg)) completedDeadStreak.delete(sessionID)
          if (!(await injectAllowed(sessionID, msg, "round:workedAnyway"))) return
          // R2238（用户实报「开启了自动压缩为什么没压缩」）：completed 且无 text/tool 的
          // 死回合会从本分支续跑，旧代码在这里提前 return，绕过了正常路径的 maybeCompact；
          // bot3 2026-10-20 03:50Z 在 82% 连续 text-empty 却不压缩即此因（primary 79% 正常路径
          // 已自动压缩）。只在回合已完成后调用，绝不压缩生成中的活回合；压缩失败不阻断续跑。
          if (completedTs > 0) await maybeCompact(sessionID, usageOf(sessionID, msg), assistantCount)
          // R1092: 只有 reasoning 没有工具/文本 = 还在思考/被截断，不算"主动结束干活"，
          // 不注入（用户反馈「AI 没有输出时循环文本仍被注入」）；也不计空转（R1065 豁免）。
          // R2235/R2236: completed>0 且无 text/tool 表示回合已结束，不是"还在思考"；
          // 这是死回合，必须允许有限续跑，否则会像 bot3 2026-10-20 09:10 CST 那样静默 47 分钟。
          // 即使 API parts 缺失、只剩 empty，也由上面的 completedDead 纳入本路径。
          if (!hasRealToolWork(msg) && len === 0) {
            const __done = Number((msg as any)?.time?.completed ?? 0) > 0
            if (!__done) {
              noteReasoningOnly(String(msg.id))
              pending.delete(msg.id)
              if (Date.now() - (throttleLogAt.get(sessionID) ?? 0) > 60_000) {
                throttleLogAt.set(sessionID, Date.now())
                await log('info', `auto-continue: eval session=${sanitizeLog(sessionID).slice(0, 12)} msg=${String(msg.id).slice(0, 14)} -> reasoning-only(workedAnyway:无工具产出, in-flight), 不注入`)
              }
              return
            }
            completedDeadTurn = true
          }
          // R1092: workedAnyway 注入也遵守 R1090 最小间隔（此前绕过节流）
          {
            const __acLast = lastRoundAt.get(sessionID) ?? 0
            if (__acLast > 0 && Date.now() - __acLast < MIN_ROUND_MS) {
              if (Date.now() - (throttleLogAt.get(sessionID) ?? 0) > 60_000) {
                throttleLogAt.set(sessionID, Date.now())
                await log('info', `auto-continue: round-inject throttled (workedAnyway, session=${sanitizeLog(sessionID).slice(0, 12)}, sinceLast=${Math.round((Date.now() - __acLast) / 1000)}s)`)
              }
              return
            }
          }
          if (completedDeadTurn) {
            const n = (completedDeadStreak.get(sessionID) ?? 0) + 1
            completedDeadStreak.set(sessionID, n)
            if (n >= 3) {
              completedDeadStreak.delete(sessionID)
              pending.delete(msg.id)
              giveupCount.set(sessionID, (giveupCount.get(sessionID) ?? 0) + 1)
              skipState.set(sessionID, { lastId: msg.id, reason: "empty-stall-giveup", ts: Date.now() })
              await log("info", `auto-continue: eval session=${sanitizeLog(sessionID)} msg=${sanitizeLog(msg.id)} -> GIVEUP(completed-dead x${n}, waiting for new activity)`)
              return
            }
            await log(
              "info",
              `auto-continue: completed dead-turn x${n} -> resume loop (session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(msg.id)}, completed>0, no text/tool)`,
            )
          }
          // 有工具产出 = 在干活：清空空转计数，按正常节奏续跑（不必等 10s+ 重试）
          emptyStreak.delete(sessionID)
          pending.delete(msg.id)
          giveupCount.delete(sessionID)
          skipState.delete(sessionID)
          lastRoundAt.set(sessionID, Date.now())
          settle(msg)
          const rr = await inject(sessionID, msg, ROUND_PROMPT, "round")
          if (rr !== "ok") decided.delete(msg.id)
          return
        }
        setTimeout(() => {
          evaluateQueued(sessionID)
        }, waitMs)
        return
      }

      // R1090: 注入节流 —— 距上次注入 < MIN_ROUND_MS 时静默跳过本轮,
      // 由 interval(60s) 下拍再评估(区间节流, 不改变 skipState/熔断语义).
      {
        const acLast = lastRoundAt.get(sessionID) ?? 0
        const acNow = Date.now()
        if (acLast > 0 && acNow - acLast < MIN_ROUND_MS) {
          if (acNow - (throttleLogAt.get(sessionID) ?? 0) > 60_000) {
            throttleLogAt.set(sessionID, acNow)
            await log('info', `auto-continue: round-inject throttled (session=${sanitizeLog(sessionID).slice(0, 12)}, sinceLast=${Math.round((acNow - acLast) / 1000)}s < ${MIN_ROUND_MS / 1000}s)`)
          }
          return
        }
      }
      if (!(await injectAllowed(sessionID, msg, "round:normal"))) return
      completedDeadStreak.delete(sessionID)
      emptyStreak.delete(sessionID)
      await maybeCompact(sessionID, usageOf(sessionID, msg), assistantCount)

      // 用户消息只影响当前回合；助手回合完成后仍继续自动循环。
      // 先认领后发送：并发 evaluate 在 await 间隙重入时，decided 已有记号，不会重复注入；失败则放回。
      settle(msg)
      const r = await inject(sessionID, msg, ROUND_PROMPT, "round")
      if (r !== "ok") {
        decided.delete(msg.id)
        return
      }
      preBootUserTail.delete(sessionID)
      // 有产出即清零熔断计数（会话恢复）
      giveupCount.delete(sessionID)
      lastRoundAt.set(sessionID, Date.now())
      fatalStreak.delete(sessionID)
      settle(msg)
      await log("info", `auto-continue: injected round prompt (session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(msg.id)}, len=${len})`)
    } catch (err) {
      await log(
        "error",
        `auto-continue: error (session=${sanitizeLog(sessionID)}): ${sanitizeLog(err)}`
      )
    }
  }

  const EVAL_WEDGE_MS = 90_000
  // 「回合未完成且长时间无更新」超过这个分钟数就如实上报（不自动干预）
  const HUNG_TURN_MIN = 5
  const lastHungNote = new Map<string, number>()
  const queueSince = new Map<string, number>()
  const evaluateQueued = (sessionID: string): void => {
    // 看门狗：串行链上一次挂起就会永久堵死该会话（实测停摆 5 小时）。超过阈值就
    // **另起一条链**并记日志；旧链若日后恢复，它的 finally 里有 identity 守卫，
    // 不会误删新链。
    const since = queueSince.get(sessionID)
    let prev: Promise<unknown> = Promise.resolve()
    let wedged = false
    if (since !== undefined) {
      const held = Date.now() - since
      if (held > EVAL_WEDGE_MS) {
        wedged = true
        void log(
          "error",
          `auto-continue: loop wedge detected (in-flight ${Math.round(held / 1000)}s, session=${sanitizeLog(sessionID).slice(0, 14)}) — 评估链疑似挂起，已另起一条`,
        )
        prev = Promise.resolve()
      } else {
        prev = (queue.get(sessionID) ?? Promise.resolve()) as Promise<unknown>
      }
    } else {
      prev = (queue.get(sessionID) ?? Promise.resolve()) as Promise<unknown>
    }
    const next = prev.then(() => evaluate(sessionID)).catch(() => {})
    // R1909：仅在新链起点才重置计时（在途链保留原起点）。R1918：完成即清理交给
    // trackQueuedChain —— 原实现的身份校验写错对象，导致清理从不发生、看门狗反复误报。
    trackQueuedChain(next, queue, queueSince, sessionID, since, Date.now(), wedged)
  }

  // R2672：turn-end note 的「🔁 继续循环」按钮写完会话名单/清闸后调用这里。
  // 只靠 60s 兜底 tick 时用户会觉得按钮没反应（回合已结束，time.idle 不会再次变化）。
  // 热重载后旧实例的回调仍可能在 globalThis 上；代数守卫保证只有当前实例执行。
  installAutoContinueNudge((sid) => {
    if ((globalThis as Record<string, unknown>)[AC_GEN_KEY] !== myGenAc) return
    evaluateQueued(sid)
  })

  // R2686（运营者：「模块联动采用事件注册/触发机制而不是轮询」）：
  //   · loop:changed —— 桥写完总闸/单 Bot 闸后立即重评当前目标，不再等 60s 兜底 tick；
  //   · state:changed —— 桥落盘 tg-chats 后立即失效 /quiet 压缩偏好缓存，不再等 10s TTL。
  // 跨进程（其它 Bot）仍由 tick/文件兜底；这里只是同进程的即时通道。
  // 热重载后旧实例的订阅仍在 globalThis 里，故用代数守卫让它们变成 no-op；
  // offOwner 在重装前移除旧订阅，避免每重载一次就多一层回调。
  offOwner("auto-continue")
  const eventGenOK = (): boolean => (globalThis as Record<string, unknown>)[AC_GEN_KEY] === myGenAc
  on(
    "loop:changed",
    () => {
      if (!eventGenOK()) return
      invalidateStateCaches()
      const t = currentLoopTarget()
      if (t) evaluateQueued(t)
    },
    "auto-continue",
  )
  on(
    "state:changed",
    ({ path }) => {
      if (!eventGenOK()) return
      prefsCache.delete(path)
      invalidateStateCaches()
    },
    "auto-continue",
  )

  // Fallback: session.idle may never be emitted (observed: zero evals).
  // Only the persisted TG target is eligible; never census/rollcall the
  // session list, otherwise old reports in other sessions can be revived.
  // R2789：日志节流改成**时间**维度。事件机下 tick 可能每秒多次，不能再按“第 N 拍”
  // 计数（否则流式输出时 scoped target check 会刷屏）。
  let lastScopedLogAt = 0
  let loopSupersededLogged = false
  // R2789：事件机下的三类**到期/看门狗**。它们不是固定轮询：只在有活跃循环、
  // 桥心跳接近阈值、或演练标记等待年龄门时各保留一个一次性 deadline；条件消失即清空。
  let bridgeStaleWake: ReturnType<typeof setTimeout> | null = null
  let simDrillWake: ReturnType<typeof setTimeout> | null = null
  let loopHeartbeatWake: ReturnType<typeof setTimeout> | null = null
  const armLoopWatchdogs = (targets: string[]): void => {
    if ((globalThis as Record<string, unknown>)[AC_GEN_KEY] !== myGenAc) return
    const clear = (t: ReturnType<typeof setTimeout> | null): void => {
      if (!t) return
      try {
        clearTimeout(t)
      } catch {
        /* ignore */
      }
    }
    // ① 桥心跳：状态文件是桥写的；桥死了就没有任何 fs 事件。按 mtime 精确安排下一次
    //    检查（阈值 300s），健康时只在到期前唤醒一次，不按分钟空转。
    const age = bridgeStateAgeSec()
    const staleIn = age < 0 ? 60_000 : Math.max(0, (BRIDGE_STALE_S + 1 - age) * 1000)
    const staleWait = age > BRIDGE_STALE_S ? 60_000 : staleIn
    // 已有 deadline 时不重置：否则高频 DB 事件会不断把它推后，桥真死了反而永远不告警。
    // 健康时它只会提前醒一次（看到 ok 后按最新 mtime 重排），代价可忽略。
    if (!bridgeStaleWake) {
      bridgeStaleWake = setTimeout(() => {
        bridgeStaleWake = null
        requestLoopTick("bridge-watchdog")
      }, Math.max(1_000, staleWait))
      if (typeof (bridgeStaleWake as { unref?: () => void }).unref === "function") {
        ;(bridgeStaleWake as { unref: () => void }).unref()
      }
    }
    // ② 错误重启演练：标记存在但年龄 <240s 时，等到 240s 再判一次（原 60s 拍顺带检查）。
    let simActive = false
    try {
      const raw = readFileSync(SIM_DRILL_PATH, "utf8").trim()
      if (raw !== "" && raw === String(process.env.GITHUB_RUN_ID ?? "")) {
        const ageS = Math.max(0, Math.round((Date.now() - statSync(SIM_DRILL_PATH).mtimeMs) / 1000))
        simActive = ageS < 240
        if (simActive && !simDrillWake) {
          simDrillWake = setTimeout(() => {
            simDrillWake = null
            requestLoopTick("sim-drill-age")
          }, (240 - ageS + 1) * 1000)
          if (typeof (simDrillWake as { unref?: () => void }).unref === "function") {
            ;(simDrillWake as { unref: () => void }).unref()
          }
        }
      }
    } catch {
      /* 无标记文件 */
    }
    if (!simActive && simDrillWake) {
      clear(simDrillWake)
      simDrillWake = null
    }
    // ③ 活跃循环的推进心跳：宿主可能整段静默（没有 DB 写入），但循环仍需在回合结束后
    //    继续。只有**未停**的目标存在时才排 60s 一次性 deadline；全部 stopped/无目标时
    //    不留任何定时器 —— 这正是 R2785 之后 bot6 不再被唤醒的关键。
    clear(loopHeartbeatWake)
    loopHeartbeatWake = null
    const ctl = readLoopCtl()
    const active = targets.some((sid) => !loopGateStopped(ctl, sid))
    if (active) {
      loopHeartbeatWake = setTimeout(() => {
        loopHeartbeatWake = null
        requestLoopTick("loop-heartbeat")
      }, 60_000)
      if (typeof (loopHeartbeatWake as { unref?: () => void }).unref === "function") {
        ;(loopHeartbeatWake as { unref: () => void }).unref()
      }
    }
  }
  // R2789：60s 兜底拍改为事件机。loop-ctl / tg-chats 状态文件用 fs.watch，宿主回合
  // 活动用 DB 变化事件，同进程模块用 loop:changed/state:changed。loopTick 保留
  // 原有的演练/心跳/目标评估/注册表落盘全部语义，只是不再靠固定间隔驱动。
  const loopTick = (reason: string): void => {
    try {
      // R210/R211 演练钩子（运营者已授权「错误重启模拟」）：仅当
      // /tmp/opencode/sim-err-restart 的内容等于本 run 的 GITHUB_RUN_ID 时命中，
      // 复刻错误出口（exit 0 → iterate.yml relay 自动重启 CI）。删除标记文件即永久失效。
      // R211 增加**年龄门（≥240s）**：上一版靠 nohup sleeper 延迟写标记，结果标记疑似
      // 根本没落盘（run 39143823566 跑满 5.5h 且全日志无演练行）——改为直接写标记 + 年龄门
      // 等待，等待期每拍打一行 marker present 日志，可现场验证钩子确实在跑。
      try {
        const simRaw = readFileSync(SIM_DRILL_PATH, "utf8").trim()
        if (simRaw !== "" && simRaw === String(process.env.GITHUB_RUN_ID ?? "")) {
          let simAgeS = 0
          try {
            simAgeS = Math.round((Date.now() - statSync(SIM_DRILL_PATH).mtimeMs) / 1000)
          } catch {
            simAgeS = 0
          }
          if (simAgeS < 240) {
            void log(
              "info",
              `auto-continue: SIM drill marker present (run=${simRaw}, age=${simAgeS}s < 240s) — waiting (age gate)`,
            )
          } else if (String(process.env.TG_BRIDGE_FORCE_SERVE ?? "") === "1") {
            void log(
              "info",
              `auto-continue: SIM err-restart drill (run=${simRaw}, age=${simAgeS}s) -> END-ROUND-CI (exit 0; workflow relay restarts CI)`,
            )
            endRunNow(`simulated error-restart drill (run=${simRaw})`)
            return
          }
        }
      } catch {
        /* 无标记文件：正常路径 */
      }
      // 桥的"死人开关"（见模块级注释）：只在**状态变化**时记一条，不刷屏。
      // 判据只用 bridgeLivenessState() 这**一个**来源 —— 不留两份实现
      // （两份判据迟早会分叉，而"心跳停滞"这种告警一旦分叉就无法判断该信谁）。
      const __bState = bridgeLivenessState()
      if (__bState !== "ok") {
        if (!bridgeStaleFlag) {
          bridgeStaleFlag = true
          void log(
            "error",
            `桥心跳停滞：${TG_STATE_PATH} ${
              __bState === "unreadable" ? "读不到" : `已超过 ${BRIDGE_STALE_S}s 未更新`
            } → TG 侧会完全静默，需人工看`,
          )
        }
      } else if (bridgeStaleFlag) {
        bridgeStaleFlag = false
        void log("info", `桥心跳恢复：${TG_STATE_PATH} 回到正常范围`)
      }
      void syncLoopMarker()
      void refreshLoopMarkerIfChanged()
      if ((globalThis as Record<string, unknown>)[AC_GEN_KEY] !== myGenAc) {
        // 过期实例不退出回调（事件仍可能到达），只留一次痕迹。真正的清理由
        // 代数守卫在每个事件入口完成。
        if (!loopSupersededLogged) {
          loopSupersededLogged = true
          void log(
            "info",
            `loop tick superseded (scope=${AC_SCOPE}, mine=${myGenAc}, current=${String((globalThis as Record<string, unknown>)[AC_GEN_KEY])})`,
          )
        }
        return
      }
      const sids = [...activeSidAt.keys()].filter((sid) => isLoopTarget(sid)).slice(-5)
      const targets = currentLoopTargets()
      // 多目标：每个 Bot 的前台会话都要评估（去重后），否则备用会话永远不会被驱动
      for (const target of targets) if (!sids.includes(target)) sids.push(target)
      // 熔断到期的目标会话也要进场；其它会话即使残留状态也不处理。
      try {
        const now = Date.now()
        for (const [sid, sk] of skipState) {
          if (!isLoopTarget(sid) || sk.reason !== "empty-stall-giveup" || sids.includes(sid)) continue
          const gc = giveupCount.get(sid) ?? 1
          const backoffMs = Math.min(90_000 * Math.pow(2, Math.max(0, gc - 1)), 30 * 60_000)
          if (now - (sk.ts ?? 0) > backoffMs && sids.length < 8) sids.push(sid)
        }
        for (const [sid, seenTs] of loopSeen) {
          if (!isLoopTarget(sid) || sids.includes(sid) || skipState.has(sid)) continue
          if (now - seenTs > 5 * 60_000 && now - (lastRoundAt.get(sid) ?? 0) > 15 * 60_000 && sids.length < 8) {
            sids.push(sid)
          }
        }
      } catch {
        /* best-effort */
      }
      for (const sid of sids) evaluateQueued(sid)
      persistLoopSessions()
      if (targets.length > 0 && Date.now() - lastScopedLogAt > 30 * 60_000) {
        lastScopedLogAt = Date.now()
        void log("info", `auto-continue: scoped target check (${targets.map((t) => t.slice(0, 12)).join(", ")}, reason=${reason})`)
      }
      armLoopWatchdogs(targets)
    } catch {
      /* best-effort: 任何一次事件失败都不能让事件机停摆；60s 后重试一次（退避，不是轮询） */
      setTimeout(() => requestLoopTick("loop-error-retry"), 60_000)
    }
  }

  // R2660：宿主实测**不发 session.idle**（旧注释已记录"zero evals"），终态
  // message.updated 也常常缺席；但 session_v2.time_idle 在回合结束后 ~1s 内更新
  // （tg-bridge R2648b 同源实证）。列表查询只取几十行元数据，1.5s 一次远轻于
  // session.messages；发现 idle 跃迁就快速评估，把「回合结束→注入」从 ≤64s 压到数秒。
  const idleSeen = new Map<string, number>()
  let idleWatchBusy = false
  let idlePending = false
  let idleLastAt = 0
  let idleWake: ReturnType<typeof setTimeout> | null = null
  // R2789：1.5s 定时拍改为 “DB 变化事件 + 1.5s 尾随去抖”。宿主写 DB 才探测；
  // 空闲时没有定时器。运行中到达的新事件合并成一次 pending 重跑。
  const idleProbe = async (): Promise<void> => {
    if ((globalThis as Record<string, unknown>)[AC_GEN_KEY] !== myGenAc) return
    if (idleWatchBusy) {
      idlePending = true
      return
    }
    if (currentLoopTargets().length === 0) return
    idleWatchBusy = true
    idleLastAt = Date.now()
    try {
      const res = await (client.session as any).list?.({})
      const rows = Array.isArray(res?.data) ? (res.data as any[]) : []
      for (const row of rows) {
        const sid = String(row?.id ?? "")
        if (!sid || !isLoopTarget(sid)) continue
        const idle = Number(row?.time?.idle ?? 0)
        if (!(idle > 0) || idle <= (idleSeen.get(sid) ?? 0)) continue
        idleSeen.set(sid, idle)
        // 热重载/重启后列表里已有旧 idle：只认本实例启动之后的回合；
        // 旧回合即使错过，后续 DB/状态事件仍会评估（不会永久饿死）。
        if (idle < AC_BOOT_AT) continue
        // 这是宿主权威的回合边界：死回合判据用它提前放行（见 noteHostIdle）。
        noteHostIdle(sid, idle)
        scheduleFastEval(sid)
      }
      if (idleSeen.size > 64) {
        const cutoff = Date.now() - 24 * 3600_000
        for (const [sid, ts] of idleSeen) if (ts < cutoff) idleSeen.delete(sid)
      }
    } catch {
      /* best-effort：列表查询失败时等下一次 DB/状态事件 */
    } finally {
      idleWatchBusy = false
      if (idlePending) {
        idlePending = false
        // 必须仍走 1.5s 最小间隔：连续 DB 写入时不能退化成紧循环。
        scheduleIdleProbe()
      }
    }
  }
  const scheduleIdleProbe = (delay?: number): void => {
    if ((globalThis as Record<string, unknown>)[AC_GEN_KEY] !== myGenAc) return
    const gap = Math.max(0, 1_500 - (Date.now() - idleLastAt))
    const wait = Math.max(0, Number(delay ?? gap) || 0)
    if (idleWake) clearTimeout(idleWake)
    idleWake = setTimeout(() => {
      idleWake = null
      void idleProbe()
    }, wait)
    if (typeof (idleWake as { unref?: () => void }).unref === "function") {
      ;(idleWake as { unref: () => void }).unref()
    }
  }

  // R2789：所有唤醒（状态文件、DB、进程内事件）进同一条串行队列：
  //   · "loop" 合并重复唤醒，只跑一次完整 tick；
  //   · "idle" 仍用 1.5s 尾随去抖，但只在 DB 真变化时触发。
  const eventQueue = taskQueue("auto-continue:events")
  let loopTickAt = 0
  let loopWake: ReturnType<typeof setTimeout> | null = null
  let loopWakeAt = 0
  // R2789：完整 tick 会评估每个目标（读会话/可能注入），绝不能每个 DB 写入都跑。
  //  · 关键事件（loop-ctl / loop:changed / boot）1s 内合并执行；
  //  · 状态文件变化只安排一次 60s 慢速兜底（真正的即时通道是 loop:changed）；
  //  · DB 变化只驱动轻量 idleProbe（1.5s），回合结束才 scheduleFastEval。
  const requestLoopTick = (reason: string, minGapMs = 1_000): void => {
    if (!eventGenOK()) return
    const wait = Math.max(0, minGapMs - (Date.now() - loopTickAt))
    const due = Date.now() + wait
    // 已有更早的唤醒就保留；已有更晚的则被这次关键事件提前。
    if (loopWake && loopWakeAt <= due) return
    if (loopWake) {
      try {
        clearTimeout(loopWake)
      } catch {
        /* ignore */
      }
    }
    loopWakeAt = due
    const why = reason
    loopWake = setTimeout(() => {
      loopWake = null
      loopWakeAt = 0
      if (!eventGenOK()) return
      eventQueue.push("loop", () => {
        loopTickAt = Date.now()
        loopTick(why)
      })
    }, wait)
    if (typeof (loopWake as { unref?: () => void }).unref === "function") {
      ;(loopWake as { unref: () => void }).unref()
    }
  }
  const requestSlowLoopTick = (reason: string): void => requestLoopTick(reason, 60_000)
  const requestIdleProbe = (): void => {
    if (!eventGenOK()) return
    // 事件只负责“叫醒”，1.5s 采样门由 scheduleIdleProbe 统一保证。
    scheduleIdleProbe()
  }
  offOwner("auto-continue:files")
  // 状态文件（tg-chats-*.json）流式期间会被高频落盘；这里只做缓存失效 + 慢速兜底，
  // 不让“保存一次状态”变成“完整评估一次循环”。
  for (const path of ALL_STATE_PATHS) {
    watchFile(
      path,
      () => {
        if (!eventGenOK()) return
        invalidateStateCaches()
        requestSlowLoopTick(`file:${path.split("/").pop() ?? "state"}`)
        requestIdleProbe()
      },
      { owner: `auto-continue:file:${path}`, ensure: true, scanOnStart: false },
    )
  }
  // 总闸/单 Bot 闸改变必须立即重评（停止要马上生效，启动要马上注入）。
  watchFile(
    LOOP_CTL_PATH,
    () => {
      if (!eventGenOK()) return
      invalidateStateCaches()
      requestLoopTick("file:loop-ctl")
      requestIdleProbe()
    },
    { owner: "auto-continue:loop-ctl", ensure: true, scanOnStart: false },
  )
  // 宿主 session_v2.time_idle / 消息终态都先落 DB；监听 DB/WAL 变化比固定 1.5s
  // 查询便宜得多，而且空闲时完全静默。DB 只触发轻量 idleProbe，不触发完整评估。
  watchFile(
    OPENCODE_DB_PATH,
    () => {
      if (!eventGenOK()) return
      requestIdleProbe()
    },
    {
      owner: "auto-continue:db",
      ensure: true,
      scanOnStart: false,
      match: (name) => name.startsWith("opencode.db"),
    },
  )
  // R2789：演练标记写入本身也是事件；年龄门由 armLoopWatchdogs 的一次性 deadline 补齐。
  watchFile(SIM_DRILL_PATH, () => requestLoopTick("sim-drill-file"), {
    owner: "auto-continue:sim-drill",
    ensure: true,
    scanOnStart: false,
  })
  on(
    "loop:changed",
    () => {
      if (!eventGenOK()) return
      invalidateStateCaches()
      requestLoopTick("loop:changed")
      requestIdleProbe()
    },
    "auto-continue",
  )
  loopTickAt = Date.now()
  eventQueue.push("loop", () => loopTick("boot"))

  return {
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const sidAll = (event.properties as { sessionID?: string })?.sessionID
        if (typeof sidAll === "string" && sidAll && isLoopTarget(sidAll)) touchSid(sidAll)
        const info = (event.properties as {
          info?: {
            role?: string
            sessionID?: string
            id?: string
            tokens?: { input?: number }
            error?: { name?: string } | string
            time?: { completed?: number }
            finish?: string
          }
        }).info
        const sid = info?.sessionID
        // R2660：终态 message.updated 是回合结束的即时信号（宿主对部分终态不发，
        // 所以还有 time_idle 监视器 + 60s tick 兜底）。tool-calls 是中间步骤，
        // 不触发快速评估，避免每个工具步骤都打一次 hold inject。
        if (info?.role === "assistant" && sid && isLoopTarget(sid)) {
          const completed = Number(info?.time?.completed ?? 0)
          const finish = String(info?.finish ?? "")
          if (completed > 0 && !/tool[-_]calls/i.test(finish)) scheduleFastEval(sid)
        }
        if (info?.role === "assistant") {
          const err: any = info.error
          if (isAbortSignal(err)) {
            // R1553：ESC/宿主中断 = 仅暂停该会话本轮（per-session skipState），
            // 不写全局 loop-ctl 硬闸；该会话下一条用户消息自然恢复，其他会话照常。
            if (sid) {
              skipState.set(sid, { lastId: String(info?.id ?? ""), reason: "user-abort-pause" })
              evaluateQueued(sid)
            }
            noteAbortEvent({
              ts: Date.now(),
              session: sid ?? "",
              name: String(err?.name ?? err?.type ?? "unknown"),
              verdict: "pause",
              fresh: true,
              userAfter: false,
              src: "serve-event",
            })
            await log("info", `auto-continue: assistant interrupted; session pause persisted per-session (${sanitizeLog(sid).slice(0, 12)})`)
            return
          }
        }
        // R2607 尾款：与 tg-bridge ctxTotal / tokenSumOf 统一为五字段口径
        // （同文件另一处 usage.set 的注释详述缘由）。
        const tk = (info as any)?.tokens
        const winNow = tokenSumOf(tk)
        if (info?.role === "assistant" && sid && winNow > 0) {
          usage.set(sid, winNow)
        }
        return
      }
      if (event.type === "session.created") {
        try {
          await client.app.log({ body: { service: "auto-continue", level: "info", message: `[auto-continue] session.created fingerprint (version=${VERSION}, source=${SOURCE})` } })
        } catch (err) {
          /* ignore */
        }
        return
      }
      if (event.type === "session.deleted") {
        const sid = (event.properties as { info?: { id?: string } }).info?.id
        if (sid) {
          queue.delete(sid)
        }
        return
      }
      if (event.type === "session.status") {
        // R2660：宿主若发这个事件，idle 就是权威的"agent loop 已结束"。实测可能不发，
        // 所以它只是快速路径之一，不替代 time_idle 监视器与 60s tick。
        const p = event.properties as { sessionID?: string; status?: { type?: string } }
        const sid = p?.sessionID
        if (sid && String(p?.status?.type ?? "") === "idle" && isLoopTarget(sid)) {
          noteHostIdle(sid)
          scheduleFastEval(sid)
        }
        return
      }
      if (event.type !== "session.idle") return
      const sid = (event.properties as { sessionID?: string }).sessionID
      if (sid && isLoopTarget(sid)) {
        noteHostIdle(sid)
        scheduleFastEval(sid)
      }
    },
  }
}
