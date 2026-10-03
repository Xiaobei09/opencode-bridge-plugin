import type { Plugin } from "@opencode-ai/plugin"
import type { AssistantMessage } from "@opencode-ai/sdk"
import { statSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { readSessionUsage, resetSessionTokens, sessionTokens, compactUnavailableNow, readRecentUserTexts } from "./_v2compat"
// 自动停止守卫的判据与配置读写放在共享模块（tg-bridge 的菜单也要用同一份，避免两边漂移）。
import { readGuard, detectGuardSignals, guardVerdict, noteGuardTrip, loopPauseDecl } from "./loop-guard"

const MAX_TRACKED = 1024
const RETRY_MS = [3000, 6000]
const CONTEXT_WINDOW = 1_048_576
const COMPACT_THRESHOLD = 0.7
const COMPACT_EVERY = 450
const ABORT_STALE_MS = 3 * 60 * 1000
const STALL_SESSION_MSGS = 600

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
const VERSION = "r1051-loop-merge"
const LOOP_TITLE_MARK = "[LOOP]"
const stripLoopTitle = (title: string): string => {
  let out = String(title ?? "").trim()
  while (out.endsWith(LOOP_TITLE_MARK)) out = out.slice(0, -LOOP_TITLE_MARK.length).trim()
  return out
}
const AC_GEN_KEY = process.env.AC_GEN_KEY ?? "__acGen"
const PRIVATE_FILE_MODE = 0o600

// 记录“被本插件打过 [LOOP] 标记的会话”集合。热重载后内存态丢失，若不落盘，
// 旧目标上的 [LOOP] 会永久残留成假标记。集合而非单值：历史上可能同时存在
// 多个被标记会话，换目标后要把它们全部清掉。
const MARKER_STATE_PATH = process.env.AC_MARKER_PATH ?? "REDACTED_ROOT/.config/opencode/loop-marker.json"
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
    writeFileSync(MARKER_STATE_PATH, JSON.stringify({ sids: clean, ts: Date.now() }), {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
    })
  } catch {
    /* best-effort */
  }
}

const LOOP_CTL_PATH = "REDACTED_ROOT/.config/opencode/loop-ctl.json"
const LOOP_CTL_LEGACY = "/tmp/opencode/loop-ctl.json"
// 能不能往"当前这条助手消息"注入下一轮 —— 判据，纯函数便于行为测试。
// 背景：用户报「AI 明明没有主动结束，却已经注入循环了，这种情况经常发生」。
// 根因不是"判据写错"，而是**根本没有判据**：HUNG-TURN 那段注释写着"循环也不该往
// 活着的回合里注入"，可 len>0 的正常路径一路走到 inject()，从不看 time.completed
// —— 流式中的消息一旦有了文字就被当成本轮结束。
// 为什么 completed 是唯一可靠的信号：opencode 的宿主侧回合结束**就是**给最后一条
// assistant 消息写 time.completed（tg-bridge 的 pumpInject 也用同一个信号等空闲）。
// 刻意**不**提供"陈旧兜底"（例如超过 N 分钟就强行注入）：往一个卡住的回合里注入，
// 宿主不会消费它，只会在它自己的队列里越积越多（实测卡住那一轮积了 4 条发不出去）。
// 卡住由 HUNG-TURN 如实上报，不靠继续投喂来"解决"。
export const injectGateVerdict = (
  completed: number,
  updated: number,
  now: number,
): { go: boolean; why: string } => {
  if (completed > 0) return { go: true, why: "completed" }
  if (!(updated > 0) || !Number.isFinite(updated)) return { go: false, why: "no-updated-ts" }
  const ageS = Math.max(0, Math.round((now - updated) / 1000))
  return { go: false, why: `in-flight-${ageS}s` }
}

// 旧判据曾是子串正则 LOOP_PAUSE_RE，**报告里提及标记就会停机**（真实事故：
// 2026-09-28 01:57:32，报告里写「与 `[LOOP:PAUSE]` 同一条恢复路径」就把循环停了）。
// 现在判据在 loop-guard.ts（loopPauseDecl）：独占一行 + 围栏/行内代码挖空 —— 靠判据，
// 不靠"写报告时记得拆写"的纪律。
const readCtl = (): any => {
  for (const p of [LOOP_CTL_PATH, LOOP_CTL_LEGACY]) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as any
      if (j && typeof j === "object") return j
    } catch {
      /* try next */
    }
  }
  return {}
}
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
const writeCtlStopped = (stopped: boolean, by: string, reason = ""): void => {
  if (!ownsCtlWriter()) return
  try {
    writeFileSync(LOOP_CTL_PATH, JSON.stringify({ stopped, by, reason, ts: Date.now() }), { encoding: "utf8", mode: PRIVATE_FILE_MODE })
  } catch {
    /* best-effort */
  }
}
// /quiet 压缩设置（tg-bridge 写入 tg-chats.json，本侧 10 秒 TTL 读取）：auto=false 停掉一切自动压缩
const TG_STATE_PATH = process.env.AC_TG_STATE_PATH ?? "REDACTED_ROOT/.config/opencode/tg-chats.json"

