// proxy-switch.ts —— 可选功能：出现网络类 provider 错误（速率限制 / ECONNRESET 等）时，
// 通过代理工具（Bettbox / mihomo Clash 内核）提供的**外部控制接口**切换到下一个节点。
//
// 背景（R2495 侦察，2026-10-13）：
//  · 代理工具 = Bettbox（mihomo 内核），外部控制接口 `external-controller: 127.0.0.1:9090`（已在 GUI 打开），
//    `secret: <REDACTED>`。裸节点挂在 `👋 手动选择`（49 个）与 `⚡️ 延迟选优`（URLTest，49 个）下；直连类是 `🌐 全局直连` / `🇨🇳 直连 | *`（要排除）。
//  · R2606（用户指令 2026-10-15）：「代理在延迟选优组中选择！！！不是手动选择组」——
//    操作组由 `👋 手动选择` 改为 `⚡️ 延迟选优`（根组 `🚀 节点选择` 指向它）；手动组不再由本桥操作。
//    实测 mihomo 支持对 URLTest 组 PUT 指定节点：HTTP 204 且 `now` 随之变化（可钉住）。
//  · 插件运行在 **WSL**，WSL2 为 NAT 模式，**连不到** Windows 的 `127.0.0.1:9090`；
//    但可用 Windows 自带的 `curl.exe`（经 WSL 互操作在 Windows 上下文执行）访问该环回接口。
//
// R719b（用户指令 2026-10-15「切换节点应该使用锁定🔐（clash内置功能），而不是强行切换」）：
//  源码（mihomo Alpha: hub/route/proxies.go + adapter/outboundgroup/urltest.go）+ 本机实测双证：
//   · `PUT /proxies/{组} {name:X}` = URLTest.Set(X) = **内置锁定**（fixed=X 立即落下、落
//     cachefile 重启保持；此后组内健康检查不会再改选 = **不漂移**）。
//   · `DELETE /proxies/{组}` = unfixedProxy → ForceSet("") = **解锁**（回「延迟选优」自动）。
//   · 本机实测（2026-10-15 22:4x，单节点测试组）：PUT→204 且 `fixed`=X；DELETE→204 且 `fixed`=""。
//  R722 修正（用户实报「锁定之后其实并没有实际切换」+ 离线实验 2026-10-15 23:3x-23:4x）：
//   · PUT 是**两段式**——`fixed` 立即落下，但 `now`（实际生效/走流量的节点）要等组内**一轮
//     健康检查完成**才跟随（实测 2 节点组 PUT 后 ≤20s 自动跟随；组越大越久）。
//   · 证据：PUT 后 0.4/2.4/5.4s 轮询 now 不变（fixed 已=目标）；≤20s 内自动变为目标。
//   · `/group/{组}/delay`（组级强制测速）会**清掉 fixed**（不可用作催熟）；组健康检查间隔实测 10 分钟。
//  由此本模块：切换后**读回校验 fixed + 等待确认 now 跟随**（日志带 `;lock-ok;now-ok@Ns` /
//  `;lock-ok;now-pending:…`）；锁定质量巡检会确认「锁定生效」（now≠fixed 先补推、仍无效即换节点）；
//  新增 `setNodeLock(on/off)` 供 TG「🔐 锁定当前节点 / 🔓 解锁回自动」。
//
// R2498：把切节点做进 TG（`/proxy`）——新增状态查询 / 手动切指定节点 / 开关自动切 / 最近一次切换记录，
// 并加一条「自动切成功后 → 通知 TG」的跨模块 bus（与 _v2compat 的 inject-notice 同套路：
// 容器挂 globalThis，因 tg-bridge 从 `.v2lib-live/` 快照加载、auto-continue 从活文件加载，
// 两者 import 到的本模块可能是**两个实例**，模块级 Map 会被劈成两半）。
//
// 安全：**默认关闭**（`enabled:false`）。仅当配置打开时才动作；每次切换写日志；有冷却与每小时上限闸。
// 本模块所有导出函数**保证不抛异常**（内部 try/catch），调用方可以 `void` fire-and-forget。

import { spawn } from "node:child_process"
import { readFileSync, writeFileSync, renameSync } from "node:fs"

/** R2559（用户指令「轮换时注意可达性」+ 确认 a+b）：节点可达性探测配置。 */
export interface ProxyProbeCfg {
  /** 总开关，默认 false（可选功能；关闭 = 现有顺序轮换行为**零变化**）。 */
  enabled: boolean
  /** 探测目标 URL（由 **Clash 内核**发起请求，天然绕过 WSL→Windows 环回障碍）。 */
  url: string
  /** 单次探测超时（毫秒）。 */
  timeoutMs: number
  /** 最多连续跳过多少个不可达候选（达到即判 no-reachable / verify-failed）。 */
  maxSkips: number
  /** 方案 B：切换后再校验新节点，不可达则继续轮换（默认 false = 仅方案 A）。 */
  verify: boolean
  /** R2602：可用性延迟阈值（毫秒）。探测到 delay > maxDelayMs 的节点视为不可达，用于避免选中高延迟节点。默认 400ms。 */
  maxDelayMs?: number
  /**
   * R2604（决策 C）：延迟选优的**探测宽度** —— 只在「从当前节点起环绕的前 width 个候选」
   * 内做延迟探测并选最低延迟；`maxSkips` 保留给 verify 兜底（切后校验的续轮换跳数上限）。
   * 未配置时回退 `maxSkips`（向后兼容旧配置）。默认 8。
   */
  width?: number
}
export interface ProxySwitchCfg {
  /** 总开关，默认 false（可选功能）。 */
  enabled: boolean
  /** clash = 调 mihomo 外部控制接口；command = 直接执行 command 字段。 */
  mode: "clash" | "command"
  /** 控制接口基址（Windows 侧可达）。 */
  endpoint: string
  /** 控制接口密钥（Bettbox 生成）。 */
  secret: string
  /** 要操作的分组（Selector / URLTest 均可；其 all 里含裸节点）。R2606：现网 = `⚡️ 延迟选优`（URLTest，PUT 实测 204）。 */
  group: string
  /** 可选：把该顶层分组的当前选择也指向 group，使"指定节点"真正对流量生效。空=不动。 */
  setRoot: string
  /** 手动指定的具体节点名列表；为空则用 group.all 去掉直连类后的全部。 */
  nodes: string[]
  /** 判断"直连类"的排除子串（默认排除 DIRECT/REJECT/直连/🌐）。 */
  excludePatterns: string[]
  /** 触发切换的错误特征子串（大小写不敏感，匹配 error name + message）。 */
  patterns: string[]
  /** 冷却毫秒。 */
  cooldownMs: number
  /** 每小时最多切换次数。 */
  maxPerHour: number
  /** Windows curl.exe 路径（经 WSL 互操作执行，在 Windows 上下文访问环回）。 */
  winCurl: string
  /** mode=command 时执行的命令。 */
  command: string
  /** 是否把每次判定/切换写日志。 */
  log: boolean
  /** R2559：可达性探测（先跳过死节点、切后校验续轮换）。 */
  probe: ProxyProbeCfg
}

