/**
 * 循环「自动停止守卫」（loop-guard）—— 检测到问题 / 网页搜索请求就自动停止循环。
 *
 * 需求（用户 2026-09-28 原话）：
 *   「增加一个检测到问题/网页搜索请求就自动停止（然后继续循环）的机制，在菜单中可以修改」
 *
 * 为什么单独一个文件：判据要同时被**两侧**使用，而两侧各写一份必然会漂移：
 *   · auto-continue（v2lib/auto-continue.ts）：看到信号 → 写停机总闸，循环停住等用户；
 *   · tg-bridge（v2lib/tg-bridge.ts）：菜单按钮读写开关、回显状态与最近一次触发。
 * 纯函数放这里，两边 import 同一份，判据因此能被单测直接打（不用起真服务）。
 *
 * 「自动停止」刻意落在**既有**停机总闸上（loop-ctl.json 的 stopped=true），
 * 不新造一套暂停语义 —— 于是「然后继续循环」不需要新写恢复路径：
 * /loop start（= 菜单「🔁 循环」里的「▶️ 继续循环」按钮）清闸即恢复，
 * 与 [LOOP:PAUSE]、/stop、ESC 中断完全同一条恢复路径，少一条路径就少一类漂移。
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs"

export const GUARD_PATH = process.env.AC_GUARD_PATH ?? "REDACTED_ROOT/.config/opencode/loop-guard.json"
const PRIVATE_FILE_MODE = 0o600

export type GuardCfg = {
  /** 助手宣告「检测到问题」时自动停循环。默认开。 */
  problem: boolean
  /** 助手请求网页搜索时自动停循环（等用户在 TG 授权）。默认开。 */
  websearch: boolean
}

/** 默认开：用户要的就是"检测到就停"，默认关等于装了个开关但什么都不做。 */
export const DEFAULT_GUARD: GuardCfg = { problem: true, websearch: true }

/** 宽容归一：任何非布尔值（缺字段/字符串/损坏）都退回默认，绝不因为脏数据把守卫变成"半开"。 */
export const normalizeGuard = (j: any): GuardCfg => ({
  problem: typeof j?.problem === "boolean" ? j.problem : DEFAULT_GUARD.problem,
  websearch: typeof j?.websearch === "boolean" ? j.websearch : DEFAULT_GUARD.websearch,
})

