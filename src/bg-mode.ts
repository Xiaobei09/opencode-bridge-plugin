/**
 * 「转后台」能力（bg-mode）—— 原生后台子代理的**提升**（promote）与**整体自动配置**。
 *
 * 需求（用户 2026-09-28 原话）：
 *   「shell 增加一个按钮为后台，另外增加一个整体配置自动转换后台，注意，这是 v2」
 *
 * 资料来源与**本地查证**（opencode 1.18.32，REDACTED_ROOT/.opencode/bin/opencode 二进制内检索）：
 *   · `POST /experimental/session/{sessionID}/background` —— ✅ 存在。SDK 入口
 *     `client.experimental.session.background({sessionID, directory?, workspace?})`，
 *     **只有 path/query、无 body**：语义就是"把当前正在阻塞主会话的同步子代理提升为后台"。
 *   · `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` —— ✅ 变量名存在；TUI 的
 *     `session.background` 命令是 hidden 且 `enabled: <开关非空>`（必须开关打开才可用）。
 *   · v2 的 `session.subagent`（直接创建后台子代理）—— ❌ 本 build 内检索不到
 *     （`subagent(`/`/subagent`/`SessionSubagent` 全无）。**不因此写死**：下面按能力探测，
 *     将来换到带该 API 的版本会自动优先走 subagent，无需再改代码。
 *
 * 为什么不"按版本号"选路：build 会换，方法在不在只能问运行时。按版本假设写死，
 * 换版本后要么静默走错路、要么直接崩 —— 这类"想当然"是最贵的省事。
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs"

export const BG_PATH = process.env.AC_BG_PATH ?? "REDACTED_ROOT/.config/opencode/background-mode.json"
const PRIVATE_FILE_MODE = 0o600
export const BG_ENV_VAR = "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"

export type BgCfg = {
  /** 整体自动转后台（"整体配置"）。默认**关**：它是行为改变，且没开关时调用注定失败。 */
  enabled: boolean
  /** 自动模式的冷却（同一次阻塞不该被反复提升）。 */
  cooldownMs: number
}

export const DEFAULT_BG: BgCfg = { enabled: false, cooldownMs: 120_000 }

export const normalizeBg = (j: any): BgCfg => ({
  enabled: typeof j?.enabled === "boolean" ? j.enabled : DEFAULT_BG.enabled,
  cooldownMs:
    Number.isFinite(Number(j?.cooldownMs)) && Number(j.cooldownMs) >= 0 ? Number(j.cooldownMs) : DEFAULT_BG.cooldownMs,
})

export const readBg = (path: string = BG_PATH): BgCfg => {
  try {
    return normalizeBg(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return { ...DEFAULT_BG }
  }
}

export const writeBg = (cfg: BgCfg, extra?: Record<string, unknown>, path: string = BG_PATH): void => {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...cfg, ...(extra ?? {}), ts: Date.now() }), {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  })
  renameSync(tmp, path)
}

// ── 能力探测（纯函数：只看 client 上有没有那两个方法）──────────────────────

export type BgApiShape = { subagent: boolean; promote: boolean }

export const bgApiShape = (client: any): BgApiShape => ({
  subagent: typeof client?.session?.subagent === "function",
  promote: typeof client?.experimental?.session?.background === "function",
})

/** 实验开关是否已开。**必须**由启动 opencode 时就带上**，事后设 process.env 无效。 */
export const bgEnvOn = (env: Record<string, string | undefined> = process.env): boolean => {
  const v = env[BG_ENV_VAR]
  return typeof v === "string" && v !== "" && v !== "0" && v.toLowerCase() !== "false"
}

/** 本 build 实际提供哪条路（回显给用户，别让人对着文档猜）。 */
export const bgApiLabel = (shape: BgApiShape): string =>
  shape.subagent && shape.promote ? "subagent(创建) + background(提升)" : shape.subagent ? "subagent(创建)" : shape.promote ? "background(提升)" : "无（不支持）"

// ── 自动模式的判据（纯函数）────────────────────────────────────────────────

/**
 * 正在**同步阻塞**的子代理工具名白名单。
 * 刻意只收 task/agent/subagent：把"任意运行中的工具"当子代理去提升，会对
 * 读文件/跑 grep 这类工具调后台端点 —— 端点无 body 参数，提错了也没法表达意图。
 */
const SYNC_AGENT_TOOLS: ReadonlySet<string> = new Set(["task", "agent", "subagent", "subagent_task"])

export const hasBlockingSubagent = (parts: unknown[]): boolean => {
  const arr = Array.isArray(parts) ? parts : []
  return arr.some((p) => {
    const anyP = p as any
    if (String(anyP?.type ?? "") !== "tool") return false
    if (!SYNC_AGENT_TOOLS.has(String(anyP?.tool ?? "").toLowerCase())) return false
    return ["running", "pending"].includes(String(anyP?.state?.status ?? ""))
  })
}

export type AutoDecision = { go: boolean; why: string }

/**
 * 自动转后台的判据。**逐条如实给 why** —— 菜单/状态回显里"为什么没动"比"动了不说"重要得多：
 * 用户点了开关却什么都没发生时，没说清原因就只能靠猜。
 */
export const shouldAutoPromote = (
  parts: unknown[],
  cfg: BgCfg,
  nowMs: number,
  lastAtMs: number,
  envOn: boolean,
  shape?: BgApiShape,
): AutoDecision => {
  if (!cfg.enabled) return { go: false, why: "整体自动转后台=关" }
  if (shape && !shape.promote && !shape.subagent) return { go: false, why: "本 build client 无后台 API" }
  if (!envOn) return { go: false, why: `实验开关未开启（需启动时带 ${BG_ENV_VAR}=1）` }
  const since = Math.round((nowMs - (lastAtMs || 0)) / 1000)
  if (lastAtMs > 0 && since < Math.round(cfg.cooldownMs / 1000)) return { go: false, why: `冷却中（${since}s/${Math.round(cfg.cooldownMs / 1000)}s）` }
  if (!hasBlockingSubagent(parts)) return { go: false, why: "没有阻塞中的同步子代理" }
  return { go: true, why: "检测到阻塞中的同步子代理" }
}

// ── /background 参数解析（纯函数；菜单按钮投送的正是「头 + 值」）────────────

export type BgAction =
  | { kind: "promote" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "set"; enabled: boolean }

export const parseBgArg = (arg: string, cur: BgCfg): BgAction => {
  const toks = String(arg ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  const head = toks[0] ?? ""
  const val = toks[1] ?? ""
  if (toks.length === 0) return { kind: "promote" } // 裸 /background = 立刻转后台（菜单按钮）
  if (head === "status" || head === "st" || head === "info") return { kind: "status" }
  if (head === "help" || head === "?") return { kind: "help" }
  if (head === "auto") {
    if (val === "on" || val === "开" || val === "1" || val === "true") return { kind: "set", enabled: true }
    if (val === "off" || val === "关" || val === "0" || val === "false") return { kind: "set", enabled: false }
    if (val === "toggle" || val === "") return { kind: "set", enabled: !cur.enabled }
    return { kind: "help" }
  }
  if (head === "on" || head === "开") return { kind: "set", enabled: true }
  if (head === "off" || head === "关") return { kind: "set", enabled: false }
  if (head === "toggle" || head === "flip") return { kind: "set", enabled: !cur.enabled }
  if (head === "go" || head === "run" || head === "promote") return { kind: "promote" }
  return { kind: "help" }
}