export const CFG_PATH = "REDACTED_ROOT/.config/opencode/proxy-switch.json"
/** 最近一次切换记录（供 TG /proxy status 展示；跨实例共享）。 */
export const STATE_PATH = "REDACTED_ROOT/.config/opencode/proxy-switch-state.json"

export const defaultProxySwitchCfg: ProxySwitchCfg = {
  enabled: false,
  mode: "clash",
  endpoint: "http://127.0.0.1:9090",
  secret: "",
  group: "⚡️ 延迟选优",
  setRoot: "",
  nodes: [],
  excludePatterns: ["DIRECT", "REJECT", "直连", "🌐"],
  patterns: [
    "provider.transport",
    "provider.quota",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "socket hang up",
    "fetch failed",
    "rate limit",
    "quota",
    "transport",
  ],
  cooldownMs: 120_000,
  maxPerHour: 6,
  winCurl: "/mnt/c/Windows/System32/curl.exe",
  command: "",
  log: true,
  probe: {
    enabled: false,
    url: "http://www.gstatic.com/generate_204",
    timeoutMs: 3000,
    maxSkips: 8,
    verify: false,
    maxDelayMs: 400,
    width: 8,
  },
}

const asStr = (v: unknown, d: string): string => (typeof v === "string" ? v : d)
const asNum = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d)
const asBool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d)
const asStrArr = (v: unknown, d: string[]): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : d

// R2559：probe 子配置解析（纯函数，可单测）。未知/非法字段一律回退默认。
export const parseProbeCfg = (v: unknown, d: ProxyProbeCfg = defaultProxySwitchCfg.probe): ProxyProbeCfg => {
  const p = (v && typeof v === "object" ? v : {}) as Record<string, unknown>
  return {
    enabled: asBool(p.enabled, d.enabled),
    url: asStr(p.url, d.url),
    timeoutMs: asNum(p.timeoutMs, d.timeoutMs),
    maxSkips: asNum(p.maxSkips, d.maxSkips),
    verify: asBool(p.verify, d.verify),
    maxDelayMs: asNum((p as any).maxDelayMs, (d as any).maxDelayMs ?? 400),
    // R2604（决策 C）：width 未配置时回退 maxSkips（旧配置行为不变）；都缺省则 8。
    width: asNum((p as any).width, (d as any).width ?? d.maxSkips ?? 8),
  }
}

export const readProxySwitchCfg = (): ProxySwitchCfg => {
  const d = defaultProxySwitchCfg
  try {
    const raw = JSON.parse(readFileSync(CFG_PATH, "utf8")) as Record<string, unknown>
    return {
      enabled: asBool(raw.enabled, d.enabled),
      mode: raw.mode === "command" ? "command" : "clash",
      endpoint: asStr(raw.endpoint, d.endpoint),
      secret: asStr(raw.secret, d.secret),
      group: asStr(raw.group, d.group),
      setRoot: asStr(raw.setRoot, d.setRoot),
      nodes: asStrArr(raw.nodes, d.nodes),
      excludePatterns: asStrArr(raw.excludePatterns, d.excludePatterns),
      patterns: asStrArr(raw.patterns, d.patterns),
      cooldownMs: asNum(raw.cooldownMs, d.cooldownMs),
      maxPerHour: asNum(raw.maxPerHour, d.maxPerHour),
      winCurl: asStr(raw.winCurl, d.winCurl),
      command: asStr(raw.command, d.command),
      log: asBool(raw.log, d.log),
      probe: parseProbeCfg(raw.probe, d.probe),
    }
  } catch {
    return { ...d, nodes: [...d.nodes], excludePatterns: [...d.excludePatterns], patterns: [...d.patterns], probe: { ...d.probe } }
  }
}

/** TG /proxy on|off 用：改写配置文件的 enabled 字段（保留其它字段）。返回是否写成功。 */
export const setEnabled = (v: boolean): boolean => {
  try {
    let raw: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(readFileSync(CFG_PATH, "utf8"))
      if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>
    } catch {
      /* 无配置/损坏：以默认键新建 */
    }
    raw.enabled = v
    atomicWrite(CFG_PATH, JSON.stringify(raw, null, 2))
    return true
  } catch {
    return false
  }
}

/** 错误 name + message 命中任一特征即认为需要切节点。 */
export const isNetworkError = (cfg: ProxySwitchCfg, name: string, message: string): boolean => {
  const hay = `${name}\n${message}`.toLowerCase()
  if (!hay.trim()) return false
  return cfg.patterns.some((p) => p && hay.includes(p.toLowerCase()))
}

const isDirectName = (cfg: ProxySwitchCfg, n: string): boolean =>
  cfg.excludePatterns.some((p) => p && n.includes(p))

// ── 原子写（tmp+rename）：与 tg-bridge/_v2compat 同套路，避免读到半截文件。 ──
let atomicSeq = 0
const atomicWrite = (path: string, data: string): void => {
  // R772：同进程多实例（快照 tg-bridge / 活载 auto-continue）并发写同一 path 时，tmp 名带进程号会互撞；
  // 追加单调序号隔离，防交叉内容经 rename 落盘（守卫依赖本文件判"我方锁"，完整性格外重要）。
  const tmp = `${path}.tmp.${process.pid}.${++atomicSeq}`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, path)
}