/** 读不到文件 = 用默认（守卫可用），而不是"读不到就当关"——那会让新装的环境毫无防护。 */
export const readGuard = (path: string = GUARD_PATH): GuardCfg => {
  try {
    return normalizeGuard(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return { ...DEFAULT_GUARD }
  }
}

/**
 * 写守卫配置。tmp + rename 原子写：auto-continue 与 tg-bridge 是两个进程/两个热重载实例，
 * 各自都在写同一个文件；非原子写中途被读会得到半截 JSON → 守卫瞬间退化成默认（或读失败）。
 * lastTrip 一并落盘，菜单里的「详情」才有东西可显示。
 */
export const writeGuard = (cfg: GuardCfg, extra?: { lastTrip?: unknown }, path: string = GUARD_PATH): void => {
  const payload = JSON.stringify({ ...cfg, ...(extra ?? {}), ts: Date.now() })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, payload, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
  renameSync(tmp, path)
}

/**
 * 记一次触发（供菜单回显 + 跨重启判重）。**不**改开关本身。
 *
 * R1902：msgId 一并落盘 —— 守卫的 in-memory 判重（auto-continue 的 guardTripped Map）
 * 在进程重启后清零，陈旧助手消息里的旧宣告会被**再次**拉闸（事故 2026-10-07：
 * bot2 00:01 的 [STATUS: STOP] 在每次部署重启后一分钟内重新停掉全局循环）。
 */
export const noteGuardTrip = (
  kind: string,
  reason: string,
  sessionID: string,
  msgId: string = "",
  path: string = GUARD_PATH
): void => {
  try {
    const cur = readGuard(path)
    writeGuard(cur, { lastTrip: { kind, reason: String(reason ?? "").slice(0, 200), sid: sessionID, msgId, at: Date.now() } }, path)
  } catch {
    /* best-effort：记不住不影响停机本身 */
  }
}

export const readGuardLastTrip = (
  path: string = GUARD_PATH
): { kind?: string; reason?: string; sid?: string; msgId?: string; at?: number } | undefined => {
  try {
    const t = JSON.parse(readFileSync(path, "utf8"))?.lastTrip
    return t && typeof t === "object" ? t : undefined
  } catch {
    return undefined
  }
}

// ── 判定（纯函数）──────────────────────────────────────────────────────────

/**
 * R1902：这条消息是不是**已经判停过**（持久化判重，跨重启生效）？
 *
 * 事故（2026-10-07）：bot2 会话 00:01 的助手消息以独占行 [STATUS: STOP] 正当宣告停机，
 * 但 in-memory 的 guardTripped Map 随进程重启清零 → 每次部署重启后 1 分钟内，
 * 评估器再次看到这条**陈旧**消息 → 重新拉全局闸 → /loop start 清闸也只能活到下次重启。
 * 用户观感就是「自动循环又失效了，两个会话都是这样」（闸是全局的，一个 bot 的旧宣告杀全部）。
 *
 * 判据：lastTrip 记录的 sid+msgId 与当前完全一致 = 同一条消息已判过，不再重复拉闸
 * （此时放行继续注入 —— 用户 /loop start 的语义就是"这条我已处理，继续跑"）。
 * 旧格式记录（无 msgId 字段）一律视为"没判过"：宁可多判一次并写入新格式，也不静默漏判。
 */
export const alreadyTripped = (
  lastTrip: { sid?: string; msgId?: string } | undefined,
  sid: string,
  msgId: string
): boolean =>
  !!lastTrip && !!lastTrip.msgId && lastTrip.sid === sid && lastTrip.msgId === msgId

/**
 * 三种信号**都必须独占一行**才生效。
 *
 * 为什么不用子串匹配：循环提示词本身、以及每轮报告开头对循环规则的**复述**里，
 * 必然出现这些标记的字面文本（"输出 [ROUND n]+[STATUS: CONTINUE/STOP]"、
 * "遇到问题请输出 [SIGNAL:PROBLEM]"）。子串匹配 = 守卫一装上，**每一轮都被自己的规则复述误停**，
 * 循环立刻变成死循环。既有 [LOOP:PAUSE] 的注释已经记过同类坑（原文出现即触发），
 * 这里从判据上根除：只认独占行 + 允许 markdown 标题/粗体包裹。
 */
const FENCE_RE = /```[\s\S]*?```/g
const SPAN_RE = /`[^`\n]*`/g
/** 围栏代码块整体挖空成等量空行：保留行结构（`^$` 锚点仍成立），只去掉内容。 */
const stripFenced = (t: string): string => String(t ?? "").replace(FENCE_RE, (m) => m.replace(/[^\n]/g, " "))
/**
 * 再挖空**行内代码片段**（`...`）。
 * 为什么必须连行内一起挖：事故那一轮正是把标记写在行内代码里（讲"恢复路径"时），
 * 只挖围栏的话这类提及照样命中。文档/报告里的标记提及 = 说明，不是宣告。
 */
const stripCode = (t: string): string => stripFenced(t).replace(SPAN_RE, (m) => " ".repeat(m.length))

const lineDecal = (t: string, re: RegExp): string | undefined => {
  const m = stripCode(t).match(re)
  return m ? String(m[1] ?? "").trim() : undefined
}

/** `## [ROUND 1350]+[STATUS: STOP]` / `**[STATUS: STOP]**` / `[STATUS: STOP]`；但不含 `[STATUS: CONTINUE/STOP]`。 */
const STATUS_STOP_RE =
  /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:\[\s*ROUND[^\]\n]{0,40}\]\s*\+?\s*)?\[?\s*STATUS\s*:\s*STOP\s*\]?\s*(?:\*\*|__)?\s*$/im
const PROBLEM_MARK_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*\[SIGNAL\s*:\s*PROBLEM(?::\s*([^\]\n]{0,160}))?\]\s*(?:\*\*|__)?\s*$/im
const WEB_MARK_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*\[SIGNAL\s*:\s*WEBSEARCH(?::\s*([^\]\n]{0,160}))?\]\s*(?:\*\*|__)?\s*$/im

/**
 * 搜索类工具名白名单。**不用** `/search/i` 泛匹配：本桥有 `full:`/检索类内部工具，
 * 泛匹配会把无关工具误判成"网页搜索请求"，守卫就成了随机误停机。
 */
export const WEB_SEARCH_TOOLS: ReadonlySet<string> = new Set([
  "websearch",
  "web_search",
  "web-search",
  "websearch_search",
  "brave_search",
  "google_search",
  "duckduckgo",
  "duckduckgo_search",
  "exa_search",
  "tavily",
  "tavily_search",
  "bing_search",
  "serper",
  "serpapi",
])

// ── /autoguard 参数解析（纯函数，桥的命令分支只做 I/O）────────────────────

export type GuardAction =
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "set"; what: "all" | "problem" | "web"; cfg: GuardCfg }

const TRUTHY = new Set(["on", "开", "1", "true", "enable", "yes", "y"])
const FALSY = new Set(["off", "关", "0", "false", "disable", "no", "n"])

