import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, chmodSync, readFileSync, statSync, writeFileSync } from "node:fs"

export type V1Hook = (payload: { event: any }) => Promise<void> | void

export interface V1Client {
  app: { log: (input: { body: { service: string; level: string; message: string } }) => Promise<unknown> }
  session: {
    messages: (input: { path: { id: string } }) => Promise<{ data: any[] }>
    promptAsync: (input: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }) => Promise<unknown>
    compact?: (input: { path: { id: string } }) => Promise<unknown>
    interrupt?: (input: { path: { id: string } }) => Promise<unknown>
    createSession?: (input: { title?: string }) => Promise<any>
    list?: (input?: unknown) => Promise<{ data: any[] }>
    get?: (input: { path: { id: string } }) => Promise<{ data: any }>
    update?: (input: { path: { id: string }; body: { title: string } }) => Promise<unknown>
    latestCompaction?: (input: { path: { id: string } }) => Promise<{ data: any | null }>
  }
}

const TAP_PATH = "/tmp/opencode/v2plugin.log"
const TAP_MAX = 2000000
const PRIVATE_FILE_MODE = 0o600
// 插件日志含会话 ID、chat ID 与工具摘要；启动时修复旧文件权限，重建时沿用 0600。
try {
  chmodSync(TAP_PATH, PRIVATE_FILE_MODE)
} catch {
  /* file may not exist yet; creation below uses mode 0600 */
}
const tapLine = (line: string): void => {
  try {
    let size = 0
    try {
      size = statSync(TAP_PATH).size
    } catch {
      size = 0
    }
    if (size > TAP_MAX) {
      // rotate instead of dropping: keep last quarter so observability never blinds
      try {
        const data = readFileSync(TAP_PATH, "utf8")
        const keep = data.slice(Math.floor(data.length * 0.75))
        const nl = keep.indexOf("\n")
        writeFileSync(TAP_PATH, (nl >= 0 ? keep.slice(nl + 1) : keep) + `${line}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
      } catch {
        try {
          writeFileSync(TAP_PATH, `${line}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
        } catch {
          /* ignore */
        }
      }
      return
    }
    appendFileSync(TAP_PATH, `${line}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
  } catch {
    /* best-effort */
  }
}

const logLine = (service: string, level: string, message: string): void => {
  const line = `[${service}] ${level}: ${message}`
  if (level === "error") console.error(line)
  else console.log(line)
  tapLine(`${new Date().toISOString()} ${line}`)
}

// ---------------------------------------------------------------------------
// v2 -> v1 value normalization
// ---------------------------------------------------------------------------

/** v2 errors are often objects ({type, message}); v1 bridge expects strings. */
const errText = (e: unknown): string => {
  if (e == null || e === "") return ""
  if (typeof e === "string") return e
  if (typeof (e as any)?.message === "string" && (e as any).message) return String((e as any).message)
  try {
    const j = JSON.stringify(e)
    if (j === "{}" || j === "null") return String(e)
    return j
  } catch {
    return "[unserializable error]"
  }
}

/** v2 tool state.content is [{type:'text',text}...]; v1 bridge wants a string output. */
const toolContentToText = (content: unknown): string => {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const c of content) {
      if (typeof c === "string") texts.push(c)
      else if (c && typeof c === "object") {
        if (typeof (c as any).text === "string") texts.push((c as any).text)
        else {
          try {
            texts.push(JSON.stringify(c))
          } catch {
            /* skip */
          }
        }
      }
    }
    return texts.join("\n")
  }
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

/** v2 has no tool titles; derive a readable one from name + input args. */
const deriveTitle = (name: string, input: unknown): string => {
  try {
    if (input && typeof input === "object") {
      const inp = input as Record<string, unknown>
      for (const k of ["path", "command", "url", "query", "pattern", "text", "prompt", "file"]) {
        const v = inp[k]
        if (typeof v === "string" && v.trim()) return v.trim().slice(0, 80)
      }
    } else if (typeof input === "string" && input.trim()) {
      return input.trim().slice(0, 80)
    }
  } catch {
    /* ignore */
  }
  return ""
}

// ---------------------------------------------------------------------------
// compaction signals: session.compaction.ended → tg-bridge clears ctxUsage.
// ---------------------------------------------------------------------------
const compactedFlag = new Set<string>()
export const takeCompacted = (sessionID: string): boolean => {
  try {
    if (!sessionID || !compactedFlag.has(sessionID)) return false
    compactedFlag.delete(sessionID)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// step.ended memory: finish reason + tokens per assistant message.
// session_message rows don't persist tokens, so remember them for ✅完成 blocks.
// ---------------------------------------------------------------------------
const stepEndByMsg = new Map<string, { finish: string; tokens: number; cost: number; tin: number; tout: number; trea: number }>()

const rememberStepEnd = (sessionID: string, assistantMessageID: string, data: any): void => {
  try {
    if (!assistantMessageID) return
    const t = data?.tokens ?? {}
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
    stepEndByMsg.set(assistantMessageID, {
      finish: String(data?.finish ?? data?.reason ?? ""),
      tokens: num(t.input) + num(t.output) + num(t.reasoning),
      cost: num(data?.cost),
      tin: num(t.input),
      tout: num(t.output),
      trea: num(t.reasoning),
    })
    if (stepEndByMsg.size > 500) {
      const first = stepEndByMsg.keys().next()
      if (!first.done) stepEndByMsg.delete(first.value)
    }
    if (sessionID) {
      // 最新口径：单步 input 即全量上下文（模型当步 prompt tokens），取最新值；
      // 求和会双重计数（每步都含全量上下文），重启还会丢历史——这就是 ctx% 与 TUI 对不上的根因。
      stepTokensBySession.set(sessionID, {
        input: num(t.input),
        output: num(t.output),
        reasoning: num(t.reasoning),
      })
    }
  } catch {
    /* ignore */
  }
}

// 会话 token 水位（step.ended 最新值；单步 input 即全量上下文，仅作上下文比例参考）
const stepTokensBySession = new Map<string, { input: number; output: number; reasoning: number }>()
export const CONTEXT_WINDOW = 1048576
export const sessionTokens = (sessionID: string): { input: number; output: number; reasoning: number } => {
  return stepTokensBySession.get(sessionID) ?? { input: 0, output: 0, reasoning: 0 }
}
export const dumpSessionTokens = (): Record<string, { input: number; output: number; reasoning: number }> => {
  const out: Record<string, { input: number; output: number; reasoning: number }> = {}
  try {
    for (const [k, v] of [...stepTokensBySession.entries()].slice(-50)) out[k] = { ...v }
  } catch {
    /* ignore */
  }
  return out
}
export const restoreSessionTokens = (data: Record<string, { input: number; output: number; reasoning: number }>): void => {
  try {
    for (const [k, v] of Object.entries(data ?? {}).slice(0, 50)) {
      if (typeof k !== "string" || !v || typeof v !== "object") continue
      const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0)
      const inp = num((v as any).input)
      // 自愈：旧版存的是累加和（可超窗口，如 115%），与最新值口径不兼容，直接丢弃等下步重建
      if (inp > CONTEXT_WINDOW) continue
      stepTokensBySession.set(k, { input: inp, output: num((v as any).output), reasoning: num((v as any).reasoning) })
    }
  } catch {
    /* ignore */
  }
}
export const resetSessionTokens = (sessionID: string): void => {
  try {
    stepTokensBySession.delete(sessionID)
  } catch {
    /* ignore */
  }
}

// session-level input-token totals (from session.usage.updated events).
// The bridge's compaction policy reads msg.tokens?.input; DB rows don't
// persist tokens, so overlay the latest known totals here.
const latestTokensBySession = new Map<string, number>()
const numOrZero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

// ---------------------------------------------------------------------------
// DB-backed message history.
// v2 plugin ctx has no message-list API (session.context returns prompt
// context, not history), so read the local opencode.db (readonly), same
// technique the v1 era used for diagnostics.
// ---------------------------------------------------------------------------
const DB_PATH = "REDACTED_ROOT/.local/share/opencode/opencode.db"
const HISTORY_LIMIT = 200

let dbHandle: any = null
let dbFailed = false
// ctx.session 能力快照只打一次（方法名，无凭据）
let compactCapsLogged = false
// 宿主未提供压缩入口时置位，避免每 30 分钟重复失败探测
// R1017 穷尽验证（探针已扩到**原型链**与宿主原生 client 的键，2026-09-27 实测输出）：
//   have[create,interrupt,prompt,update,get,wait]
//   missing[...,compact,abort,messages,promptAsync,summarize,shell,revert,fork]
//   all[hook,create,get,switchAgent,switchModel,prompt,generate,command,
//       synthetic,interrupt,update,move,wait,context]   ← 原型链扫描**没有新增**
// → 插件面（含原型）确实**没有** compact/summarize。
// 而 SDK 的**服务端** REST 里**有** `/session/{id}/summarize`（还有 `/abort`、`/shell`）——
// 两者不矛盾：那是 HTTP 面，插件拿不到。拿不到的两条原因都实测过：
//   ① `createOpencodeServer({hostname,port,…})` 的选项里**没有鉴权项** → 它只能自己起一个
//      服务端（那是另一个实例，不是接管宿主运行中的会话）；
//   ② 插件环境**没有任何 opencode 凭据**；compat 试本地 HTTP 拿到的是 **401**。
// 所以「本宿主不可压缩」现在是**被穷尽验证过的结论**，不是假设 —— 除非将来能拿到
// 服务端地址 + 凭据，否则不必再重复推导这件事。
let compactUnavailable = false
// 供 auto-continue 日志提示用（不改变任何停止/注入语义）
export const compactUnavailableNow = (): boolean => compactUnavailable
const COMPACT_UNAVAILABLE_MSG =
  "compact unavailable in this host build (no ctx.session.compact, no /compact command, local API needs auth); use /migrate to carry a summary into a new session"

const openDb = async (): Promise<any> => {
  if (dbHandle || dbFailed) return dbHandle
  try {
    const mod: any = await import("bun:sqlite")
    dbHandle = new mod.Database(DB_PATH, { readonly: true })
    return dbHandle
  } catch (err) {
    dbFailed = true
    logLine("v2compat", "error", `bundb unavailable, history empty: ${String(err).slice(0, 160)}`)
    return null
  }
}

// 服务端账本直读：session_v2.tokens_* 即当前窗口用量（input≈最近请求输入；cache_read 是生命周期累计，不进分子）。
// how-much 口径：分子 = input + output + reasoning。
export const readSessionUsage = async (
  sessionID: string
): Promise<{ input: number; output: number; reasoning: number; modelID: string; providerID: string } | null> => {
  try {
    const db = await openDb()
    if (!db) return null
    const row = db.query("SELECT tokens_input, tokens_output, tokens_reasoning, model FROM session_v2 WHERE id = ?").get(sessionID) as any
    if (!row) return null
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)
    let modelID = ""
    let providerID = ""
    try {
      const m = JSON.parse(String(row.model ?? "{}"))
      modelID = String(m?.id ?? "")
      providerID = String(m?.providerID ?? "")
    } catch {
      /* ignore */
    }
    const input = num(row.tokens_input)
    if (input <= 0) return null
    return { input, output: num(row.tokens_output), reasoning: num(row.tokens_reasoning), modelID, providerID }
  } catch {
    return null
  }
}

const toV1ToolPart = (p: any): any => {
  const st = p?.state ?? {}
  const status = String(st.status ?? "?")
  const output = toolContentToText(st.content)
  const md = st.metadata ?? {}
  const name = String(p?.name ?? p?.id ?? "tool")
  const title = deriveTitle(name, st.input)
  const t = p?.time ?? {}
  return {
    type: "tool",
    tool: name,
    callID: String((p as any)?.id ?? (p as any)?.callID ?? ""),
    state: {
      status,
      title,
      input: st.input ?? null,
      output,
      error: errText((p as any)?.error ?? st.error),
      metadata: {
        truncated: !!md.truncated,
        exit: md.exit ?? null,
      },
    },
    time: { created: t.created ?? 0, completed: t.completed ?? t.ran ?? 0 },
  }
}

/** 同步版会话列表（菜单键盘在回调里同步构建用），带 30s 缓存 */
let syncListCache: { ts: number; list: any[] } = { ts: 0, list: [] }
export const readSessionListSync = (): any[] => {
  const now = Date.now()
  if (now - syncListCache.ts < 30_000) return syncListCache.list
  try {
    const db = dbHandle
    if (db) {
      const rows = db
        .query("SELECT id, title, time_updated, time_created FROM session_v2 ORDER BY time_updated DESC LIMIT 20")
        .all() as Array<{ id: string; title: string | null; time_updated: number; time_created: number }>
      syncListCache = {
        ts: now,
        list: rows
          .filter((r) => typeof r.id === "string" && r.id.startsWith("ses_"))
          .map((r) => ({ id: r.id, title: r.title ?? "", time: { updated: r.time_updated ?? 0, created: r.time_created ?? 0 } })),
      }
      return syncListCache.list
    }
  } catch {
    /* fall through to cache */
  }
  if (!dbHandle) void openDb() // 异步预热，下一次就有同步句柄可用
  return syncListCache.list
}

const readSessionList = async (): Promise<any[]> => {
  const db = await openDb()
  if (!db) return []
  try {
    const rows = db
      .query("SELECT id, title, time_updated, time_created FROM session_v2 ORDER BY time_updated DESC LIMIT 50")
      .all() as Array<{ id: string; title: string | null; time_updated: number; time_created: number }>
    return rows
      .filter((r) => typeof r.id === "string" && r.id.startsWith("ses_"))
      .map((r) => ({ id: r.id, title: r.title ?? "", time: { updated: r.time_updated ?? 0, created: r.time_created ?? 0 } }))
  } catch (err) {
    logLine("v2compat", "error", `session list failed: ${String(err).slice(0, 160)}`)
    return []
  }
}

const rowToV1 = (row: { id: string; type: string; data: string }, sessionID: string): any | null => {
  let d: any
  try {
    d = JSON.parse(row.data)
  } catch {
    return null
  }
  const id = row.id
  if (row.type === "assistant") {
    const tm = d?.time ?? {}
    const parts: any[] = []
    const content: any[] = Array.isArray(d?.content) ? d.content : []
    for (const p of content) {
      if (!p || typeof p !== "object") continue
      if (p.type === "tool") {
        parts.push(toV1ToolPart(p))
      } else if (p.type === "text" || p.type === "reasoning") {
        parts.push({
          type: p.type,
          text: typeof p.text === "string" ? p.text : "",
          time: { created: p?.time?.created ?? tm.created ?? 0, completed: tm.completed ?? 0 },
        })
      }
    }
    const se = stepEndByMsg.get(id)
    if (se && (se.finish || se.tokens > 0)) {
      parts.push({ type: "step-finish", state: { reason: se.finish || "completed", tokens: se.tokens, cost: se.cost, tin: se.tin, tout: se.tout, trea: se.trea } })
    }
    let msgErr: unknown = (d as any)?.error ?? null
    // v2 存储里 assistant 行自带 tokens（input/output/reasoning/cache）——这是
    // 「最近一次请求的真实窗口占用」的唯一可靠来源。旧代码只看旁路 map，
    // 导致 tokens 常年 undefined，ctx 后缀只能退化成累计值（永远 100%）。
    const rt = (d as any)?.tokens
    const rIn = numOrZero(rt?.input)
    const rOut = numOrZero(rt?.output)
    const rRea = numOrZero(rt?.reasoning)
    const rCr = numOrZero(rt?.cache?.read)
    const rCw = numOrZero(rt?.cache?.write)
    const fbIn = numOrZero(latestTokensBySession.get(sessionID))
    const tokens =
      rIn > 0 || rOut > 0 || rRea > 0
        ? { input: rIn, output: rOut, reasoning: rRea, cache: { read: rCr, write: rCw } }
        : fbIn > 0
          ? { input: fbIn }
          : undefined
    const rModel = (d as any)?.model
    return {
      id,
      info: {
        id,
        role: "assistant",
        time: { created: tm.created ?? 0, completed: tm.completed ?? 0 },
        error: (msgErr ?? null) as any,
        tokens,
        model: rModel && typeof rModel === "object" ? { id: String(rModel.id ?? ""), providerID: String(rModel.providerID ?? "") } : undefined,
      },
      parts,
    }
  }
  if (row.type === "user" || row.type === "synthetic") {
    const text = typeof d?.text === "string" ? d.text : ""
    const created = d?.time?.created ?? 0
    return {
      id,
      info: { id, role: "user", time: { created } },
      parts: text ? [{ type: "text", text, time: { created, completed: created } }] : [],
    }
  }
  if (row.type === "compaction") {
    const created = d?.time?.created ?? 0
    const status = String(d?.status ?? "unknown")
    const reason = String(d?.reason ?? "")
    const summary = typeof d?.summary === "string" ? d.summary : ""
    const err = d?.error != null ? errText(d.error) : ""
    const tm = { created, completed: created }
    const header = [
      `🗜️ 会话压缩${status === "completed" ? "完成" : `(${status})`}`,
      `status: ${status}`,
      reason ? `reason: ${reason}` : "",
      err ? `err: ${err.slice(0, 200)}` : "",
    ]
      .filter(Boolean)
      .join("\n")
    const parts: any[] = [{ type: "text", text: header, time: tm }]
    const CH = 2800
    const MAXCH = 5
    for (let i = 0; i < MAXCH && i * CH < summary.length; i++) {
      const chunk = summary.slice(i * CH, (i + 1) * CH)
      const done = (i + 1) * CH >= summary.length
      const capped = !done && i === MAXCH - 1
      const suffix = done ? "" : capped ? `\n[truncated -${summary.length - MAXCH * CH} chars]` : "\n…(续)"
      parts.push({
        type: "text",
        text: `🗜️ 会话压缩summary(${i + 1}):\n${chunk}${suffix}`,
        time: tm,
      })
    }
    return {
      id,
      info: { id, role: "assistant", time: { created, completed: created } },
      parts,
    }
  }
  return null
}
const readLatestCompaction = async (sessionID: string): Promise<any | null> => {
  try {
    const db = await openDb()
    if (!db) return null
    const rows = db
      .query("SELECT id, type, data FROM session_message WHERE session_id = ? AND type = 'compaction' ORDER BY seq DESC LIMIT 5")
      .all(sessionID) as Array<{ id: string; type: string; data: string }>
    if (!rows || rows.length === 0) return null
    let pick = rows[0]
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data)
        if (typeof d?.summary === "string" && d.summary.trim() !== "") {
          pick = r
          break
        }
      } catch {
        /* keep scanning */
      }
    }
    return rowToV1(pick, sessionID)
  } catch (err) {
    logLine("v2compat", "error", `latest compaction read failed: ${String(err).slice(0, 160)}`)
    return null
  }
}

export { readLatestCompaction }

// 循环判定的专用轻量查询：只取最近 N 条真实用户消息的正文。
// 不能靠 readSessionMessages：它只回最后 HISTORY_LIMIT(200) 行，重会话里
// 循环控制消息早就被工具/助手行挤出窗口 → 误判 loop=no，循环整个停摆。
export const readRecentUserTexts = async (sessionID: string, limit = 60): Promise<string[]> => {
  try {
    const db = await openDb()
    if (!db) return []
    const rows = db
      .query("SELECT data FROM session_message WHERE session_id = ? AND type IN ('user','synthetic') ORDER BY seq DESC LIMIT ?")
      .all(sessionID, Math.max(1, Math.min(200, limit))) as Array<{ data: string }>
    const out: string[] = []
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data)
        const t = typeof d?.text === "string" ? d.text : ""
        if (t) out.push(t)
      } catch {
        /* skip malformed row */
      }
    }
    return out
  } catch {
    return []
  }
}

const readSessionMessages = async (sessionID: string): Promise<any[]> => {
  const db = await openDb()
  if (!db) return []
  try {
    const rows = db
      .query("SELECT id, type, data FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT ?")
      .all(sessionID, HISTORY_LIMIT) as Array<{ id: string; type: string; data: string }>
    const out: any[] = []
    for (let i = rows.length - 1; i >= 0; i--) {
      const m = rowToV1(rows[i], sessionID)
      if (m) out.push(m)
    }
    return out
  } catch (err) {
    logLine("v2compat", "error", `history read failed: ${String(err).slice(0, 160)}`)
    return []
  }
}

// ---------------------------------------------------------------------------
// session compact via local HTTP.
// v2 plugin ctx has no compact API, so talk to our own server directly.
// Port discovery: this plugin runs inside the serve process, so enumerate
// its loopback LISTEN ports from /proc/net/tcp{,6} and probe /api/info.
// ---------------------------------------------------------------------------
let cachedServerPort: number | null = null

const findLocalServerPort = async (): Promise<number | null> => {
  try {
    const fs: any = await import("node:fs")
    const parse = (txt: string): number[] => {
      const out: number[] = []
      for (const line of String(txt).split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/)
        if (cols.length < 4) continue
        if (cols[3] !== "0A") continue
        const m = /^([0-9A-Fa-f]+):([0-9A-Fa-f]+)$/.exec(cols[1] ?? "")
        if (!m) continue
        if (m[1] !== "0100007F" && m[1] !== "00000000") continue
        const port = parseInt(m[2], 16)
        if (Number.isFinite(port) && port > 0) out.push(port)
      }
      return out
    }
    let ports: number[] = []
    try {
      ports.push(...parse(fs.readFileSync("/proc/net/tcp", "utf8")))
    } catch {
      /* ignore */
    }
    try {
      ports.push(...parse(fs.readFileSync("/proc/net/tcp6", "utf8")))
    } catch {
      /* ignore */
    }
    for (const p of [...new Set(ports)]) {
      try {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), 1500)
        try {
          const r = await fetch(`http://127.0.0.1:${p}/api/info`, { signal: ctl.signal })
          if (r.ok) {
            const j: any = await r.json().catch(() => null)
            if (j && (j.version || j.pid)) return p
          }
          // 401 也算命中：本机该端口有 HTTP 服务且要认证（serve 的 /api/info 无票必 401），别无分号
          if (r.status === 401) return p
        } finally {
          clearTimeout(timer)
        }
      } catch {
        /* not our server */
      }
    }
    return null
  } catch {
    return null
  }
}