// ── 最近一次切换记录 ─────────────────────────────────────────────────────────
export type ProxyLastSwitch = { at: number; from: string; to: string; reason: string; via: "auto" | "manual" }

export const readLastSwitch = (): ProxyLastSwitch | null => {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Record<string, unknown>
    return {
      at: asNum(raw.at, 0),
      from: asStr(raw.from, ""),
      to: asStr(raw.to, ""),
      reason: asStr(raw.reason, ""),
      via: raw.via === "manual" ? "manual" : "auto",
    }
  } catch {
    return null
  }
}

// ── 自动切换通知 bus（globalThis 容器，跨模块实例可见）─────────────────────────
export type ProxySwitchEvent = { at: number; from: string; to: string; reason: string; sessionID: string; via: "auto"; detail?: string }
export type ProxyNoticeFn = (e: ProxySwitchEvent) => void | Promise<void>
type ProxyNotifierEntry = { bot: string; fn: ProxyNoticeFn }
const PROXY_NOTIFIER_KEY = "__oc_proxy_notices__"
const proxyNotifierList = (): ProxyNotifierEntry[] => {
  const g = globalThis as { [PROXY_NOTIFIER_KEY]?: ProxyNotifierEntry[] }
  if (!Array.isArray(g[PROXY_NOTIFIER_KEY])) g[PROXY_NOTIFIER_KEY] = []
  return g[PROXY_NOTIFIER_KEY] as ProxyNotifierEntry[]
}
export const registerProxyNotifier = (bot: string, fn: ProxyNoticeFn): void => {
  const arr = proxyNotifierList()
  const idx = arr.findIndex((e) => e.bot === bot)
  if (idx >= 0) arr[idx] = { bot, fn }
  else arr.push({ bot, fn })
}
export const unregisterProxyNotifier = (bot: string): void => {
  const arr = proxyNotifierList()
  const idx = arr.findIndex((e) => e.bot === bot)
  if (idx >= 0) arr.splice(idx, 1)
}
export const fireProxyNotice = (e: ProxySwitchEvent): void => {
  for (const { fn } of [...proxyNotifierList()]) {
    try {
      void Promise.resolve(fn(e)).catch(() => {
        /* best-effort：通知失败不影响切换主链路 */
      })
    } catch {
      /* best-effort */
    }
  }
}

const recordSwitch = (s: {
  from: string
  to: string
  via: "auto" | "manual"
  reason: string
  sessionID?: string
  /** R722：锁定/生效旗标（;lock-ok;now-ok@Ns …），供通知文案如实描述。 */
  detail?: string
}): void => {
  const rec: ProxyLastSwitch = { at: Date.now(), from: s.from, to: s.to, reason: s.reason, via: s.via }
  try {
    atomicWrite(STATE_PATH, JSON.stringify(rec))
  } catch {
    /* 记录失败不影响切换 */
  }
  if (s.via === "auto") {
    fireProxyNotice({ at: rec.at, from: rec.from, to: rec.to, reason: s.reason, sessionID: s.sessionID ?? "", via: "auto", detail: s.detail ?? "" })
  }
}

// ── Clash 接口调用 ───────────────────────────────────────────────────────────
type RunRes = { ok: boolean; code: number | null; out: string; err: string }

const run = (bin: string, args: string[]): Promise<RunRes> =>
  new Promise<RunRes>((resolve) => {
    try {
      const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] })
      let out = ""
      let err = ""
      p.stdout?.on("data", (d) => (out += String(d)))
      p.stderr?.on("data", (d) => (err += String(d)))
      p.on("error", (e) => resolve({ ok: false, code: null, out, err: `${err}${String(e)}` }))
      p.on("close", (code) => resolve({ ok: code === 0, code, out, err }))
    } catch (e) {
      resolve({ ok: false, code: null, out: "", err: String(e) })
    }
  })

const apiGet = (cfg: ProxySwitchCfg, path: string): Promise<RunRes> =>
  run(cfg.winCurl, ["-s", "-m", "8", "-H", `Authorization: Bearer ${cfg.secret}`, `${cfg.endpoint}${path}`])

const apiPut = (cfg: ProxySwitchCfg, path: string, json: string): Promise<RunRes> =>
  run(cfg.winCurl, [
    "-s",
    "-m",
    "8",
    "-X",
    "PUT",
    "-H",
    `Authorization: Bearer ${cfg.secret}`,
    "-H",
    "Content-Type: application/json",
    "--data-binary",
    json,
    `${cfg.endpoint}${path}`,
  ])

// R719b：DELETE 端点 = mihomo 的「解锁」（unfixedProxy → ForceSet("")，清空 selected/fixed）。
// 源码 + 实测双证（2026-10-15 22:4x 于单节点测试组：PUT→fixed=X（HTTP 204）、DELETE→fixed=""）。
const apiDelete = (cfg: ProxySwitchCfg, path: string): Promise<RunRes> =>
  run(cfg.winCurl, ["-s", "-m", "8", "-X", "DELETE", "-H", `Authorization: Bearer ${cfg.secret}`, `${cfg.endpoint}${path}`])

/**
 * 读分组：返回 {now, all, cands, fixed}（cands = 去掉直连类、并按 nodes 收窄后的候选）。
 * `fixed` 即 mihomo 内置**锁定**字段（URLTest 的 selected）：
 *  · 非空 = 已锁定到该节点（fast() 永远返回它，健康检查不会再改选——不漂移）；
 *  · 空 = 未锁定（URLTest 自动选优）；
 *  · undefined = 该内核版本不暴露 fixed 字段（旧版），调用方据此跳过锁定校验（向后兼容）。
 */