// ── 桥的"死人开关"（2026-09-26）────────────────────────────────────────────
// 缺口：桥若整个挂掉，**它自己的心跳也没了** —— `state save heartbeat` 是桥写的，
// 桥死了就只剩沉默，用户侧表现为"机器人不响了"而**无人知晓**。
// auto-continue 是**独立服务**（R979 发现有两个入口两个服务），桥死了它还在，正好当这个开关。
// 判据用**桥写的状态文件 mtime**：实测落盘规律（心跳 last 在 3–118s 之间），
// 阈值 300s 足够宽松，不会误报；文件读不到也算异常。
// ⚠️ 本函数刻意**不调用 log**（log 定义在工厂内，模块级调用会 TS2304 —— 今天已踩过一次），
//    只做纯计算并返回年龄（秒）；由工厂内的 acTimer 负责记日志。
export const BRIDGE_STALE_S = 300
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
const isSessionID = (v: unknown): v is string =>
  typeof v === "string" && /^ses_[A-Za-z0-9_-]+$/.test(v)
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
// 订阅（实测主实例定时器直接不触发，排查成本极高）。一个定时器 + 多个目标没有这个问���。
// 附加目标由 AC_EXTRA_TARGETS 指定（逗号分隔的状态文件路径），各自 front 优先、pinned 兜底。
const EXTRA_TARGET_PATHS = (process.env.AC_EXTRA_TARGETS ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter((x) => x.startsWith("/"))
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
// R1107：用户主动中断（⏹ doStop 成功）的会话。halted 逐会话持久化在各 Bot 状态文件的
// halted 数组里（tg-bridge 侧 doStop → savePersistedState）。auto-continue 必须尊重它，
// 否则"用户主动终止后循环仍继续"。不清共享总闸 → 其它会话/Bot 不受影响；用户新消息
//（pump 投递成功）或 /loop start 会清除 halted。2s 缓存避免每次 eval 都重读文件。
let haltedSessionsCache = { ts: 0, sids: [] as string[] }
const haltedSessions = (): string[] => {
  const now = Date.now()
  if (now - haltedSessionsCache.ts < 2_000) return haltedSessionsCache.sids
  const out: string[] = []
  for (const p of [TG_STATE_PATH, ...EXTRA_TARGET_PATHS]) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as any
      const hl = Array.isArray(j?.halted) ? (j.halted as unknown[]) : []
      for (const s of hl) if (typeof s === "string" && s.startsWith("ses_") && !out.includes(s)) out.push(s)
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
    const j = JSON.parse(readFileSync("REDACTED_ROOT/.config/opencode/tg-chats.json", "utf8")) as any
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
const readCompactPrefs = (): { auto: boolean; threshold: number } => {
  try {
    const j = JSON.parse(readFileSync(TG_STATE_PATH, "utf8")) as any
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
  String(s).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200)

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

const errorName = (m: AssistantMessage): string => {
  const e = m?.error as any
  if (!e || typeof e !== "object") return "unknown"
  return String(e.name ?? e.type ?? "unknown")
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
    // TUI 不跑续跑循环，但必须把 ESC/宿主 interrupt 立即写成全局停门；
    // 否则服务侧只能等下一次评估，GUI 看起来像“按了也没停”。
    return {
      event: async ({ event }: any) => {
        if (event?.type !== "message.updated") return
        const props: any = event?.properties ?? {}
        const info: any = props?.info ?? props
        const err: any = info?.error
        const signal = typeof err === "string" ? err : `${err?.name ?? ""} ${err?.type ?? ""} ${err?.message ?? ""}`
        if (info?.role === "assistant" && isAbortSignal(err) && /aborted|interrupt/i.test(signal)) {
          writeCtlStopped(true, "user", "GUI/TUI interrupt")
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
  const pending = new Map<string, number>()
  const emptyStreak = new Map<string, number>()
  // 已回源核对过的消息（避免同一条反复打 API）
  const refetchedEmpty = new Set<string>()
  // 粘性"这是循环会话"标志：此前循环资格只靠**用户消息里的关键字**（筛查循环 / [STATUS: /
  // 合成提示）点亮 —— 对话术不同的第二个会话（另一个项目）随时可能因没有匹配而被判
  // "不是循环会话"→不再续跑，表现为"另一个会话总是不循环"。
  // 安全性：isLoopTarget 已把范围限制在"各 Bot 自己的 front/pinned"，粘性标志不可能
  // 让循环去驱动无关会话；停止仍走 /loop stop（全局闸）。
  const LOOP_SESSIONS_PATH = "REDACTED_ROOT/.config/opencode/loop-sessions.json"
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
  const LOOP_OFF_PATH = "REDACTED_ROOT/.config/opencode/loop-sessions-off.json"
  const loopOffSessions = new Set<string>()
  try {
    const arr = JSON.parse(readFileSync(LOOP_OFF_PATH, "utf8"))
    if (Array.isArray(arr)) for (const x of arr) if (typeof x === "string" && x.startsWith("ses_")) loopOffSessions.add(x)
  } catch {
    /* first run */
  }
  const persistLoopOff = (): void => {
    try {
      writeFileSync(LOOP_OFF_PATH, JSON.stringify([...loopOffSessions].slice(-16)), {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
      })
    } catch (err) {
      void log("error", `loop off list persist failed: ${sanitizeLog(err).slice(0, 100)}`)
    }
  }

  let loopSessionsDirty = false
  const persistLoopSessions = (): void => {
    if (!loopSessionsDirty) return
    loopSessionsDirty = false
    const keep = mergeLoopRegistry(loopSessions, currentLoopTargets(), 8)
    try {
      writeFileSync(LOOP_SESSIONS_PATH, JSON.stringify(keep), { encoding: "utf8", mode: PRIVATE_FILE_MODE })
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
  let prefsCache = { ts: 0, auto: true, threshold: COMPACT_THRESHOLD }
  const skipState = new Map<string, { lastId: string; reason: string; ts?: number }>()
  const queue = new Map<string, Promise<void>>()
  const usage = new Map<string, number>()
  // ctx 超阈值但压缩不可用时，每个会话只提示一次
  const ctxWarned = new Set<string>()
  const deferLoggedAt = new Map<string, number>()
  const sharedTargetLogAt = new Map<string, number>()
  // Telegram 注入队列里该会话还排着几条用户消息（用户优先，循环不得抢跑）
  const pendingUserInjects = (sessionID: string): number => {
    try {
      const j = JSON.parse(readFileSync(TG_STATE_PATH, "utf8")) as any
      const arr = Array.isArray(j?.pinqueue) ? j.pinqueue : []
      let n = 0
      for (const it of arr) if (String(it?.sid ?? "") === sessionID) n++
      return n
    } catch {
      return 0
    }
  }
  // 被注入闸拦下的时刻（诊断用：连续拦多久 = 宿主侧回合卡了多久）
  const heldInject = new Map<string, number>()
  const fatalStreak = new Map<string, number>()
  const coldCompacted = new Set<string>()
  const lastCompactCount = new Map<string, number>()
  const lastCompactAttempt = new Map<string, number>()
  // R-pending：宿主在部分事件里会把"会话生命周期累计 token"报成 input
  // （实测 f339 报 ~24.9M / 窗口 1M = 2490%，tg-bridge 的 ctxUsage 早已 reject 同族值）。
  // 误用累计值判压缩会**强压还有大量 headroom 的会话、清空其上下文** —— 用户视角就是
  // "这个 bot 的自动循环没了"。守卫：单次调用输入不可能超过窗口，超过即累计值，丢弃。
  let ctxLifetimeRejected = 0
  const COMPACT_RETRY_MS = 30 * 60_000
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

  const markerApplied = new Map<string, string>()
  const applyMarker = async (sessionID: string, enabled: boolean): Promise<void> => {
    // R1832：换代护栏（唯一写入入口统一拦截，理由见 live v2lib/auto-continue.ts 同名注释）。
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
    const desired = enabled ? `${base}${base ? " " : ""}${LOOP_TITLE_MARK}` : base
    if (desired === title) {
      markerApplied.set(sessionID, desired)
      if (enabled && !readMarkedSids().includes(sessionID)) writeMarkedSids([...readMarkedSids(), sessionID])
      return
    }
    if (markerApplied.get(sessionID) === desired) return
    try {
      await update.call(sessionAny, { path: { id: sessionID }, body: { title: desired || "未命名会话" } })
      markerApplied.set(sessionID, desired)
      const marked = readMarkedSids().filter((x) => x !== sessionID)
      writeMarkedSids(enabled ? [...marked, sessionID] : marked)
      await log("info", `loop title marker ${enabled ? "enabled" : "removed"} (session=${sanitizeLog(sessionID).slice(0, 12)})`)
    } catch (err) {
      await log("error", `loop title marker failed (session=${sanitizeLog(sessionID).slice(0, 12)}): ${sanitizeLog(err).slice(0, 120)}`)
    }
  }

  const syncLoopMarker = async (sessionID = currentLoopTarget()): Promise<void> => {
    if (!sessionID || !isSessionID(sessionID)) return
    let enabled = true
    try {
      enabled = readCtl()?.stopped !== true
    } catch {
      enabled = true
    }
    await applyMarker(sessionID, enabled)
  }

  let markerLastSig = ""
  const refreshLoopMarkerIfChanged = (): void => {
    const cur = currentLoopTarget()
    let state = "running"
    try {
      if (readCtl()?.stopped === true) state = "stopped"
    } catch {
      /* keep default */
    }
    const sig = `${cur}:${state}`
    // 目标切换/停止后，凡不是当前目标的被标记会话都要清掉 [LOOP]，
    // 否则会留下“仍在循环”的假标记。集合来自落盘状态，热重载后照样生效。
    // 放在 sig 判断之前：落盘状态可能在本进程启动后才被补写（例如修复残留），
    // 此时 sig 未变，但残留标记仍需清掉。清理后集合即收敛为空，不会反复调 API。
    for (const sid of readMarkedSids()) {
      if (cur && sid === cur) continue
      void applyMarker(sid, false)
    }
    if (sig === markerLastSig) return
    markerLastSig = sig
    void syncLoopMarker(cur)
  }
  setTimeout(() => {
    refreshLoopMarkerIfChanged()
  }, 1000)
  const markerTimer = setInterval(() => {
    if ((globalThis as Record<string, unknown>)[AC_GEN_KEY] !== myGenAc) {
      clearInterval(markerTimer)
      return
    }
    refreshLoopMarkerIfChanged()
  }, 5000)

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

  // 「本宿主不可压缩」是**已知的宿主永久限制**，不是错误。
  // 记成 error 的代价很具体：今晚的错误清扫里，这 4 条占了 16 条 error 的 1/4，
  // 而真正该立刻注意的 error 会被淹没 —— 把常态记成异常，等于训练自己忽略异常。
  // 事实本身 compat 已经用 info 记过一次，这里只标成"已知限制"且**每会话只记一次**。
  const compactLimitLogged = new Set<string>()
  const isCompactUnsupported = (e: unknown): boolean =>
    /compact unavailable|no ctx\.session\.compact|missing.*compact/i.test(String((e as any)?.message ?? e))
  const logCompactUnsupported = async (sessionID: string, why: string): Promise<void> => {
    if (compactLimitLogged.has(sessionID)) return
    compactLimitLogged.add(sessionID)
    await log(
      "info",
      `auto-continue: compact 不可用（已知宿主限制，非错误；改用 /migrate 或开新会话）` +
        `(session=${sanitizeLog(sessionID)}): ${sanitizeLog(why).slice(0, 140)}`,
    )
  }
  const compactNow = async (sessionID: string, reason: string): Promise<boolean> => {
    // 宿主未开放压缩入口时直接放弃：compat 已经打过一次原因日志，
    // 这里再报错只会每次评估刷一行噪音（陈旧实例/边界评估都会触发）。
    if (compactUnavailableNow()) return false
    try {
      // 优先走宿主自带认证的内部通道；本地裸 HTTP 无票必 401，只做兜底
      const base = (client as unknown as { _client?: { post?: (o: any) => Promise<unknown> } })._client
      if (base?.post) {
        try {
          await base.post({ url: `/api/session/${encodeURIComponent(sessionID)}/compact` })
          await log("info", `auto-continue: compacted session=${sanitizeLog(sessionID)} (${reason})`)
          return true
        } catch (err) {
          await log("error", `auto-continue: compact via _client failed: ${sanitizeLog(err).slice(0, 160)}`)
        }
      }
      const compatCompact = (client as unknown as { session?: { compact?: (o: any) => Promise<unknown> } }).session?.compact
      if (typeof compatCompact === "function") {
        await compatCompact({ path: { id: sessionID } })
        await log("info", `auto-continue: compacted session=${sanitizeLog(sessionID)} (${reason})`)
        return true
      }
      if (!base?.post) {
        await logCompactUnsupported(sessionID, "宿主既无 ctx.session.compact 也无可用通道")
        return false
      }
      await base.post({ url: `/api/session/${encodeURIComponent(sessionID)}/compact` })
      await log("info", `auto-continue: compacted session=${sanitizeLog(sessionID)} (${reason})`)
      return true
    } catch (err) {
      if (isCompactUnsupported(err)) {
        await logCompactUnsupported(sessionID, sanitizeLog(err).slice(0, 120))
        return false
      }
      await log("error", `auto-continue: compact failed (session=${sanitizeLog(sessionID)}): ${sanitizeLog(err)}`)
      return false
    }
  }

  const maybeCompact = async (sessionID: string, usage: number, assistantCount: number): Promise<void> => {
    if (CONTEXT_WINDOW <= 0) return
    const nowMs = Date.now()
    if (nowMs - prefsCache.ts > 10_000) prefsCache = { ts: nowMs, ...readCompactPrefs() }
    if (!prefsCache.auto) return
    const TH = prefsCache.threshold
    const last = lastCompactCount.get(sessionID) ?? 0
    // 窗口口径必须是「最近一次请求的输入」，不是生命周期累计。
    // session_v2.tokens_* 在当前宿主是累计值（f339 已 16.1M），拿它比 1M 窗口
    // 会永远判超限 → 每 30 分钟撞一次注定失败的压缩。事件口径才是真实窗口。
    let u = Number(usage)
    let uSrc = "event"
    // R-pending：口径守卫（与 tg-bridge 同族）。事件 input 被宿主报成寿命累计值时
    // u > CONTEXT_WINDOW（单次调用输入不可能超过模型窗口）→ 判为累计值，丢弃并退回 ledger。
    let rejectedLifetime = false
    if (Number.isFinite(u) && u > CONTEXT_WINDOW) {
      rejectedLifetime = true
      ctxLifetimeRejected++
      if (ctxLifetimeRejected <= 5 || ctxLifetimeRejected % 50 === 0) {
        await log(
          "error",
          `auto-continue: ctx usage rejected (lifetime counter, not window): sid=${sanitizeLog(sessionID).slice(0, 12)} u=${Math.round(u)} win=${CONTEXT_WINDOW} (rejected x${ctxLifetimeRejected})`
        )
      }
    }
    try {
      const db = await readSessionUsage(sessionID)
      const cum = db ? db.input + db.output + db.reasoning : 0
      if ((!(u > 0) || rejectedLifetime) && cum > 0 && cum < CONTEXT_WINDOW) {
        u = cum
        uSrc = rejectedLifetime ? "ledger(rejected)" : "ledger"
      } else if (rejectedLifetime) {
        // 事件是累计值、ledger 也不可信：放弃本轮回压缩，交由宿主自身自动压缩。
        u = 0
        uSrc = "rejected"
      }
    } catch {
      /* keep event value */
    }
    if (Number.isFinite(u) && u > 0 && u / CONTEXT_WINDOW >= TH) {
      if (compactUnavailableNow()) {
        // 超阈值但本宿主没有压缩入口：只提示一次，随后交给宿主自身自动压缩。
        if (!ctxWarned.has(sessionID)) {
          ctxWarned.add(sessionID)
          const pctNow = Math.round((u / CONTEXT_WINDOW) * 100)
          await log(
            "info",
            `auto-continue: WARN ctx=${pctNow}% >= ${Math.round(TH * 100)}% but compact unavailable in this host; relying on host auto-compaction`
          )
        }
        return
      }
      const lastTry = lastCompactAttempt.get(sessionID) ?? 0
      if (Date.now() - lastTry < COMPACT_RETRY_MS) return
      lastCompactAttempt.set(sessionID, Date.now())
      lastCompactCount.set(sessionID, assistantCount)
      const usagePct = Math.round((u / CONTEXT_WINDOW) * 100)
      if (await compactNow(sessionID, `ctx=${usagePct}% >= ${Math.round(TH * 100)}%`)) resetSessionTokens(sessionID)
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
      Number.isFinite(u) && u > 0 ? ((u / CONTEXT_WINDOW) * 100 < 1 ? "<1%" : `${Math.min(100, Math.round((u / CONTEXT_WINDOW) * 100))}%`) : "unknown"
    const compactNote = compactUnavailableNow() ? " (compact unavailable: /migrate instead)" : ""
    await log(
      "info",
      `auto-continue: eval session=${sanitizeLog(sessionID)} msgs=${assistantCount} ctx=${uTxt} src=${uSrc} (next compact ~${nxtMsg} msgs, no compact)${compactNote}`
    )
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
      writeFileSync(CLAIM_PATH, JSON.stringify(j), { encoding: "utf8", mode: PRIVATE_FILE_MODE })
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
        writeFileSync(CLAIM_PATH, JSON.stringify(j), { encoding: "utf8", mode: PRIVATE_FILE_MODE })
      }
    } catch {
      /* best-effort */
    }
  }
  // 注入闸的唯一入口。返回 false 时**不做任何状态变更**（不 settle、不计数），
  // 这样这一轮仍然算"未处理"：宿主把回合标记 completed 后会有新事件再次评估。
  // ⚠️ 这里的 session id **必须打全**，不能 `slice(0,12)`：相邻的
  // `injected round prompt (session=<完整 id>)` 与 `eval session=<完整 id>` 都是全的。
  // R1020 实测：只有这一行是 12 位 → 统计脚本按等值连接时，会话级数据全成假数
  // （每个会话都显示"100% 拦截 / 0% 注入"）。**同一份信息在相邻日志行里两种写法，
  // 迟早让人连不上** —— 与其在分析脚本里做前缀匹配，不如把日志本身统一。
  const injectAllowed = async (sid: string, m: any, tag: string): Promise<boolean> => {
    const t = (m as any)?.time ?? {}
    const v = injectGateVerdict(Number(t.completed ?? 0), Number(t.updated ?? t.created ?? 0), Date.now())
    if (v.go) return true
    heldInject.set(sid, Date.now())
    await log(
      "info",
      `auto-continue: hold inject (${tag}, session=${sanitizeLog(sid)}, msg=${String(m?.id ?? "").slice(0, 20)}, ` +
        `${v.why}) —— 回合未结束，不往活着的回合里注入（等 completed 事件再来判）`,
    )
    return false
  }

  const inject = async (
    sessionID: string,
    msg: AssistantMessage,
    text: string,
    kind: "round" | "recover"
  ): Promise<"ok" | "backoff" | "duplicate" | "stopped" | "deferred"> => {
    // 评估与实际 promptAsync 之间仍可能发生 ESC/主动停止；发送前再过一道总闸。
    if (readCtl()?.stopped === true) {
      await log("info", `auto-continue: ${kind}-inject suppressed before claim (session=${sanitizeLog(sessionID)})`)
      return "stopped"
    }
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
    if (!claimInject(sessionID, msg.id)) {
      await log("info", `auto-continue: ${kind}-inject duplicate suppressed (session=${sanitizeLog(sessionID)}, msg=${sanitizeLog(msg.id)})`)
      return "duplicate"
    }
    // 用户指令：排队内容单独注入，不拼进循环文本（搭便车已下线）
    try {
      // claim 后、真正触网前再检查一次，避免 stop 落在 await/调度间隙。
      if (readCtl()?.stopped === true) {
        unclaimInject(sessionID, msg.id)
        await log("info", `auto-continue: ${kind}-inject suppressed after claim (session=${sanitizeLog(sessionID)})`)
        return "stopped"
      }
      // promptAsync 同样可能挂起 —— 一次挂起就会堵死该会话的整条评估链（见 evaluateQueued）。
      await withTimeout(
        client.session.promptAsync({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text }] },
        }),
        "session.promptAsync",
      )
      // promptAsync 返回不等于回合已经启动完成；若停止在调用期间到达，立即补发中断。
      if (readCtl()?.stopped === true) {
        try {
          await (client.session as any).interrupt?.({ path: { id: sessionID } })
        } catch {
          /* best-effort */
        }
        unclaimInject(sessionID, msg.id)
        await log("info", `auto-continue: ${kind}-inject interrupted by stop gate (session=${sanitizeLog(sessionID)})`)
        return "stopped"
      }
      return "ok"
    } catch (err) {
      unclaimInject(sessionID, msg.id)
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
  let skipHaltedLogAt = 0
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
        if (Date.now() - skipHaltedLogAt > 60_000) {
          skipHaltedLogAt = Date.now()
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
          writeFileSync(ownerPath, JSON.stringify({ ...j, ac: { id: myAcId, ts: Date.now() } }), { encoding: "utf8", mode: PRIVATE_FILE_MODE })
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
          // 窗口占用 = input + cache.read。缓存命中的会话里 cache.read 才是大头
          // （f339 实测 in=664 / cr=214k），只看 input 会把 21% 报成 <1%，
          // 与 tg-bridge 的 ctx 后缀口径不一致，压缩阈值也因此失真。
          const tk = (m.info as any)?.tokens
          const tIn = Number(tk?.input)
          const tCr = Number(tk?.cache?.read)
          const win = (Number.isFinite(tIn) ? tIn : 0) + (Number.isFinite(tCr) ? tCr : 0)
          if (win > 0) usage.set(sessionID, win)
        }
        // 只有真实用户消息才能登记循环；助手报告和自动注入的 ROUND/RECOVER
        // 不得把其它历史会话误判为循环会话。
        if (
          !loopOffSessions.has(sessionID) &&
          m.info?.role === "user" &&
          (isSyntheticPrompt(t) || t.includes("筛查循环") || /\[\s*STATUS\s*:/.test(t))
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
          if (!isNeutralUserText(t) && !isSyntheticPrompt(t)) {
            latestUserText = t
            if (Number.isFinite(created) && created > newestUserTs) newestUserTs = created
          }
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
        if (loopStoppedSkip && loopStoppedSkip.reason === "loop-stopped") {
          let gateOpen = false
          try {
            gateOpen = (readCtl()?.stopped ?? false) !== true
          } catch {
            gateOpen = true
          }
          if (gateOpen) {
            skipState.delete(sessionID)
            await log(
              "info",
              `auto-continue: loop-stopped skip cleared (gate reopened, session=${sanitizeLog(sessionID).slice(0, 12)})`
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
        const ctl = readCtl()
        if (ctl?.stopped === true) {
          // 停止是硬闸：只有桥接的显式 `/loop start` 才能解除。
          // 任意普通用户消息（包括含“循环”字样的历史消息）都不得自动复活自动续跑。
          skipState.set(sessionID, { lastId: newestId, reason: "loop-stopped" })
          await log("info", `auto-continue: eval session=${sanitizeLog(sessionID)} msgs=${assistantCount} -> SKIP(loop stopped by=${ctl?.by ?? "?"}${ctl?.reason ? ` reason=${sanitizeLog(ctl.reason).slice(0, 80)}` : ""}, /loop start to resume)`)
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
          await log("info", `auto-continue: eval session=${sessionID} msgs=${assistantCount} -> CONTINUE(user-active, loop keeps running until /loop stop)`)
        }
      }
      // dormant 跳过已取消：用户主动停止之前一直循环（空会话由 empty-stall 熔断兜底）。
      const { info: msg } = lastAssistant

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
                `auto-continue: eval session=${sanitizeLog(sessionID)} -> HUNG-TURN(宿主侧回合未完成且已 ${ageMin} 分钟无更新; ${why}) —— 桥无法代为完成或中断, 请在该会话里手动中断/重试, 循环不注入以免打断它`,
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

      if (msg.error) {
        settle(msg)
        if (isFatal(msg)) {
          const n = errorName(msg)
          const completed = Number((msg as any).time?.completed ?? 0)
          if (n === "MessageAbortedError") {
            const fresh = completed > 0 && Date.now() - completed < ABORT_STALE_MS
            const userAfter = lastUserTime > completed
            if (fresh && !userAfter) {
              // TUI/宿主的中断（ESC 或 /stop）必须留下持久停门；否则下一轮
              // interval/rollcall 会把同一会话重新拉起。
              writeCtlStopped(true, "user", "fresh assistant abort")
              await log("info", `auto-continue: eval session=${sessionID} msg=${msg.id} error=${n} -> STOP(fresh user abort; persisted)`)
              return
            }
            await log("info", `auto-continue: eval session=${sessionID} msg=${msg.id} error=${n} -> RECOVER(abort, age=${Math.round((Date.now() - completed) / 1000)}s, userAfter=${userAfter})`)
          } else {
            const streak = (fatalStreak.get(sessionID) ?? 0) + 1
            fatalStreak.set(sessionID, streak)
            if (streak >= 3) {
              await log("info", `auto-continue: eval session=${sessionID} msg=${msg.id} len=${len} error=${n} -> STOP(fatal x${streak}, giving up)`)
              return
            }
            await log("info", `auto-continue: eval session=${sessionID} msg=${msg.id} len=${len} error=${n} -> RECOVER(fatal streak=${streak})`)
          }
          await maybeCompact(sessionID, (usage.get(sessionID) ?? msg.tokens?.input ?? sessionTokens(sessionID).input ?? 0), assistantCount)
          settle(msg)
          const r = await inject(sessionID, msg, RECOVER_PROMPT, "recover")
          if (r !== "ok") {
            decided.delete(msg.id)
            return
          }
          return
        }
        fatalStreak.delete(sessionID)
        await log("info", `auto-continue: eval session=${sessionID} msg=${msg.id} len=${len} error=${errorName(msg)} -> RECOVER`)
        await maybeCompact(sessionID, (usage.get(sessionID) ?? msg.tokens?.input ?? sessionTokens(sessionID).input ?? 0), assistantCount)
        settle(msg)
        const r = await inject(sessionID, msg, RECOVER_PROMPT, "recover")
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
        const gcfg = readGuard()
        if (gcfg.problem || gcfg.websearch) {
          const gsig = detectGuardSignals(fullText, lastAssistant.parts)
          const gv = guardVerdict(gcfg, gsig)
          if (gv.trip && guardTripped.get(sessionID) !== msg.id) {
            guardTripped.set(sessionID, msg.id)
            writeCtlStopped(true, "auto-guard", gv.reason)
            noteGuardTrip(gv.kind, gv.reason, sessionID)
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

      if (len === 0) {
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
              ? `auto-continue: eval session=${sessionID} msg=${msg.id} -> waiting(in-flight=生成中，属合法中间态，非空转)，${waitMs}ms 后再看`
              : `auto-continue: eval session=${sessionID} msg=${msg.id} -> stalling(text-empty 真空转), retry in ${waitMs}ms`,
          )
        }
        // 空转熔断：只有【已完成仍无文本】才计数；流式中一律视为瞬态（不计数、不熔断、不掐回合）。
        // 验尸 00:34:59：曾把首 token 到达 3 秒后的前台直播消息当空转掐掉（Step interrupted 误伤）。
        const completedTs = Number((msg as any)?.time?.completed ?? 0)
        const workedAnyway = hasNonTextWork(msg)
        if (attempts >= 2 && completedTs > 0 && !workedAnyway && !reasoningOnlyMsgs.has(String(msg.id))) {
          const n = (emptyStreak.get(sessionID) ?? 0) + 1
          emptyStreak.set(sessionID, n)
          if (n >= 5) {
            emptyStreak.delete(sessionID)
            pending.delete(msg.id)
            giveupCount.set(sessionID, (giveupCount.get(sessionID) ?? 0) + 1)
            skipState.set(sessionID, { lastId: msg.id, reason: "empty-stall-giveup", ts: Date.now() })
            await log("info", `auto-continue: eval session=${sessionID} msg=${msg.id} -> GIVEUP(empty x${n}, waiting for new activity)`)
            // 注意：此处不再 interrupt。实测（00:34–01:08 共 8 次 abort）证明两点：
            // ① 掐不死服务端的空包生产（掐完照吐）；② 曾误伤前台直播回合。熔断观察 + 粘性静默已够用。
            return
          }
        }
        if (workedAnyway) {
          if (!(await injectAllowed(sessionID, msg, "round:workedAnyway"))) return
          // R1092: 只有 reasoning 没有工具/文本 = 还在思考/被截断，不算"主动结束干活"，
          // 不注入（用户反馈「AI 没有输出时循环文本仍被注入」）；也不计空转（R1065 豁免）。
          if (!hasRealToolWork(msg) && len === 0) {
            noteReasoningOnly(String(msg.id))
            pending.delete(msg.id)
            if (Date.now() - (throttleLogAt.get(sessionID) ?? 0) > 60_000) {
              throttleLogAt.set(sessionID, Date.now())
              await log('info', `auto-continue: eval session=${sanitizeLog(sessionID).slice(0, 12)} msg=${String(msg.id).slice(0, 14)} -> reasoning-only(workedAnyway:无工具产出), 不注入`)
            }
            return
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
      emptyStreak.delete(sessionID)
      await maybeCompact(sessionID, (usage.get(sessionID) ?? msg.tokens?.input ?? sessionTokens(sessionID).input ?? 0), assistantCount)

      // 用户消息只影响当前回合；助手回合完成后仍继续自动循环。
      // 先认领后发送：并发 evaluate 在 await 间隙重入时，decided 已有记号，不会重复注入；失败则放回。
      settle(msg)
      const r = await inject(sessionID, msg, ROUND_PROMPT, "round")
      if (r !== "ok") {
        decided.delete(msg.id)
        return
      }
      // 有产出即清零熔断计数（会话恢复）
      giveupCount.delete(sessionID)
      lastRoundAt.set(sessionID, Date.now())
      fatalStreak.delete(sessionID)
      settle(msg)
      await log("info", `auto-continue: injected round prompt (session=${sessionID}, msg=${msg.id}, len=${len})`)
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
    if (since !== undefined) {
      const held = Date.now() - since
      if (held > EVAL_WEDGE_MS) {
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
    queueSince.set(sessionID, Date.now())
    queue.set(sessionID, next.finally(() => {
      if (queue.get(sessionID) === next) {
        queue.delete(sessionID)
        queueSince.delete(sessionID)
      }
    }))
  }

  // Fallback: session.idle may never be emitted (observed: zero evals).
  // Only the persisted TG target is eligible; never census/rollcall the
  // session list, otherwise old reports in other sessions can be revived.
  let tickN = 0
  const acTimer = setInterval(() => {
    try {
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
      if ((globalThis as Record<string, unknown>)[AC_GEN_KEY] !== myGenAc) {
        clearInterval(acTimer)
        // 过期退出必须留痕：此前这里是静默 return，主实例"配置正确却整分钟不动"
        // 排查了很久才定位到这里。
        void log(
          "info",
          `loop timer superseded (scope=${AC_SCOPE}, mine=${myGenAc}, current=${String((globalThis as Record<string, unknown>)[AC_GEN_KEY])})`,
        )
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
      tickN++
      if (targets.length > 0 && (tickN === 1 || tickN % 30 === 0)) {
        void log("info", `auto-continue: scoped target check (${targets.map((t) => t.slice(0, 12)).join(", ")})`)
      }
    } catch {
      /* best-effort: never break the timer */
    }
  }, 60_000)

  return {
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const sidAll = (event.properties as { sessionID?: string })?.sessionID
        if (typeof sidAll === "string" && sidAll && isLoopTarget(sidAll)) touchSid(sidAll)
        const info = (event.properties as { info?: { role?: string; sessionID?: string; id?: string; tokens?: { input?: number }; error?: { name?: string } | string } }).info
        const sid = info?.sessionID
        if (info?.role === "assistant") {
          const err: any = info.error
          if (isAbortSignal(err)) {
            // 事件到达即落盘，不等下一轮 evaluate；GUI/ESC 中断必须立即停循环。
            writeCtlStopped(true, "user", "assistant interrupted")
            await log("info", `auto-continue: assistant interrupted; loop stop persisted (${sanitizeLog(sid).slice(0, 12)})`)
            return
          }
        }
        const tk = (info as any)?.tokens
        const inWin = Number(tk?.input)
        const crWin = Number(tk?.cache?.read)
        const winNow = (Number.isFinite(inWin) ? inWin : 0) + (Number.isFinite(crWin) ? crWin : 0)
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
      if (event.type !== "session.idle") return
      const sid = (event.properties as { sessionID?: string }).sessionID
      if (sid && isLoopTarget(sid)) evaluateQueued(sid)
    },
  }
}