const postLocalAPI = async (sessionID: string, action: string): Promise<unknown> => {
  let port = cachedServerPort
  if (!port) {
    port = await findLocalServerPort()
    if (port) cachedServerPort = port
  }
  const attempt = async (p: number): Promise<unknown> => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 15000)
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/session/${encodeURIComponent(sessionID)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: ctl.signal,
      })
      if (!r.ok) throw new Error(`${action} HTTP ${r.status}`)
      return await r.json().catch(() => ({}))
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    if (!port) throw new Error("local server port undiscoverable")
    return await attempt(port)
  } catch (err) {
    cachedServerPort = null
    const retry = await findLocalServerPort()
    if (retry && retry !== port) {
      cachedServerPort = retry
      return await attempt(retry)
    }
    throw err
  }
}

const compactSession = async (sessionID: string): Promise<unknown> => postLocalAPI(sessionID, "compact")

// 更新会话标题（LOOP 标记）也走本机 API；v2 plugin context 没有稳定的
// session.update 形状，不能把标题标记依赖在某一个 SDK 版本上。
const patchLocalSession = async (sessionID: string, body: Record<string, unknown>): Promise<unknown> => {
  let port = cachedServerPort
  if (!port) {
    port = await findLocalServerPort()
    if (port) cachedServerPort = port
  }
  const attempt = async (p: number): Promise<unknown> => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 15000)
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/session/${encodeURIComponent(sessionID)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
      if (!r.ok) throw new Error(`session PATCH HTTP ${r.status}`)
      return await r.json().catch(() => ({}))
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    if (!port) throw new Error("local server port undiscoverable")
    return await attempt(port)
  } catch (err) {
    cachedServerPort = null
    const retry = await findLocalServerPort()
    if (retry && retry !== port) {
      cachedServerPort = retry
      return await attempt(retry)
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// legacy API-shape converters (kept for standalone tests / diagnostics)
// ---------------------------------------------------------------------------

const toV1AssistMsg = (m: any): any => {
  const content: any[] = Array.isArray(m?.content) ? m.content : []
  const parts: any[] = []
  for (const p of content) {
    if (!p || typeof p !== "object") continue
    if (p.type === "tool") {
      parts.push(toV1ToolPart(p))
    } else if (p.type === "text") {
      parts.push({ type: "text", text: p.text ?? "", time: { created: p.time?.created ?? m.time?.created ?? 0, completed: p.time?.completed ?? m.time?.completed ?? 0 } })
    } else if (p.type === "reasoning") {
      parts.push({ type: "reasoning", text: p.text ?? "", time: { created: p.time?.created ?? m.time?.created ?? 0, completed: p.time?.completed ?? m.time?.completed ?? 0 } })
    }
  }
  const se = m?.id ? stepEndByMsg.get(String(m.id)) : undefined
  if (se && (se.finish || se.tokens > 0)) {
    parts.push({ type: "step-finish", state: { reason: se.finish || "completed", tokens: se.tokens, cost: se.cost, tin: se.tin, tout: se.tout, trea: se.trea } })
  }
  return {
    id: m?.id ?? "",
    info: {
      id: m?.id ?? "",
      role: "assistant",
      time: { created: m?.time?.created ?? 0, completed: m?.time?.completed ?? 0 },
      error: (m?.error ?? null) as any,
      tokens: m?.tokens ?? undefined,
    },
    parts,
  }
}

const toV1UserMsg = (m: any): any => ({
  id: m?.id ?? "",
  info: { id: m?.id ?? "", role: "user", time: { created: m?.time?.created ?? 0 } },
  parts: [{ type: "text", text: m?.text ?? "", time: { created: m?.time?.created ?? 0, completed: m?.time?.created ?? 0 } }],
})

export const toV1Messages = (v2msgs: any[]): any[] => {
  if (!Array.isArray(v2msgs)) return []
  return v2msgs.map((m) => {
    if (!m || typeof m !== "object") return m
    if (m.type === "assistant") return toV1AssistMsg(m)
    if (m.type === "user") return toV1UserMsg(m)
    return { id: m?.id ?? "", info: { id: m?.id ?? "", role: m?.type ?? "system", time: { created: m?.time?.created ?? 0 } }, parts: [] }
  })
}

/**
 * Map v2 server events to the v1 event shapes tg-bridge/auto-continue handle
 * (message.updated / session.created / session.idle). Returns null for events
 * with nothing actionable (caller skips the hook).
 *
 * 收敛去重:不同 v2 事件类型常映射到同一 message.updated(同一 infoId 毫秒级
 * 连发),下游每次都全量重推 → 429。本 Map 做同一进程图内去重;文件记录覆盖
 * 热重载产生的跨图实例。
 */
const convSeen = new Map<string, number>()
const CONV_WINDOW_MS = 4000
const CONV_PATH = "/tmp/opencode/evt-conv.json"
try {
  chmodSync(CONV_PATH, PRIVATE_FILE_MODE)
} catch {
  /* first run; creation below uses mode 0600 */
}
const convDupe = (key: string): boolean => {
  const now = Date.now()
  const mem = convSeen.get(key) ?? 0
  if (now - mem < CONV_WINDOW_MS) return true
  try {
    const j = JSON.parse(readFileSync(CONV_PATH, "utf8")) as Record<string, number>
    if (typeof j?.[key] === "number" && now - (j[key] as number) < CONV_WINDOW_MS) {
      convSeen.set(key, now)
      return true
    }
  } catch {
    /* no record yet */
  }
  convSeen.set(key, now)
  if (convSeen.size > 500) {
    const fk = convSeen.keys().next()
    if (!fk.done) convSeen.delete(fk.value)
  }
  try {
    let j: Record<string, number> = {}
    try {
      j = JSON.parse(readFileSync(CONV_PATH, "utf8")) as Record<string, number>
    } catch {
      j = {}
    }
    j[key] = now
    const keys = Object.keys(j)
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete j[k]
    writeFileSync(CONV_PATH, JSON.stringify(j), { encoding: "utf8", mode: PRIVATE_FILE_MODE })
  } catch {
    /* best-effort */
  }
  return false
}
const latestCompactionId = async (sessionID: string): Promise<string> => {
  try {
    const db = await openDb()
    if (!db) return ""
    const rows = db
      .query("SELECT id FROM session_message WHERE session_id = ? AND type = 'compaction' ORDER BY seq DESC LIMIT 1")
      .all(sessionID) as Array<{ id: string }>
    const id = rows?.[0]?.id
    return typeof id === "string" ? id : ""
  } catch {
    return ""
  }
}

const toV1Event = async (ev: any): Promise<any> => {
  if (!ev || typeof ev !== "object") return ev
  const type = String(ev.type ?? "")
  const data = ev?.data ?? {}
  const sid = String(data.sessionID ?? data.id ?? "")
  if (type === "session.idle" || type === "session.created" || type === "session.deleted") {
    return {
      type,
      properties: {
        sessionID: sid,
        info: { id: data.sessionID ?? data.id ?? "", title: data.title ?? undefined, sessionID: sid },
      },
    }
  }
  if (type === "session.step.ended") {
    rememberStepEnd(sid, String(data.assistantMessageID ?? ""), data)
    const amid = String(data.assistantMessageID ?? "")
    if (!sid || !amid) return null
    const t = data?.tokens ?? {}
    return { type: "message.updated", properties: { sessionID: sid, info: { id: amid, role: "assistant", sessionID: sid, tokens: { input: numOrZero(t.input) } } } }
  }
  if (type === "session.tool.success" || type === "session.tool.failed") {
    const amid = String(data.assistantMessageID ?? "")
    if (!sid || !amid) return null
    return { type: "message.updated", properties: { sessionID: sid, info: { id: amid, role: "assistant", sessionID: sid } } }
  }
  if (type === "session.compaction.ended" || type === "session.compaction.failed" || type === "session.compacted") {
    if (!sid) return null
    // 压缩即清零信号（tg-bridge 侧 takeCompacted 认领后清 ctxUsage）
    if (type !== "session.compaction.failed") {
      compactedFlag.add(sid)
      if (compactedFlag.size > 200) {
        const fk = compactedFlag.values().next()
        if (!fk.done) compactedFlag.delete(fk.value)
      }
    }
    const mid =
      String((data as any)?.messageID ?? (data as any)?.messageId ?? (data as any)?.id ?? "") ||
      (await latestCompactionId(sid))
    return { type: "message.updated", properties: { sessionID: sid, info: { id: mid, role: "assistant", sessionID: sid } } }
  }
  if (
    type === "session.message.completed" ||
    type === "session.message.created" ||
    type === "session.message.content.updated" ||
    type === "session.text.completed" ||
    type === "session.text.ended" ||
    type === "session.reasoning.completed" ||
    type === "session.reasoning.ended"
  ) {
    const mid = String(data.messageID ?? data.assistantMessageID ?? data.id ?? "")
    const role = String(data.role ?? (type.includes("assistant") ? "assistant" : ""))
    if (!sid) return null
    return { type: "message.updated", properties: { sessionID: sid, info: { id: mid, role: role || "assistant", sessionID: sid } } }
  }
  if (type === "session.usage.updated") {
    try {
      const input = numOrZero(data?.tokens?.input)
      if (sid && input > 0) latestTokensBySession.set(sid, input)
    } catch {
      /* ignore */
    }
    return null
  }
  if (type === "session.step.started" || type === "session.step.streamed") return null
  if (!type.startsWith("session.")) return null
  // streaming deltas and other fine-grained events: skip in Phase 1 to avoid
  // re-read storms (completion/tool/step events drive pushes).
  return null
}

export const v2Bridge = (id: string, run: (client: V1Client) => Promise<{ event?: V1Hook } | undefined>): Plugin => ({
  id,
  setup: async (context) => {
    let stop = false
    // 一次性能力快照：宿主 v2 插件 API 没有可查的类型定义，直接把 ctx.session
    // 上可调的方法名打出来，便于定位真正的压缩入口（只打方法名，无凭据）。
    if (!compactCapsLogged) {
      compactCapsLogged = true
      try {
        const names = new Set<string>()
        const sess0 = (context as any)?.session
        const visit = (obj: any, prefix: string, depth: number): void => {
          if (!obj || depth > 1) return
          for (const k of Object.keys(obj)) {
            let v: any
            try {
              v = obj[k]
            } catch {
              continue
            }
            if (typeof v === "function") names.add(`${prefix}${k}`)
            else if (v && typeof v === "object") visit(v, `${prefix}${k}.`, depth + 1)
          }
        }
        visit(sess0, "", 0)
        logLine(id, "info", `ctx.session methods: ${[...names].sort().join(",").slice(0, 1500)}`)
      } catch (err) {
        logLine(id, "error", `ctx.session capability dump failed: ${String(err).slice(0, 160)}`)
      }
      // R1481 的 ctx.tool 自省探针已整体移除。
      //
      // 为什么必须删（不能只加"一次性"守卫）：
      //   那段探针用 tctx.transform(cb) 注册了一个**常驻**回调，回调里又调 tctx.list()。
      //   宿主在每次工具 transform 时都会跑该回调，而 list() 会再次进入 transform 管线，
      //   于是 transform → list() → transform → … 无限递归，最终抛
      //   RangeError: Maximum call stack size exceeded。
      //   宿主把 transform 抛错直接判定为插件故障 → 禁用该插件及其全部依赖：
      //   一次 auto-continue-v2 的探针，连带 opencode.tools、opencode.browser、
      //   opencode.tool.{edit,glob,grep,patch,question,read,shell,skill,subagent,
      //   webfetch,websearch,write} 共 15 个插件一起消失（界面上显示为"17 个插件错误"）。
      //   代价不是日志噪音，而是**整个工具面被摘掉**。
      //
      // 教训：setup 里注册的回调是**长期生效**的，不能当作"一次性探针"随手注册；
      //       任何注册给宿主的回调，一旦内部会再触发宿主管线，就是无限递归。
      //       确实要摸底就读 ctx 上的注册表属性（如 ed.get），不要走会重入的 API。
    }
    // ── 宿主原生能力清单（只记一次，零副作用）────────────────────────────
    // 为什么必须在这里、而不是在 tg-bridge：tg-bridge 拿到的是**我写的 compat shim**，
    // 它上面的方法（createSession 等）是我实现的，`compact` 也是我实现的（内部才失败）。
    // 在 shim 上做"能力探测"会得出**完全错误的结论** —— 我已经犯过一次：
    // 探针打出 "missing[create]" → 差点认定宿主没有创建会话能力，其实只是方法名不同。
    // 这里查的是**宿主原生** context.session，用宿主自己的方法名。
    try {
      const raw = (context as any)?.session
      const fnNames: string[] = []
      const all: string[] = []
      if (raw && (typeof raw === "object" || typeof raw === "function")) {
        for (const k of Object.keys(raw)) {
          all.push(k)
          if (typeof (raw as any)[k] === "function") fnNames.push(k)
        }
        // ⚠️ `Object.keys` 只取**自有可枚举**属性。方法若挂在**原型链**上（`Object.create` /
        // class 实例 / 代理对象），这份清单就会漏 —— 而"漏了一个存在的能力"会让我得出
        // 「宿主不支持」的错误结论（今晚已栽过同类：compat shim ≠ 宿主对象）。
        // 宿主原生 client 也要看：它若带鉴权，`/session/{id}/summarize`、`abort` 就可能可用。
        try {
          const seen = new Set<string>(all)
          let cur: any = Object.getPrototypeOf(raw)
          let hops = 0
          while (cur && cur !== Object.prototype && hops < 4) {
            for (const k of Object.getOwnPropertyNames(cur)) {
              if (k === "constructor" || seen.has(k)) continue
              seen.add(k)
              all.push(k)
              let isFn = false
              try {
                isFn = typeof (raw as any)[k] === "function"
              } catch {
                /* getter 抛异常 → 不算方法 */
              }
              if (isFn) fnNames.push(k)
            }
            cur = Object.getPrototypeOf(cur)
            hops++
          }
          const natClient = (context as any)?.client
          const natSess = natClient?.session
          if (natSess && (typeof natSess === "object" || typeof natSess === "function")) {
            const natKeys: string[] = []
            for (const k of Object.keys(natSess)) {
              let isFn = false
              try {
                isFn = typeof natSess[k] === "function"
              } catch {
                /* ignore */
              }
              if (isFn) natKeys.push(k)
            }
            all.push(...natKeys.map((k) => `client.${k}`))
            fnNames.push(...natKeys)
          }
        } catch (err) {
          logLine("hostcaps", "warn", `proto/client probe failed: ${String(err).slice(0, 120)}`)
        }
        // R1018：查清 `wait` 到底是什么。能力面实测 `have[..., wait]`（R1017），
        // 但插件包里**没有它的类型定义**（`@opencode-ai/plugin` 的 d.ts 里搜不到 wait），
        // 所以语义未知。**如果它是"等会话空闲"，那注入泵现在这套
        // 「轮询 messages + IDLE_SETTLE_MS 静默期 + 最后一条 assistant 是否 completed」
        // 就可以换成宿主原语** —— 而那套启发式我有明确证据的边角问题（代码注释里写着
        // "两轮输出之间"的空档会把正在跑的回合判成空闲）。
        // 打印函数源码是最直接的取证；压缩过所以只取前若干字符。
        // ⚠️ 只打印**函数源码**（不含任何凭据）；本文件另一处已在打方法名，同一类信息。
        try {
          const rawAny = raw as any
          for (const k of ["wait", "generate", "synthetic"]) {
            const fn = typeof rawAny?.[k] === "function" ? rawAny[k] : null
            if (!fn) continue
            const src = String(fn).replace(/\s+/g, " ").slice(0, 220)
            logLine("hostcaps", "info", `session.${k} source: ${src}`)
          }
        } catch (err) {
          logLine("hostcaps", "warn", `fn source probe failed: ${String(err).slice(0, 120)}`)
        }
      }
      // 名单要覆盖 SDK 面存在的名字：`/session/{id}/abort`、`/session/{id}/summarize`、
      // `/session/{id}/shell` 在 SDK 里都存在。若插件面同名方法也存在却没列进 want，
      // 我就会把"没查过"当成"没有"（今晚的老坑）。R1016 顺手补上。
      const want = [
        "create", "createSession", "compact", "interrupt", "abort",
        "messages", "prompt", "promptAsync", "delete", "update", "list", "get",
        "summarize", "shell", "wait", "revert", "fork",
      ]
      const have = want.filter((k) => fnNames.includes(k))
      const miss = want.filter((k) => !fnNames.includes(k))
      const canCreate = fnNames.includes("create") || fnNames.includes("createSession")
      logLine(
        "hostcaps",
        "info",
        `host native session: have[${have.join(",") || "none"}] missing[${miss.join(",") || "none"}] ` +
          `all[${all.slice(0, 24).join(",")}] ` +
          `→ /new ${canCreate ? "可用" : "不可用"} /migrate ${canCreate ? "可用" : "不可用"} ` +
          `compact ${fnNames.includes("compact") ? "有原生入口(待验证)" : "无原生入口"} ` +
          `summarize ${fnNames.includes("summarize") ? "有(待验证)" : "无"} ` +
          `abort ${fnNames.includes("abort") ? "有" : "无(interrupt 是唯一手段)"} ` +
          `shell ${fnNames.includes("shell") ? "有(跑命令,非转后台)" : "无"}`,
      )
      // ── `session.wait`：查过了，**结论是"不是空闲原语"**，所以不再有探针（R1019 收尾）──
      // 过程留档，免得将来重新推导一遍：
      //   ① 源码形状：`wait`/`generate`/`synthetic` **共用同一个事件流订阅包装器**
      //      （订阅 → decode → merge → encode，区别只在过滤的事件类型），形状与"等事件"一致；
      //   ② 8s 超时探针：没抛错、也没立即返回 → 参数形状 `{sessionID}` 被接受，promise 在等；
      //   ③ 拉长到 **120s**：仍未返回 —— 而这 120 秒里会话**正在正常循环**（多次回合完成）。
      //      若它是"等空闲"，至少该返回过一次。
      // → **假设被证伪**。注入泵维持现状（「轮询 messages + 静默期 + completed + 工具 running」
      //   的多信号判定），**不为了"用上新原语"去动一条正在生产运行的链路**。
      // 探针已移除：它每次插件加载都要挂 120 秒 × 2 个实例，而问题已经答完 ——
      // **答案应该变成注释，而不是常驻探针**。
    } catch (err) {
      logLine("hostcaps", "error", `host capability probe failed: ${String(err).slice(0, 160)}`)
    }

    const client: V1Client = {
      app: {
        log: async ({ body }) => {
          logLine(body.service ?? id, body.level ?? "info", body.message ?? "")
          return ""
        },
      },
      session: {
        messages: async ({ path }) => {
          try {
            return { data: await readSessionMessages(path.id) }
          } catch (err) {
            logLine(id, "error", `messages fallback err: ${String(err).slice(0, 160)}`)
            return { data: [] }
          }
        },
        promptAsync: async ({ path, body }) => {
          const text = (body?.parts ?? []).map((p) => p.text ?? "").join("")
          const fn = (context.session as any)?.prompt
          if (typeof fn !== "function") {
            const keys = context.session && typeof context.session === "object" ? Object.keys(context.session).join(",") : typeof context.session
            throw new Error(`v2 ctx.session.prompt missing (session keys: ${keys})`)
          }
          await fn.call(context.session, { sessionID: path.id, text })
          return ""
        },
        compact: async ({ path }) => {
          // 宿主 v2 插件 API 未暴露压缩入口（ctx.session 方法表里没有 compact），
          // /compact 也不在命令目录里，本机 HTTP 又无票（401）。因此只探测一次：
          // 失败即标记不可用，不再每 30 分钟刷一遍形状猜测 + 一次 401。
          // 可用替代：tg-bridge 的 /migrate（带最近摘要迁移到新会话）。
          const sess = context.session as any
          const native = typeof sess?.compact === "function" ? sess.compact : null
          if (native) {
            for (const s of [{ sessionID: path.id, resume: false }, { sessionID: path.id, id: "", resume: false }, { sessionID: path.id }]) {
              try {
                return await native.call(sess, s)
              } catch (err) {
                const msg = String((err as any)?.message ?? err)
                if (!/Missing key|MissingKey|SchemaError/i.test(msg)) {
                  logLine(id, "info", `native compact result (${Object.keys(s).join(",")}): ${msg.slice(0, 200)}`)
                  break
                }
              }
            }
          }
          // slash 命令通道。⚠️ 此处曾写着"宿主只认 { sessionID, name, text }，command/arguments 会被拒"——
          // **那条结论是错的**，来源是一次误读：用 name/text 调用后宿主回 `Missing key`，
          // 我把它读成"这个能力不存在"，而不是"我的请求缺必需键"。
          // 从 opencode 二进制内嵌源码读到的真实签名是 command/arguments（2026-09-26 核实）。
          // 教训：报 Missing key/schema 类错误时，先怀疑**自己的载荷**，别急着给能力判死刑。
          if (typeof sess?.command === "function") {
            try {
              return await sess.command.call(sess, {
                sessionID: path.id,
                command: "compact",
                arguments: "",
              })
            } catch (err) {
              const msg = String((err as any)?.message ?? err).slice(0, 200)
              // ⚠️ 旧代码 `if (!/not\s*found/i.test(msg)) logLine(...)` 把 "not found" **静默吞掉** ——
              // 于是"压缩入口不存在"这件事在日志里完全不可见，害我长期以为"没有任何线索"。
              // 现在无论结果如何都留痕；判定是否是宿主拒绝（not found）决定 info / error。
              const notFound = /not\s*found|unknown command|no such command/i.test(msg)
              logLine(
                id,
                notFound ? "error" : "info",
                `command compact result: ${msg}${notFound ? " → 宿主不认这个命令名（非静默丢弃）" : ""}`,
              )
            }
          }
          // 本机 HTTP 兜底：宿主将来若开放免票即可自动恢复。
          // 闩锁只挡**这里**：它的原意是"别每 30 分钟刷一遍 401"，
          // 而 401 与 native/command 两条路无关 —— 早前把闩锁放在函数开头，
          // 结果一次 401 之后 command 路径在**整个进程内**再也不会被试（实测 164 次秒回
          // "compact unavailable"，真正的原因被这个闩锁藏住了）。
          if (compactUnavailable) throw new Error(COMPACT_UNAVAILABLE_MSG)
          try {
            return await compactSession(path.id)
          } catch (err) {
            const first = !compactUnavailable
            compactUnavailable = true
            // 只在**首次**判定不可用时记一行（原来是每次尝试都记 error → 每 30 分钟一条
            // 永久性噪声，掩盖真错误）。这个事实已由 ctx 后缀如实展示给用户。
            if (first) logLine(id, "info", COMPACT_UNAVAILABLE_MSG)
            throw new Error(COMPACT_UNAVAILABLE_MSG)
          }
        },
        interrupt: async ({ path }) => {
          const fn = (context.session as any)?.interrupt
          if (typeof fn !== "function") throw new Error("v2 ctx.session.interrupt missing")
          await fn.call(context.session, { sessionID: path.id })
          return ""
        },
        createSession: async ({ title }) => {
          const fn = (context.session as any)?.create
          if (typeof fn !== "function") throw new Error("v2 ctx.session.create missing")
          return await fn.call(context.session, title ? { title } : {})
        },
        list: async () => {
          try {
            return { data: await readSessionList() }
          } catch {
            return { data: [] }
          }
        },
        get: async ({ path }) => {
          const nativeClient = (context as any)?.client
          const nativeGet = nativeClient?.session?.get
          if (typeof nativeGet === "function") {
            try {
              const out = await nativeGet.call(nativeClient.session, { path: { id: path.id } })
              return { data: out?.data ?? out }
            } catch {
              /* try the v1-shaped context next */
            }
          }
          const fn = (context.session as any)?.get
          if (typeof fn === "function") {
            try {
              const out = await fn.call(context.session, { sessionID: path.id })
              return { data: out?.data ?? out }
            } catch {
              /* fall through to DB */
            }
          }
          const list = await readSessionList()
          return { data: list.find((s: any) => s?.id === path.id) ?? null }
        },
        update: async ({ path, body }) => {
          const nativeClient = (context as any)?.client
          const nativeUpdate = nativeClient?.session?.update
          if (typeof nativeUpdate === "function") {
            try {
              return await nativeUpdate.call(nativeClient.session, { path: { id: path.id }, body })
            } catch {
              /* try the v1-shaped context next */
            }
          }
          const fn = (context.session as any)?.update
          if (typeof fn === "function") {
            try {
              return await fn.call(context.session, { sessionID: path.id, ...body })
            } catch {
              /* fall through to local HTTP */
            }
          }
          return patchLocalSession(path.id, body)
        },
        latestCompaction: async ({ path }) => {
          try {
            return { data: await readLatestCompaction(path.id) }
          } catch (err) {
            logLine(id, "error", `latestCompaction fallback err: ${String(err).slice(0, 160)}`)
            return { data: null }
          }
        },
      },
    }
    let result: { event?: V1Hook; tool?: Record<string, any> } | undefined
    try {
      result = (await run(client)) ?? {}
    } catch (err) {
      logLine(id, "error", `setup crashed: ${String(err).slice(0, 300)}`)
      result = {}
    }
    // R1483: 同名覆盖内置 shell 的注册已回滚。
    // 实测（R1482）：editor.add({name:"shell"}) 会顶掉内置 shell，但注册项不被运行时接受，
    // 结果该名字下无任何可用工具（宿主报 No tool named "shell" is currently available），
    // 自身 shell 能力被切断；且该改写会变更发往 provider 的 tools 定义。
    // 按用户指令「不要修改发送到服务器的请求」，此处不做任何 tool 覆盖注册。
    // R1487 回滚（用户指令：「就是你改的，快改回去」）：本适配器**完全不碰 ctx.tool**
    //（不 add、不 remove、不 transform），也不再消费 run() 返回的 tool 槽位。
    // 事故链（保留记录，避免重犯）：
    //  1) tg-bridge 的 Hooks.tool.shell 在此被注册为同名插件工具 → 顶掉内置 shell，
    //     宿主报 No tool named "shell" is currently available。
    //  2) 同一注册改写了发往 provider 的 tools 定义 → Console 免费层判定请求并非
    //     「来自 OpenCode 内部」，两个会话持续报
    //     FreeTierError: OpenCode's free tier can only be used from within OpenCode。
    //  3) 用 editor.remove("shell") 补救无效：它作用在有效工具列表上，连内置 shell 一起删，
    //     表现为 shell 时好时坏。
    //  4) 插件 transform 回调留在宿主进程内不可撤销，源码回滚后仍需宿主进程重启才彻底干净。
    const hook = result.event
    if (hook) {
      const iter = (context.event as any).subscribe?.()
      if (iter && typeof iter[Symbol.asyncIterator] === "function") {
        ;(async () => {
          try {
            for await (const ev of iter) {
              if (stop) break
              try {
                if ((ev as any)?.type === "session.idle") {
                  const rsid = String((ev as any)?.data?.sessionID ?? (ev as any)?.data?.id ?? "")
                  logLine(id, "info", `raw session.idle sid=${rsid.slice(0, 12) || "(none)"}`)
                }
                const mapped = await toV1Event(ev)
                if (mapped) {
                  if (mapped.type === "message.updated") {
                    const mp = (mapped as any)?.properties ?? {}
                    const key = `${String(mp.sessionID ?? "")}:${String((mp.info as any)?.id ?? "")}`
                    if (key.length > 1 && convDupe(key)) continue
                  }
                  await hook({ event: mapped })
                }
              } catch (err) {
                logLine(id, "error", `event handler error: ${String(err).slice(0, 200)}`)
              }
            }
          } catch (err) {
            logLine(id, "error", `event loop ended: ${String(err).slice(0, 200)}`)
          }
        })()
      }
    }
    return () => {
      stop = true
    }
  },
})