export const listGroup = async (
  cfg: ProxySwitchCfg,
): Promise<{ ok: boolean; reason?: string; now?: string; all?: string[]; cands?: string[]; fixed?: string }> => {
  const r = await apiGet(cfg, `/proxies/${encodeURIComponent(cfg.group)}`)
  if (!r.ok) return { ok: false, reason: `get-failed:${(r.err || r.out).slice(0, 160)}` }
  let g: any = null
  try {
    g = JSON.parse(r.out)
  } catch {
    return { ok: false, reason: `get-parse-failed:${r.out.slice(0, 120)}` }
  }
  const all: string[] = Array.isArray(g?.all) ? g.all.map((x: unknown) => String(x)) : []
  const now = String(g?.now ?? "")
  const base = cfg.nodes.length ? cfg.nodes.filter((n) => all.includes(n)) : all
  const cands = base.filter((n) => !isDirectName(cfg, n))
  // R719b：fixed 字段存在性也要保真（旧内核无此字段 → undefined，而非 ""）
  const fixed = typeof g?.fixed === "string" ? String(g.fixed) : undefined
  return { ok: true, now, all, cands, fixed }
}

// ── R2559 可达性探测（方案 A/B） ─────────────────────────────────────────────
/** 候选尝试顺序：从 now 的下一个起环绕，最多 maxSkips 个（纯函数，可单测）。 */
export const candidateOrder = (cands: readonly string[], now: string, maxSkips: number): string[] => {
  const n = cands.length
  if (n === 0 || maxSkips <= 0) return []
  const i = cands.indexOf(now)
  const cap = Math.min(maxSkips, n)
  const out: string[] = []
  for (let k = 1; k <= cap; k++) out.push(cands[(i + k) % n])
  return out
}

/** 探测某节点可达性（Clash 内核侧 delay 测试）。永不抛。 */
export const probeNode = async (
  cfg: ProxySwitchCfg,
  name: string,
): Promise<{ ok: boolean; delay?: number; reason?: string }> => {
  try {
    const q = `url=${encodeURIComponent(cfg.probe.url)}&timeout=${Math.max(1000, Math.floor(cfg.probe.timeoutMs))}`
    const r = await apiGet(cfg, `/proxies/${encodeURIComponent(name)}/delay?${q}`)
    if (!r.ok) return { ok: false, reason: `probe-http:${(r.err || r.out).slice(0, 120)}` }
    let j: any = null
    try {
      j = JSON.parse(r.out)
    } catch {
      return { ok: false, reason: `probe-parse:${r.out.slice(0, 100)}` }
    }
    const delay = Number(j?.delay)
    if (Number.isFinite(delay) && delay > 0) return { ok: true, delay }
    return { ok: false, reason: `probe-fail:${String(j?.message ?? r.out).slice(0, 120)}` }
  } catch (e) {
    return { ok: false, reason: `probe-err:${String(e).slice(0, 120)}` }
  }
}

/** 依次探测 order，返回首个可达节点与已跳过的列表（探测函数可注入以便单测）。 */
export const firstReachable = async (
  order: readonly string[],
  alive: (name: string) => Promise<boolean>,
): Promise<{ next?: string; skipped: string[] }> => {
  const skipped: string[] = []
  for (const c of order) {
    if (await alive(c)) return { next: c, skipped }
    skipped.push(c)
  }
  return { next: undefined, skipped }
}

/** 计算下一个候选节点；用于循环切换。probe.enabled 时跳过不可达节点（方案 A）。 */
export const pickNextNode = async (
  cfg: ProxySwitchCfg,
): Promise<{ ok: boolean; reason?: string; now?: string; next?: string; count?: number; all?: string[]; skipped?: string[] }> => {
  const g = await listGroup(cfg)
  if (!g.ok) return { ok: false, reason: g.reason }
  const cands = g.cands ?? []
  if (!cands.length) return { ok: false, reason: `no-candidates (all=${(g.all ?? []).length}, pinned=${cfg.nodes.length})`, now: g.now, all: g.all }
  const now = g.now ?? ""
  if (!cfg.probe.enabled) {
    const i = cands.indexOf(now)
    const next = cands[(i + 1) % cands.length]
    return { ok: true, now, next, count: cands.length, all: g.all, skipped: [] }
  }
  // R2604（决策 C）：延迟选优只在**有界窗口**内探测 —— 从 now 的下一个起环绕，
  // 取最多 probe.width 个候选（与顺序轮换的候选序一致）。此前全量 `filter(c != now)`
  // 会对全部候选（现网 68 个）并发探测（每个一次 WSL→Windows curl.exe），存在资源/
  // 进程风暴风险；maxSkips 留给 verify 兜底（切后校验的续轮换跳数上限）。
  const rawW = Number(cfg.probe.width ?? cfg.probe.maxSkips ?? 8)
  const width = Number.isFinite(rawW) && rawW >= 1 ? Math.floor(rawW) : 8
  const order = candidateOrder(cands, now, width).filter((c) => c !== now)
  const maxD = cfg.probe.maxDelayMs
  const hasMaxD = typeof maxD === "number" && Number.isFinite(maxD) && maxD >= 0
  const results = await Promise.all(
    order.map(async (c) => {
      const r = await probeNode(cfg, c)
      if (!r.ok) return { name: c, ok: false, delay: Infinity }
      if (hasMaxD) {
        const d = r.delay
        if (typeof d === "number" && Number.isFinite(d) && d > maxD) return { name: c, ok: false, delay: Infinity }
      }
      const d = r.delay
      return { name: c, ok: true, delay: typeof d === "number" && Number.isFinite(d) ? d : Infinity }
    }),
  )
  const reachable = results.filter((x) => x.ok)
  const skipped = results.filter((x) => !x.ok).map((x) => x.name)
  if (reachable.length === 0) {
    return { ok: false, reason: `no-reachable (tried=${order.length}, skipped=${skipped.length})`, now, all: g.all }
  }
  reachable.sort((a, b) => a.delay - b.delay)
  const next = reachable[0].name
  return { ok: true, now, next, count: cands.length, all: g.all, skipped }
}

/** R722：PUT 锁定后等待 now 跟随的上限（实测 2 节点组 ≤20s；轮询带命中早退）。 */
const NOW_FOLLOW_WAIT_MS = 16_000
const NOW_FOLLOW_STEP_MS = 1_000