/** 认不出来的词**保持原值**：宁可"没改"也不要猜错方向（把守卫误关 = 用户以为还开着）。 */
const parseVal = (tok: string, dflt: boolean): boolean => {
  const t = String(tok ?? "").trim().toLowerCase()
  if (TRUTHY.has(t)) return true
  if (FALSY.has(t)) return false
  if (t === "" || t === "toggle" || t === "flip") return !dflt // 裸词 = 翻转（菜单按钮就靠这个）
  return dflt
}

/**
 * 菜单按钮投送的命令是 `/autoguard problem toggle` 这类三段式，
 * 所以解析必须吃下"头 + 值"两个 token，而不是只看第一个词。
 */
export const parseGuardArg = (arg: string, cur: GuardCfg): GuardAction => {
  const toks = String(arg ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (toks.length === 0) return { kind: "status" }
  const head = toks[0] ?? ""
  const val = toks[1] ?? ""
  if (head === "status" || head === "st" || head === "info") return { kind: "status" }
  if (head === "help" || head === "?") return { kind: "help" }
  if (head === "problem" || head === "p") return { kind: "set", what: "problem", cfg: { ...cur, problem: parseVal(val, cur.problem) } }
  if (head === "web" || head === "websearch" || head === "w") return { kind: "set", what: "web", cfg: { ...cur, websearch: parseVal(val, cur.websearch) } }
  if (head === "on" || head === "开") return { kind: "set", what: "all", cfg: { problem: true, websearch: true } }
  if (head === "off" || head === "关") return { kind: "set", what: "all", cfg: { problem: false, websearch: false } }
  if (head === "toggle" || head === "flip") return { kind: "set", what: "all", cfg: { problem: !cur.problem, websearch: !cur.websearch } }
  return { kind: "help" }
}

export type GuardSignals = {
  /** 检出"问题"的说明（空串 = 助手只宣告了 [STATUS: STOP] 未写原因）。 */
  problem?: string
  /** 检出"网页搜索请求"的说明。 */
  websearch?: string
}

/**
 * 从**最后一条助手消息**的文本 + parts 里抽信号。
 * 文本通道 = 助手自报（有意为之、可在菜单里关）；parts 通道 = 客观事实（真调了搜索工具，
 * 与助手是否守规矩无关）—— 两者都收，才既可配置又不漏。
 */
export const detectGuardSignals = (text: string, parts: unknown[]): GuardSignals => {
  const sig: GuardSignals = {}
  const stopped = lineDecal(text, STATUS_STOP_RE)
  if (stopped !== undefined) sig.problem = stopped
  else {
    const pm = lineDecal(text, PROBLEM_MARK_RE)
    if (pm !== undefined) sig.problem = pm
  }
  const wm = lineDecal(text, WEB_MARK_RE)
  if (wm !== undefined) sig.websearch = wm
  const arr = Array.isArray(parts) ? parts : []
  for (const p of arr) {
    const anyP = p as any
    if (String(anyP?.type ?? "") !== "tool") continue
    const tool = String(anyP?.tool ?? "").toLowerCase()
    if (WEB_SEARCH_TOOLS.has(tool)) {
      sig.websearch = sig.websearch ?? `本回合调用了搜索工具 ${tool}`
      break
    }
  }
  return sig
}

/** 开关 + 信号 → 判不判停。problem 优先（"有问题"比"要搜索"更需要人来）。 */
export const guardVerdict = (
  cfg: GuardCfg,
  sig: GuardSignals,
): { trip: boolean; kind: "problem" | "websearch" | ""; reason: string } => {
  const hits: string[] = []
  let kind: "problem" | "websearch" | "" = ""
  if (cfg.problem && sig.problem !== undefined) {
    kind = "problem"
    hits.push(`检测到问题${sig.problem ? `：${sig.problem}` : ""}`)
  }
  if (cfg.websearch && sig.websearch !== undefined) {
    if (kind === "") kind = "websearch"
    hits.push(`网页搜索请求${sig.websearch ? `：${sig.websearch}` : ""}`)
  }
  return { trip: hits.length > 0, kind, reason: hits.join("｜").slice(0, 200) }
}

// ── 既有 [LOOP: PAUSE] 宣告（事故 2026-09-28）──────────────────────────────
// 原来在 auto-continue 里是子串正则，报告里**提及**就停机（真实停过一次）。
// 现在与新守卫同规则：独占一行 + 围栏/行内代码挖空，纯函数可单测。
const PAUSE_DECL_RE =
  /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*\[LOOP[ \t]*:[ \t]*PAUSE(?::[ \t]*([^\]\n]{0,160}))?\][ \t]*(?:\*\*|__)?[ \t]*$/im

export const loopPauseDecl = (text: string): { declared: boolean; reason: string } => {
  const r = lineDecal(text, PAUSE_DECL_RE)
  return r === undefined ? { declared: false, reason: "" } : { declared: true, reason: r.slice(0, 120) }
}