/** 执行 PUT（分组 + 可选 setRoot）；返回人类可读结果。 */
const applySwitch = async (cfg: ProxySwitchCfg, target: string): Promise<string> => {
  const put = await apiPut(cfg, `/proxies/${encodeURIComponent(cfg.group)}`, JSON.stringify({ name: target }))
  if (!put.ok) return `put-failed:${(put.err || put.out).slice(0, 160)}`
  // R719b（用户指令「切换节点应该使用锁定🔐（clash内置功能），而不是强行切换」）：
  // mihomo 的 URLTest 组上，PUT={name} 就是 Set() → **内置锁定**（fixed=目标节点，立即落下；
  // 解锁=DELETE→ForceSet("")）。但"以为钉住了、实际没钉"曾发生过（旧轮次误判 PUT 为瞬态）：
  // 这里**读回校验 fixed**，让每次切换的锁定证据进日志（;lock-ok / ;lock-missing）。
  // R722（用户实报「锁定之后其实并没有实际切换」）：PUT 锁定是**两段式**——fixed 立即落下，
  // 但 now（实际生效/走流量的节点）要等组内一轮健康检查结束后才跟随（本机实测 2026-10-15：
  // 2 节点组 PUT 后 ≤20s 内 now 自动跟随；组越大越久）。旧代码 PUT 后 1 秒就发「已切换」
  // → 用户当场看面板/测流量其实还没切 → 报「没有效果」。现在 PUT 后**有界等待并确认 now
  // 跟随**（;now-ok@Ns / ;now-pending:…；中途被别的实例改锁则 ;now-abort 早退）——切换
  // 卡片在确认之后才发出，所见即所得。
  let lockSuffix = ""
  let nowSuffix = ""
  try {
    const g2 = await listGroup(cfg)
    if (g2.ok && g2.fixed !== undefined) {
      lockSuffix = g2.fixed === target ? ";lock-ok" : g2.fixed === "" ? ";lock-missing" : `;lock-other:${g2.fixed.slice(0, 36)}`
    }
  } catch {
    /* 校验失败不影响切换本身 */
  }
  if (lockSuffix === ";lock-ok") {
    const t0 = Date.now()
    let sawNow = ""
    try {
      // 首查立即做（重新锁到同一节点/极快场景 t≈0 就命中）；之后每 ~1s 一次，最多 ~16s。
      while (true) {
        const gp = await listGroup(cfg)
        if (gp.ok) {
          if (gp.fixed !== undefined && gp.fixed !== target) {
            nowSuffix = `;now-abort:${(gp.fixed || "(none)").slice(0, 28)}`
            break
          }
          sawNow = gp.now ?? ""
          if (sawNow === target) {
            nowSuffix = `;now-ok@${Math.max(0, Math.round((Date.now() - t0) / 1000))}s`
            break
          }
        }
        if (Date.now() - t0 >= NOW_FOLLOW_WAIT_MS) {
          nowSuffix = `;now-pending:${(sawNow || "?").slice(0, 28)}`
          break
        }
        await new Promise((r) => setTimeout(r, NOW_FOLLOW_STEP_MS))
      }
    } catch {
      if (!nowSuffix) nowSuffix = ";now-pending:check-error"
    }
  }
  if (cfg.setRoot && cfg.setRoot !== cfg.group) {
    const root = await apiPut(cfg, `/proxies/${encodeURIComponent(cfg.setRoot)}`, JSON.stringify({ name: cfg.group }))
    if (!root.ok) return `switched:${target};root-failed:${(root.err || root.out).slice(0, 120)}${lockSuffix}${nowSuffix}`
  }
  return `switched:${target}${lockSuffix}${nowSuffix}`
}

/** 切到下一个节点；返回人类可读结果。永不抛异常。 */
export const switchProxyNode = async (
  cfg: ProxySwitchCfg,
  via: "auto" | "manual" = "auto",
  sessionID = "",
  reason = "",
): Promise<string> => {
  try {
    if (cfg.mode === "command") {
      if (!cfg.command) return "command-empty"
      const r = await run("/bin/bash", ["-lc", cfg.command])
      return r.ok ? `command-ok` : `command-fail:${(r.err || r.out).slice(0, 160)}`
    }
    const p = await pickNextNode(cfg)
    if (!p.ok) return `pick-failed:${p.reason ?? ""}`
    if (!p.next) return `pick-null`
    if (p.next === p.now) return `already:${p.now}`
    const from = p.now ?? ""
    let target = p.next
    let skipped = (p.skipped ?? []).length
    // R719b：把 applySwitch 的锁定校验证据（;lock-ok / ;lock-missing）贯穿到最终返回值，
    // 否则中间层返回串会把它丢掉 → 日志里看不到"这次切换是否真的锁住"。
    // R722：同时贯穿生效确认旗标（;now-ok@Ns / ;now-pending:… / ;now-abort:…）。
    const lockOf = (s: string): string => {
      const flags = s
        .split(";")
        .slice(1)
        .filter((f) => f.startsWith("lock-") || f.startsWith("now-"))
      return flags.length ? `;${flags.join(";")}` : ""
    }
    // R720：TOCTOU 加固 —— 并发场景（两进程几乎同时看到同一错误）进入本函数时，落盘冷却
    // 可能都还没写上；真正切换前**再查一次**跨实例落盘冷却（仅 auto；用户手动点击不受冷却限制）。
    // 实测 14:41:43→14:41:47 曾 4 秒内连切两次（TW→NL）——本次复核即可拦住后来者。
    if (via === "auto") {
      const persisted2 = readLastSwitch()
      if (persisted2 && persisted2.at > 0 && Date.now() - persisted2.at < cfg.cooldownMs) return "cooldown-skip"
    }
    const res = await applySwitch(cfg, target)
    if (!res.startsWith("switched:")) return res
    let lockPart = lockOf(res)
    // 方案 B：切换后校验新节点；不可达则继续沿候选序轮换，直到可达或用尽 maxSkips。
    if (cfg.probe.enabled && cfg.probe.verify) {
      let v = await probeNode(cfg, target)
      let hops = 0
      while (!v.ok && hops < Math.max(1, cfg.probe.maxSkips)) {
        hops++
        const g = await listGroup(cfg)
        if (!g.ok) break
        const order = (g.cands ?? []).filter((c) => c !== target)
        const maxD = cfg.probe.maxDelayMs
        const hasMaxD = typeof maxD === "number" && Number.isFinite(maxD) && maxD >= 0
        const results2 = await Promise.all(
          order.map(async (c) => {
            const r = await probeNode(cfg, c)
            if (!r.ok) return { name: c, ok: false, delay: Infinity }
            if (hasMaxD) {
              const d = r.delay
              if (typeof d === "number" && Number.isFinite(d) && d > maxD) return { name: c, ok: false, delay: Infinity }
            }
            const d = r.delay
            return { name: c, ok: true, delay: typeof d === "number" && Number.isFinite(d) ? d : Infinity }
          }),
        )
        const reachable2 = results2.filter((x) => x.ok)
        const skipped2 = results2.filter((x) => !x.ok).map((x) => x.name)
        skipped += skipped2.length
        if (reachable2.length === 0) break
        reachable2.sort((a, b) => a.delay - b.delay)
        const candidate = reachable2[0].name
        const res2 = await applySwitch(cfg, candidate)
        if (!res2.startsWith("switched:")) break
        target = candidate
        lockPart = lockOf(res2)
        v = await probeNode(cfg, target)
      }
      recordSwitch({ from, to: target, via, reason, sessionID, detail: lockPart })
      return `switched:${target}${skipped ? `;skipped=${skipped}` : ""}${v.ok ? "" : ";verify-failed"}${lockPart}`
    }
    recordSwitch({ from, to: target, via, reason, sessionID })
    return `switched:${target}${skipped ? `;skipped=${skipped}` : ""}${lockPart}`
  } catch (e) {
    return `error:${String(e).slice(0, 160)}`
  }
}

/** 切到指定节点（精确匹配 → 唯一子串匹配）；返回人类可读结果。永不抛异常。 */
export const switchToNode = async (cfg: ProxySwitchCfg, name: string, via: "auto" | "manual" = "manual"): Promise<string> => {
  try {
    // R2499：命令模式（mode:"command"）没有"节点清单"概念，只能循环执行 command；
    // 若在此仍走 Clash GET，会得到一个与用户操作无关的 get-failed 文案。明确拒绝更诚实。
    if (cfg.mode !== "clash") return "unsupported-in-command-mode"
    const q = String(name ?? "").trim()
    const g = await listGroup(cfg)
    if (!g.ok) return `pick-failed:${g.reason ?? ""}`
    if (!q) return "empty"
    const cands = g.cands ?? []
    let target = cands.find((n) => n === q)
    if (!target) {
      const sub = cands.filter((n) => n.includes(q))
      if (sub.length === 0) return `not-found:${q}`
      if (sub.length > 1) return `ambiguous(${sub.length}):${sub.slice(0, 5).join(" | ")}`
      target = sub[0]
    }
    if (target === g.now) return `already:${g.now}`
    const res = await applySwitch(cfg, target)
    if (res.startsWith("switched:")) recordSwitch({ from: g.now ?? "", to: target, via, reason: "" })
    return res
  } catch (e) {
    return `error:${String(e).slice(0, 160)}`
  }
}

/**
 * R719b（用户指令「切换节点应该使用锁定🔐（clash内置功能）」）：锁定/解锁分组。
 *  · on  = PUT {name: 当前节点} → mihomo 内置锁定（fixed=当前节点；此后 URLTest 不再改选，不漂移）；
 *  · off = DELETE → 解锁（ForceSet("")，回到「延迟选优」自动模式）。
 * 两者都做**读回校验**后才报成功，结果字符串带验证状态。永不抛异常。
 */
export const setNodeLock = async (cfg: ProxySwitchCfg, on: boolean): Promise<string> => {
  try {
    if (cfg.mode !== "clash") return "unsupported-in-command-mode"
    const g = await listGroup(cfg)
    if (!g.ok) return `pick-failed:${g.reason ?? ""}`
    if (g.fixed === undefined) return "lock-unsupported" // 旧内核不暴露 fixed 字段
    if (on) {
      const cur = g.now ?? ""
      if (!cur) return "no-current"
      const put = await apiPut(cfg, `/proxies/${encodeURIComponent(cfg.group)}`, JSON.stringify({ name: cur }))
      if (!put.ok) return `put-failed:${(put.err || put.out).slice(0, 160)}`
      const g2 = await listGroup(cfg)
      if (g2.ok && g2.fixed === cur) return `locked:${cur}`
      return `lock-verify-failed:${cur}`
    }
    const del = await apiDelete(cfg, `/proxies/${encodeURIComponent(cfg.group)}`)
    if (!del.ok) return `delete-failed:${(del.err || del.out).slice(0, 160)}`
    const g3 = await listGroup(cfg)
    if (g3.ok && g3.fixed === "") return "unlocked"
    return "unlock-verify-failed"
  } catch (e) {
    return `error:${String(e).slice(0, 160)}`
  }
}

/** 状态查询（供 TG /proxy status）。 */
export const readStatus = async (): Promise<{
  ok: boolean
  reason?: string
  cfg: ProxySwitchCfg
  now?: string
  all?: string[]
  cands?: string[]
  /** R719b：mihomo 内置锁定状态（非空=已锁定到该节点；空=自动；undefined=旧内核不支持）。 */
  fixed?: string
  locked?: boolean
  last: ProxyLastSwitch | null
}> => {
  const cfg = readProxySwitchCfg()
  const last = readLastSwitch()
  if (cfg.mode !== "clash") return { ok: true, cfg, last }
  try {
    const g = await listGroup(cfg)
    if (!g.ok) return { ok: false, reason: g.reason, cfg, last }
    return { ok: true, cfg, now: g.now, all: g.all, cands: g.cands, fixed: g.fixed, locked: g.fixed !== undefined ? g.fixed !== "" : undefined, last }
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 160), cfg, last }
  }
}

let lastSwitchAt = 0
let switchTimes: number[] = []
// R722：锁定节点“健康但未被选中（now≠fixed）”的连续巡检计数（先补推一次 PUT，再无效则换节点）。
const ineffectiveStrikes = new Map<string, number>()
// R807（用户实报「锁定之后其实并没有实际切换」）：PUT 锁定后 `now` 跟随的材料化窗口。
// 口径 = 组内一轮健康检查跑完（源码口径上限 ~10 分钟，组越大越久；小测试组"≤20s"不具代表性）。
// 窗口内 now≠fixed 属正常等待 → 巡检记 pending，不补推、不换节点（防误伤正常材料化）。
const LOCK_MATERIALIZE_MS = 11 * 60_000

/** 冷却 + 频率闸 + 错误匹配后，fire-and-forget 地切换一次。永不抛异常。 */
export const maybeSwitchProxyNode = async (args: {
  name?: string
  message?: string
  sessionID?: string
  log: (level: "info" | "error", msg: string) => unknown
}): Promise<void> => {
  try {
    const cfg = readProxySwitchCfg()
    if (!cfg.enabled) return
    if (cfg.mode === "clash" && !isNetworkError(cfg, args.name ?? "", args.message ?? "")) return
    const now = Date.now()
    if (now - lastSwitchAt < cfg.cooldownMs) return
    // R2501：跨实例冷却。tg-bridge 从 `.v2lib-live/` 快照加载本模块、auto-continue 从活文件
    // 加载，两者拿到的是**两个模块实例**，模块级 `lastSwitchAt`/`switchTimes` 互不可见。
    // 同一次 provider 错误若被两个触发点各看到一次，就会在冷却期内被切两次。以**落盘**的
    // 最近一次切换时间为准（recordSwitch 写 STATE_PATH，跨实例/跨进程可见）做二次闸。
    const persisted = readLastSwitch()
    if (persisted && persisted.at > 0 && now - persisted.at < cfg.cooldownMs) return
    switchTimes = switchTimes.filter((t) => now - t < 3_600_000)
    if (switchTimes.length >= cfg.maxPerHour) return
    // R768（用户指令：「切换节点应该使用锁定🔐（clash内置功能），而不是强行切换」「用户在代理
    // 软件 UI 手动锁定之后，你的所有修改其实并没有生效，这是不对的」「锁定标并没有指向你所选
    // 中的那个节点」）：**外部锁定尊重闸** —— 错误触发的自动切换在动手前先读一次分组，识别
    // "不是我方的锁"：
    //   判据 fixed 非空且 ≠ 落盘 state.to（我方最近一次切换目标）→ 外部（用户 UI）锁定：
    //   · 锁定节点可达（/delay 探测；失败隔 1.2s 复测一次）→ **不覆盖**（记 user-lock-hold；
    //     防"强行切换"把用户在 UI 的锁冲掉造成拉锯）；若 now≠fixed（锁未实际生效）顺手补推
    //     一次 PUT（双管齐下，把锁钉实生效）。
    //   · 锁定节点不可达 → 放行本条自动切换（记 user-lock-dead：换优节点+重锁，保用户在线）。
    //   · fixed 为空（无锁）或 === state.to（就是我方上次的锁）→ 照常切换。
    // 与 lock-watch（180s 巡检、全量服务"当前锁"含外部锁：now≠fixed 首击补推、连续无效/掉质量
    // 才换节点并重锁）互补：巡检管锁质量，本闸管错误触发的换节点。
    if (cfg.mode === "clash") {
      try {
        const g = await listGroup(cfg)
        if (g.ok && g.fixed) {
          const own = readLastSwitch()?.to ?? ""
          if (g.fixed !== own) {
            const lockName = g.fixed
            let alive = (await probeNode(cfg, lockName)).ok
            if (!alive) {
              await new Promise((r) => setTimeout(r, 1200))
              alive = (await probeNode(cfg, lockName)).ok
            }
            // R772（现场：13:33:09 bot3 把我方 auto-continue 并发刚切的 NL-223 误判为"外部锁"并 hold
            // ——其进闸早于对方 record 落盘，own 读到旧记录）：并发竞态修补——探测耗时（≥列表+1~2 次
            // 探测，~1s+）后**终读**一次落盘：若 fixed 已与我方记录一致 → 判我方（防误判 + 防双切），
            // 静默跳过并置节流。
            if ((readLastSwitch()?.to ?? "") === lockName) {
              lastSwitchAt = now
              if (cfg.log) await args.log("info", `proxy-switch: own-late-confirm:${lockName.slice(0, 44)} (并发我方锁，跳过) err=${args.name ?? ""}`)
              return
            }
            if (!alive) {
              if (cfg.log) await args.log("info", `proxy-switch: user-lock-dead:${lockName.slice(0, 44)} -> 代切 err=${args.name ?? ""}`)
            } else {
              lastSwitchAt = now
              let nudge = ""
              if ((g.now ?? "") !== lockName) {
                const put = await apiPut(cfg, `/proxies/${encodeURIComponent(cfg.group)}`, JSON.stringify({ name: lockName }))
                nudge = put.ok ? ";nudge-ok" : ";nudge-failed"
              }
              if (cfg.log) await args.log("info", `proxy-switch: user-lock-hold:${lockName.slice(0, 44)}${nudge} (外部锁定存活，尊重不覆盖; now=${(g.now ?? "").slice(0, 32) || "?"}) err=${args.name ?? ""}`)
              return
            }
          }
        }
      } catch {
        /* 读组失败不阻断切换（宁可行开朗） */
      }
    }
    // R773（现场：13:42:32.788 auto-continue 与 13:42:35.332 bot3 双切同目标 NL-223、双通知×2——
    // 双方闸检查均在对方 record 落盘前通过；TOCTOU 残余第二次现场）：**竞态缩窗复检**——走到这里
    // 已耗时 ~1-3s（listGroup/守卫/选路），期间另一实例可能已完成切换并落盘。动手前终读一次：
    // 落盘时间晚于本次进入（now）→ 对方刚切，放弃本次（单波单切，防双切/双通知）。
    const raced = readLastSwitch()
    if (raced && raced.at > now) {
      lastSwitchAt = now
      if (cfg.log) await args.log("info", `proxy-switch: race-skip:${(raced.to ?? "").slice(0, 44)} (并发实例刚落盘，放弃本次) err=${args.name ?? ""}`)
      return
    }
    lastSwitchAt = now
    switchTimes.push(now)
    const res = await switchProxyNode(cfg, "auto", args.sessionID ?? "", args.name ?? "")
    if (cfg.log) {
      await args.log("info", `proxy-switch: ${cfg.mode} err=${args.name ?? ""} -> ${res}`)
    }
  } catch (e) {
    try {
      await args.log("error", `proxy-switch: exception ${String(e).slice(0, 160)}`)
    } catch {
      /* 日志都失败就静默 */
    }
  }
}

/**
 * R720（用户指令「切换节点应该使用锁定🔐…似乎不会自动切换到锁定的，应该双管齐下」）：
 * **锁定质量监控** —— 锁定（🔐 内置 fixed）与自动切换并存，双管齐下：
 *  · 未锁定 → not-locked，不做任何事（URLTest「延迟选优」自己在优化）；
 *  · 锁定节点健康（可达且 delay ≤ probe.maxDelayMs，R2602 的 400ms 规则）→ ok:<节点>，静默；
 *  · 锁定节点失活/超阈 → 走与网络错误自动切换**同一条路径**（pickNextNode 有界窗口延迟
 *    选优 + 切后校验 + recordSwitch + TG 通知），并在新节点上重新锁定。
 * R807：材料化窗口（LOCK_MATERIALIZE_MS）内 now≠fixed 静默 pending；冷却/每小时上限只拦
 * 「换节点」这一步，不拦「补推」（同目标重锁，不是新切换）；外部锁（≠我方落盘 to）健康时永不换节点。
 * 门闸与 maybeSwitchProxyNode 一致：enabled / 冷却（含跨实例落盘；仅换节点）/ 每小时上限。
 * 永不抛异常；返回诊断字符串（调用方仅在非 ok 时记日志，避免刷屏）。
 */
export const watchLockedQuality = async (): Promise<string> => {
  try {
    const cfg = readProxySwitchCfg()
    if (!cfg.enabled) return "disabled"
    if (cfg.mode !== "clash") return "not-clash-mode"
    const g = await listGroup(cfg)
    if (!g.ok) return `group-failed:${g.reason ?? ""}`
    if (g.fixed === undefined) return "lock-unsupported"
    if (!g.fixed) return "not-locked"
    const now = Date.now()
    const cur = g.fixed
    // R807：冷却/跨实例闸移到「换节点」分支 —— 只拦真正的新切换；补推（同目标重锁）与
    // 材料化检查不受闸（此前闸在函数顶部，锁后数分钟内的巡检全部被 cooldown 静默吞掉）。
    const persisted = readLastSwitch()
    const oursLock = !!persisted && persisted.to === cur
    const sinceSwitch = persisted && persisted.at > 0 ? now - persisted.at : Infinity
    const p = await probeNode(cfg, cur)
    const maxD = cfg.probe.maxDelayMs
    const hasMaxD = typeof maxD === "number" && Number.isFinite(maxD) && maxD >= 0
    const healthy = p.ok && (!hasMaxD || (typeof p.delay === "number" && Number.isFinite(p.delay) && p.delay <= maxD))
    // R722+R807：健康还不够 —— 还要确认锁定**真的生效**（now===fixed）。PUT 锁定材料化
    // 需一轮健康检查（上限 ~10 分钟；此前"实测 ≤20s"只对小测试组成立，大组会久得多）。
    // 材料化窗口内静默等待（pending）；超出后第 1 次补推 PUT，连续 2 次仍无效且是我方锁
    // → 按“掉质量”同路径换到更优节点并重锁（外部锁不换节点，见分支内注释）。
    const effective = g.now === cur
    if (healthy && effective) {
      ineffectiveStrikes.delete(cur)
      return `ok:${cur}`
    }
    if (healthy && !effective) {
      // R807：我方锁 + 材料化窗口内 → 正常等待（静默 pending，不补推不换节点：
      // 窗口内 now 未跟随是两段式设计的预期，此前易被误判为"未生效"）。
      if (oursLock && sinceSwitch < LOCK_MATERIALIZE_MS) return `pending:${cur}`
      const n = (ineffectiveStrikes.get(cur) ?? 0) + 1
      ineffectiveStrikes.set(cur, n)
      if (n === 1) {
        const put = await apiPut(cfg, `/proxies/${encodeURIComponent(cfg.group)}`, JSON.stringify({ name: cur }))
        return `${oursLock ? "ineffective-nudge" : "ext-nudge"}:${cur}${put.ok ? "" : ";put-failed"}`
      }
      // R807：外部锁（fixed≠我方落盘 to）健康时**永不换节点**（尊重用户在 UI 的锁定）；
      // 只留痕，等下一轮巡检（若真掉质量，走上面的 !healthy 分支自然接管——R768 语义）。
      if (!oursLock) return `ext-ineffective:${cur}`
    }
    ineffectiveStrikes.delete(cur)
    // R807：冷却（含跨实例落盘）只拦「换节点」这一步（补推/材料化检查不过闸）。
    if (now - lastSwitchAt < cfg.cooldownMs) return "cooldown"
    if (persisted && persisted.at > 0 && now - persisted.at < cfg.cooldownMs) return "cooldown"
    // 锁定节点掉质量（失活/延迟超阈/锁定长时未生效）→ 与错误自动切换同一路径（内部另有 maxPerHour 闸）
    switchTimes = switchTimes.filter((t) => now - t < 3_600_000)
    if (switchTimes.length >= cfg.maxPerHour) return "max-per-hour"
    lastSwitchAt = now
    switchTimes.push(now)
    const res = await switchProxyNode(cfg, "auto", "", "lock-quality")
    return `quality->${res}`
  } catch (e) {
    return `error:${String(e).slice(0, 160)}`
  }
}

// reload(proxy-switch) 1792158294 R773 race-skip-recheck

// reload(proxy-switch) 1792165450 R807 lock-materialize-window
