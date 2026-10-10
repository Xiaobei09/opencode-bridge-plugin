import type { Plugin } from "@opencode-ai/plugin"
import { chmodSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync, globSync, statfsSync } from "node:fs"
import { readSessionUsage, takeCompacted, readSessionListSync, compactUnavailableNow, offsetRewindTarget, registerInjectNotifier } from "./_v2compat"
// 自动停止守卫的判据与配置（auto-continue 侧用同一份，避免两侧判据漂移）。
import { readGuard, writeGuard, readGuardLastTrip, parseGuardArg, DEFAULT_GUARD, type GuardCfg } from "./loop-guard"
import { inboundSilenceVerdict } from "./inbound-silence"
// 「转后台」：原生后台子代理的能力探测 + 整体自动配置（bg-mode 里有纯函数判据与单测）。
import { readBg, writeBg, parseBgArg, bgApiShape, bgApiLabel, bgEnvOn, shouldAutoPromote, BG_ENV_VAR, DEFAULT_BG, BG_TH_STEPS } from "./bg-mode"
// TG 等宽表格绘制（纯函数 + 单测）：状态/诊断类消息用表格对齐（代码块强制等宽）。
import { renderTgTable, renderKvList } from "./tabular"
// 压缩通知的文案判据（纯函数 + 单测）：核心是「未知 ≠ 0」，见 compact-notice.ts 头注。
import { compactWaterLine, compactLogDelta, compactHowLine, compactTitle } from "./compact-notice"
// R1565：「AI 主动结束输出」短提示文案（纯函数 + 单测），见 turn-end-note.ts 头注。
import { turnEndLine, extractRound, noteSkipped, SYNTHETIC_LOOP_MARKERS, noteOwnerOnlySkipped } from "./turn-end-note"
import { appendShellBgHint, hasShellBgHint, isFreshRunningCard, HINT_FRESH_MS_DEFAULT } from "./bg-hint"

// ── R1399：插件 client 白名单无 background 端点时的直连宿主 HttpApi 兜底 ────────
// 背景：R1398 实证 v2.0.10 的插件 client 只含白名单子集（session 键无 background/），
// 「转后台」在桥内必须走 HTTP 直连。凭证=opencode2 自己的服务注册
// ~/.local/state/opencode/service.json（url+password）；鉴权=Basic base64("opencode:"+pw)
// （2026-09-28 curl 实证：POST /api/session/{sid}/background → 204，空闲会话 no-op）。
const bgHttpPromote = async (sid: string): Promise<{ ok: boolean; text: string }> => {
  try {
    const home = process.env.HOME ?? "/root"
    const reg = JSON.parse(readFileSync(`${home}/.local/state/opencode/service.json`, "utf8")) as {
      url?: string
      password?: string
    }
    const url = String(reg?.url ?? "").replace(/\/+$/, "")
    const pw = String(reg?.password ?? "")
    if (!url || !pw) return { ok: false, text: "✗ 服务注册不可读（service.json 缺 url/password）" }
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
    return { ok: false, text: `✗ 直连失败：${String(err).slice(0, 120)}` }
  }
}
// 直连宿主 HttpApi 是否可用（service.json 同时含 url 与 password）。手动提升与自动提升共用此判据。
const bgHttpAvail = (): boolean => {
  try {
    const reg = JSON.parse(readFileSync(`${process.env.HOME ?? "/root"}/.local/state/opencode/service.json`, "utf8")) as {
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
type CtxUsage = { at?: number; noCache?: boolean; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; modelID: string; providerID: string }
const ctxUsage = new Map<string, CtxUsage>()
const modelWindows = new Map<string, number>()
let modelWinTs = 0
const ctxTotal = (u: CtxUsage): number => u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite
export const windowFor = (modelID: string, providerID: string): number =>
  modelWindows.get(`${providerID}/${modelID}`) ?? 1048576
// R1881：窗口是**实取**还是**兜底猜的** —— 必须能区分。兜底常量 1048576 曾被当真实
// 窗口显示（用户实报「默认模型的上下文是1m」），而实测默认模型 `opencode/big-pickle`
// 的真实窗口是 **200000** → 显示值错 5 倍，连带自动压缩阈值也算松 5 倍。
export const windowKnown = (modelID: string, providerID: string): boolean =>
  modelWindows.has(`${providerID}/${modelID}`)
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
const noteUsage = (sid: string, info: any): void => {
  try {
    const t = info?.tokens
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)
    const inp = num(t?.input)
    const cacheR = num(t?.cache?.read)
    const cacheW = num(t?.cache?.write)
    // 口径修正：只看 `input` 是**不完整**的 —— 缓存前缀本身就是上下文，宿主完全可能只报
    // cache 而把 input 报 0。旧实现在这里整个早退 → ctxUsage 不更新 → 卡片上的 ctx 会
    // **长期停在旧值**（只靠"（N 分钟前）"标注兜底）。实测采样间隔 3-12 分钟、远大于 5 分钟
    // 节流，正是这个原因：多数轮次只带 cache 不带 input。
    if (inp <= 0 && cacheR + cacheW <= 0) return
    // 口径守卫：一次调用的 prompt 不可能超过模型窗口。超过 = 一定是累计值，丢弃。
    // 附加特征：output/reasoning/cache 全 0 而 input 巨大 —— 真实调用不会没有输出。
    {
      const modelID = String(info?.model?.id ?? "")
      const providerID = String(info?.model?.providerID ?? "")
      const win = windowFor(modelID, providerID)
      const others = num(t?.output) + num(t?.reasoning) + num(t?.cache?.read) + num(t?.cache?.write)
      if (inp > win || (inp > 4 * 1024 * 1024 && others === 0)) {
        ctxLifetimeRejected++
        if (ctxLifetimeRejected <= 5 || ctxLifetimeRejected % 50 === 0) {
          diag(
            `ctx usage rejected (looks like session-lifetime counter, not context size): sid=${sanitizeLog(sid).slice(0, 12)} in=${fmtK(inp)} win=${fmtK(win)} others=${fmtK(others)} (rejected x${ctxLifetimeRejected})`,
          )
        }
        return
      }
    }
    // 无缓存计数时，这个数字是**下界**：TUI 会把命中的缓存前缀算进窗口，事件里若没有
    // cache.read 就少算一截（用户报"显示 9%，实际 13%"）。所以要标出来，不能假装精确。
    const cacheRead = num(t?.cache?.read)
    const cacheWrite = num(t?.cache?.write)
    if (Date.now() - (ctxProvLogAt.get(sid) ?? 0) > 5 * 60_000) {
      ctxProvLogAt.set(sid, Date.now())
      const w2 = windowFor(String(info?.model?.id ?? ""), String(info?.model?.providerID ?? ""))
      const tot2 = inp + num(t?.output) + num(t?.reasoning) + cacheRead + cacheWrite
      diag(
        `ctx usage recorded sid=${sanitizeLog(sid).slice(0, 14)} in=${inp} out=${num(t?.output)} rea=${num(t?.reasoning)} ` +
          `cr=${cacheRead} cw=${cacheWrite} win=${w2} pct=${(tot2 / w2 * 100).toFixed(1)} noCache=${cacheRead + cacheWrite === 0}`,
      )
    }
    ctxUsage.set(sid, {
      at: Date.now(),
      noCache: cacheRead + cacheWrite === 0,
      input: inp,
      output: num(t?.output),
      reasoning: num(t?.reasoning),
      cacheRead: cacheR,
      cacheWrite: cacheW,
      modelID: String(info?.model?.id ?? ""),
      providerID: String(info?.model?.providerID ?? ""),
    })
    if (ctxUsage.size > 100) {
      const fk = ctxUsage.keys().next()
      if (!fk.done) ctxUsage.delete(fk.value)
    }
  } catch {
    /* ignore */
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
 * 为什么需要它：本桥**没有压缩入口**（调不动 compact），所以水位没人管 —— 用户得自己盯着
 * 百分比。40% / 60% 两档各主动提醒一次，让用户有时间决定 `/new` 或 `/migrate`。
 * ⚠️ 修正过一次的错误认知（2026-09-26）：这里原来写的是"本宿主没有压缩入口，而 ctx 只增不减"。
 * 后半句**已被证伪** —— 15:36 实测宿主自己把 48% 压到了 4%。压不住的是**本桥**，不是宿主。
 * 留着错注释的代价：下一次会照着它得出相反的结论。
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
    if (pct < 1) return " · ctx <1%"
    // 本宿主没有压缩入口时必须**说清楚**，否则用户会以为"该压缩却没压"（实测被问到）。
    // ⚠️ 这句话以前写的是「本宿主不可压缩」—— **已被今天证伪**：2026-09-26T15:36 实测
    // 宿主自己把 48% 压到了 4%。不可压缩的是**本桥调不动 compact 接口**，不是宿主不会压。
    // 写错的后果很具体：用户在手机上看到"不可压缩"，就不会相信 ctx 真的降了。
    const noCompact = pct >= 50 && compactUnavailableNow() ? " · ⚠️本桥不能主动压缩（宿主会自己压）" : ""
    // 缺缓存计数 → 显示下界（≥），并说明原因。宁可写"至少 9%"，也不给人一个偏低的确定值。
    const mark = u.noCache ? "≥" : ""
    const notes: string[] = []
    if (u.noCache) notes.push("无缓存计数")
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
    // 本桥没有压缩入口（宿主会自己压，见上面 noCompact 的注释）。等到撞墙才发现
    // 就晚了，所以 40% / 60% 两档各主动提醒一次，让用户有时间决定 /new 或 /migrate。
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
    ctxAdvisoryFn?.(sessionID, pct, u.noCache === true, ageS)
    const note = notes.length > 0 ? `（${notes.join("，")}）` : ""
    return ` · ctx ${mark}${Math.round(pct)}%${noCompact}${note}`
  } catch {
    return ""
  }
}

// 关键约束：LOOP_CTL_PATH 必须**保持共享**（自动循环总闸是全局的，两个 Bot 共用）。
const LOOP_CTL_PATH = "REDACTED_ROOT/.config/opencode/loop-ctl.json"
// R1724（用户指令「不同机器人的循环设置要求单独」）：本 Bot 是否处于循环停止态。
// 纯函数 —— 桥侧 20 处 loopStopped() 判定全走它，单测可直接钉行为（不必起桥）。
//   * 顶层 stopped=true = 全局闸（守卫 PROBLEM/WEBSEARCH、/loop stop all）→ 一律停；
//   * bots[botId].stopped=true = 单 Bot 闸；sids 为空视为「本 Bot 全停」，
//     非空则要求包含当前 front（front 切换后旧会话自动恢复，与 auto-continue 同判据）。
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
    return "wrote"
  } catch {
    return "err"
  }
}

// ---------------------------------------------------------------------------
// R1895：跨 Bot 429 限流标记（用户指令：「可以使用其他的机器人各发一条提示这个机器人
// 429 的消息」「如果被限流的话，应该回复一条被限流的提示吧」）。
//
// 为什么必须由**别的** Bot 来说：硬限流期间本 Bot 一条消息都发不出去（Telegram 限的是
// 整个 Bot，不只是某个方法），本地闸门 429 一到就把全部出站请求挡下 —— 让被限流者自己
// 提示用户是结构性做不到的，硬发也只是进队列一起等。可行形态只有：谁被限流 → 写共享
// 标记；**其他实例**读到后各自替它发一条（一条/Bot/每次限流，去重）。
//
// 为什么单独一个文件而不是塞进 loop-ctl.json：那是**自动循环总闸**（auto-continue 也在
// 读写，R1891 起按读旧值合并），把 15s 一拍的瞬时限流状态混进去等于让热路径污染总闸；
// 且标记写失败只应损失"提醒"这个增值功能，绝不能连累总闸。独立文件 + atomicWrite，
// 失败即忽略（best-effort）。
export const FLOOD_FLAG_PATH = "REDACTED_ROOT/.config/opencode/bot-flood.json"

export type FloodFlagEntry = { since: number; until: number }
export type FloodFlagDisk = Record<string, FloodFlagEntry | undefined>

// 纯函数：把「本 Bot 进入/续期限流」合并进磁盘快照。
//   · until 取 max —— 与 mergeRename429Until 同一并发口径：read-modify-write 的两个进程
//     不会互相把冷却改短；
//   · 已过期条目（until <= now）就地丢弃 —— 否则"上次限流的残留"会让 since 永远续不上
//     新一轮的起点，提醒文案里的"已持续多久"就错了；
//   · 同一次限流续期**保留原 since** —— 用户要看到的是"从几点起被限流"，续期不能重置起点。
export const mergeFloodFlag = (disk: FloodFlagDisk, bot: string, now: number, until: number): FloodFlagDisk => {
  const out: FloodFlagDisk = {}
  for (const [k, v] of Object.entries(disk)) {
    const u = Number(v?.until) || 0
    const s = Number(v?.since) || 0
    if (u > now && s > 0) out[k] = { since: s, until: u }
  }
  const prev = out[bot]
  out[bot] = { since: prev ? prev.since : now, until: Math.max(prev?.until ?? 0, until) }
  return out
}

// 纯函数：此刻**仍处于限流中**的条目（按 bot 名排序，调用方遍历顺序稳定、便于测试断言）。
export const activeFloods = (disk: FloodFlagDisk, now: number): Array<{ bot: string } & FloodFlagEntry> => {
  const out: Array<{ bot: string } & FloodFlagEntry> = []
  for (const [bot, v] of Object.entries(disk)) {
    const u = Number(v?.until) || 0
    if (!(u > now)) continue
    out.push({ bot, since: Number(v?.since) || u, until: u })
  }
  return out.sort((a, b) => (a.bot < b.bot ? -1 : a.bot > b.bot ? 1 : 0))
}

const readFloodFlagDisk = (): FloodFlagDisk => {
  try {
    const j = JSON.parse(readFileSync(FLOOD_FLAG_PATH, "utf8")) as { floods?: unknown }
    if (j && typeof j === "object" && j.floods && typeof j.floods === "object") return j.floods as FloodFlagDisk
  } catch {
    /* 不存在 / 损坏：按空快照处理（下次写盘即重建） */
  }
  return {}
}
const writeFloodFlagDisk = (floods: FloodFlagDisk): void => {
  atomicWrite(FLOOD_FLAG_PATH, JSON.stringify({ floods }), 0o600)
}

// 进入（或续期）限流时调用。任何异常都吞掉：提醒功能绝不能影响发送路径。
export const markSelfFlooded = (bot: string, until: number, now = Date.now()): void => {
  try {
    writeFloodFlagDisk(mergeFloodFlag(readFloodFlagDisk(), bot, now, until))
  } catch {
    /* best-effort */
  }
}

// 恢复后调用：清掉自己的条目（其他实例不再把它算作"限流中"）。
// 条目本就不存在/已过期则**不写盘** —— 否则 15s 一拍的心跳会变成持续空写。
export const clearSelfFlooded = (bot: string, now = Date.now()): void => {
  try {
    const disk = readFloodFlagDisk()
    if (!(bot in disk)) return
    if ((Number(disk[bot]?.until) || 0) <= now) return
    const next: FloodFlagDisk = {}
    for (const [k, v] of Object.entries(disk)) {
      if (k === bot) continue
      const u = Number(v?.until) || 0
      if (u > now) next[k] = { since: Number(v?.since) || u, until: u }
    }
    writeFloodFlagDisk(next)
  } catch {
    /* best-effort */
  }
}

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

const PRIVATE_FILE_MODE = 0o600
const STRIP_RUN_INTERVAL_MS = 10 * 60_000
const COMMAND_CACHE_MAX_AGE_MS = 6 * 60 * 60_000
const VERSION = "r1121-flood-cross-notice"

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

let CONFIG_PATH = "REDACTED_ROOT/.config/opencode/tg.env"
// 默认**关闭**备用投递通道（fail-closed）。
// 此前默认值就是那个 env 路径，于是"配置里没显式关掉"就等于"通道开着" —— 启动自检
// 实测主 Bot 的 fallbackApiBase=set，而用户明确要求过关闭备份发送机制。
// 现在只有入口显式传入 fallbackEnvPath 才会打开；两个 Bot 默认都只用自己的 token。
let FALLBACK_ENV_PATH: string | null = null
let STATE_PATH = "REDACTED_ROOT/.config/opencode/tg-chats.json"
let OWNER_PATH = "/tmp/opencode/tg-poll-owner.json"
let COMMAND_CACHE_PATH = "/tmp/opencode/tg-command-cache.json"
let STRIP_STATE_PATH = "/tmp/opencode/strip-run.json"
let STRIPFAIL_PATH = "/tmp/opencode/stripfail.json"
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
// R1597：note 的"安静窗"——完成不足该毫秒数的消息不评估（宿主注入下一条循环提示
// 通常秒级到达，20s 轮询可能撞在注入前把续跑中的回合误判成停摆 → 主实例偶发
// 「输出结束」）。40s 后仍无续跑提示才算真正停摆。env TG_TURN_NOTE_QUIET_MS 可调。
const AC_MIN_ROUND_MS = Number(process.env.AC_MIN_ROUND_MS ?? 90_000) || 90_000
const TURN_NOTE_QUIET_MS = Number(process.env.TG_TURN_NOTE_QUIET_MS ?? "") || AC_MIN_ROUND_MS + 30_000
const PROTO_RETRY_MAX_ATTEMPTS = Number(process.env.TG_PROTO_RETRY_MAX_ATTEMPTS ?? "") || 12 // R1889 重试总额度（12 次 ≈ 退避累计 5 分钟）；理由见 run() 内 retry 分支的注释

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
    out.__stripped = [...strippedKb].slice(-500)
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
const filt = (k: "reply" | "think" | "tool" | "status"): FilterMode => filters[k] ?? 2
const setFilt = (k: "reply" | "think" | "tool" | "status", v: number): void => {
  filters[k] = v === 0 ? 0 : v === 1 ? 1 : 2
  savePersistedState()
}
// 压缩设置（/quiet 菜单可调，auto-continue 侧实时读取）：auto=false 停掉一切自动压缩尝试；threshold 为 ctx 水位门控
const compactPrefs: { auto: boolean; threshold: number } = { auto: true, threshold: 0.7 }
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
  const outTail = outText.length > OUT_TAIL ? outText.slice(0, 120) + "\n…（略）…\n" + outText.slice(-OUT_TAIL) : outText
  const inTail = inText.length > IN_TAIL ? inText.slice(0, IN_TAIL) + "\n…（略）…" : inText
  const lines: string[] = [`<b>🔧 ${htmlEsc(disp)} 执行 · 开始 ${clock}${htmlEsc(ctxSuffix(sessionID))}</b>`]
  // ① edit 类工具补 diff 区（与事件路径 inputZone 的形状对齐：📥 变更 + language-diff）
  const rawInObj = (rawIn && typeof rawIn === "object" ? rawIn : {}) as Record<string, unknown>
  const oldStr = (rawInObj.oldString ?? (st.metadata as any)?.oldString) as string | undefined
  const newStr = (rawInObj.newString ?? (st.metadata as any)?.newString) as string | undefined
  const isEditLike = /^(edit|write|patch|multiedit|apply_patch|str_replace)$/i.test(name)
  const diffBody =
    isEditLike && (typeof oldStr === "string" || typeof newStr === "string")
      ? `--- a\n${(oldStr ?? "").slice(0, 600)}\n+++ b\n${(newStr ?? "").slice(0, 600)}`
      : ""
  // ② 语言标记：结构化入参/输出按 JSON 上色（原先三处 box("") → 高亮全丢，探针实测 language-* = 0）
  const looksJson = (t: string): boolean => /^[\s]*[[{]/.test(t)
  const inLang = typeof rawIn === "string" ? "" : looksJson(inText) ? "json" : ""
  const outLang = looksJson(outText) ? "json" : ""
  if (diffBody) lines.push("\n📥 变更\n" + box("diff", diffBody))
  else if (inTail) lines.push("\n📥 入参\n" + box(inLang, inTail))
  if (outTail) lines.push("\n📤 输出\n" + box(outLang, outTail))
  if (errText) lines.push("\n" + box("", errText.slice(0, 500)))
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

// ── 格式保全：只替换那一行状态，其余一个字节都不动 ──────────────────────────
// 结构性原因：工具卡正文**从不落盘**（读回来是 text: ""），所以重载后看门狗**没有能力**
// 保留你原本那张卡，只能整张替换成简版终态卡 → 卡面从"完整卡"变成"简版卡"，
// 用户看到的就是"格式坏了"。现在正文有界落盘，终态时**就地替换**"仍在执行中"那一行。
// 没有锚点（首次/遗留卡/header-only 标题卡）→ 照旧退回整张重渲染。
const STILL_NOTE_RE = /⏳ 仍在执行中（已[^）]*）/
// 事件路径自己发的执行中标记（**最常见的一种**）。此前只认上面那句看门狗标记，
// 而绝大多数卡片上根本没有那句 → 实测 card mode=patch 只有 2、rerender 却有 12。
// 认了它之后，"发出去时就是执行中、随后才查到期"这条主路径也能就地替换。
const EVENT_RUNNING_RE = /<blockquote>⏳ 执行中…<\/blockquote>/
// 终态正文里**不许**残留"运行中"标记 —— 用户在 R1022 抓到一张同时显示
// 「⏳ 执行中…」和「✅ 已完成（…已按真实状态纠正…）」的卡。
// 为什么在**发送边界**统一拦，而不是去追每个产生者：写终态的路径有两条
// （`patchStillNote` 的就地替换、以及两处"追加纠正块"），追加的基底又来自落盘副本，
// 组合方式不止一种。**在 `sendTextRaw`/`editTextRaw` 这两个出口一次性保证**，
// 比追每条产生路径更可靠 —— 与当初修"截断截坏标签"是同一个思路。
// 纯函数，便于行为测试。
const RUNNING_MARKERS = [/<blockquote>⏳ 执行中…<\/blockquote>/g, /⏳ 仍在执行中（已[^）]*）/g]
const TERMINAL_RE = /(✅ 已完成|✅ 成功|❌ 失败|⚠️ 完成)/
// ⚠️ 必须**跳过代码块**（`<pre>…</pre>` / `<code>…</code>`）—— 那里印着工具的输入/输出
// **数据**，而数据里完全可能出现同名标记（R1022 实测：一张卡的正文就是我自己的巡检输出，
// 里面印着「⏳ 出现次数: 1 | ✅ 出现次数: 1」；另一张印着我写的测试文件）。
// 不跳过就会把**用户要看的输出**删掉 —— 那比"多显示一个状态"严重得多。
// 这是今晚第 10 次"关键词撞上工具输入文本"型陷阱（R973 栽过一次，我没吸取）。
const CODE_BLOCK_RE = /<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/g
const stripOutsideCode = (text: string, fn: (seg: string) => string): string => {
  let out = ""
  let last = 0
  CODE_BLOCK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CODE_BLOCK_RE.exec(text)) !== null) {
    out += fn(text.slice(last, m.index)) + m[0]
    last = m.index + m[0].length
  }
  out += fn(text.slice(last))
  return out
}
export const dropStaleRunning = (text: string): string => {
  if (!text || !TERMINAL_RE.test(text)) return text
  const out = stripOutsideCode(text, (seg) => {
    let s2 = seg
    for (const re of RUNNING_MARKERS) s2 = s2.replace(re, "")
    return s2
  })
  // 删完可能留下连续空行，压成两个换行（不引入手工裁剪的边界问题）
  return out.replace(/\n{3,}/g, "\n\n").trim()
}

// 纠正文案的**唯一**出处。此前有两份（`patchStillNote` 内联 + 启动回扫内联），
// 措辞还差一个"一直"字 —— 两份知识迟早分叉（同 HTML 配平那次教训）。
export const stillNoteMsg = (status: string, mins: number): string =>
  status === "completed"
    ? `✅ 已完成（此卡片之前显示“执行中”，已按会话真实状态纠正；卡住约 ${mins} 分钟）`
    : `❌ 失败（此卡片之前显示“执行中”，已按会话真实状态纠正；卡住约 ${mins} 分钟）`

export const patchStillNote = (text: string, status: string, mins: number): string | null => {
  if (!text) return null
  // 两种锚点：① 看门狗自己的"仍在执行中（已 N 分钟）"；② 事件路径发的"⏳ 执行中…"块引用。
  // 认 ② 是本轮的关键 —— 它才是绝大多数卡片上真实存在的锚点。
  if (!STILL_NOTE_RE.test(text) && !EVENT_RUNNING_RE.test(text)) return null
  const msg = stillNoteMsg(status, mins)
  // ⚠️ 两处替换都必须在**代码块之外**做（R1023 的教训，R1024 补齐同类）：
  // 工具的输入/输出就印在 <pre><code> 里，而数据里完全可能出现这两个标记的字面量 ——
  // 实测我自己的卡片就印着「⏳ 仍在执行中（已 N 分钟）」这类文本。
  // 全局 replace 会**把用户要看的输出改掉**，那比"多显示一个状态"严重得多。
  if (STILL_NOTE_RE.test(text)) {
    return stripOutsideCode(text, (seg) => seg.replace(new RegExp(STILL_NOTE_RE.source, "g"), msg))
  }
  // 事件路径的锚点连整个 blockquote 一起换掉，保持原有视觉结构（引用块 + 状态）
  return stripOutsideCode(text, (seg) =>
    seg.replace(new RegExp(EVENT_RUNNING_RE.source, "g"), `<blockquote>${msg}</blockquote>`),
  )
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
export const loadHaltedInto = (hl: unknown, into: Set<string>): number => {
  if (!Array.isArray(hl)) return 0
  let n = 0
  for (const s of hl) if (typeof s === "string" && s) { into.add(s); n++ }
  return n
}
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
const CMD_ALIAS: Record<string, string> = { u: "use", s: "sessions", r: "replay", q: "quiet", l: "loud" }
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
let flushing = false
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
          pinQueue.push({ id: typeof o.id === "string" && o.id ? o.id : `restored-${typeof o.ts === "number" ? o.ts : 0}-${pinQueue.length}`, sid: o.sid, text: o.text, ctx: typeof o.ctx === "string" ? o.ctx : "", chat: o.chat, ts: typeof o.ts === "number" ? o.ts : 0 })
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
            text: typeof item[4] === "string" ? item[4] : "",
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
      for (const k of sk.slice(-200)) if (typeof k === "string" && k) strippedKb.add(k)
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
          for (const k of kb.slice(-500)) if (typeof k === "string") strippedKb.add(k)
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
    const cp = j?.compact
    if (cp && typeof cp === "object") {
      if ((cp as any).auto === false) compactPrefs.auto = false
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
        proto: [...protoMap.entries()].slice(-1000).map(([k, v]) => [k, v.id, v.fallback === true, v.runningAt ?? 0, v.text && k.includes(":tool:") ? balanceHtmlTags(v.text.slice(0, 1500)) : ""]),
        hashes: [...sentHash].slice(-1500),
        rounds: Object.fromEntries([...lastRound.entries()].slice(-200)),
        // 只落盘真实 update_id（负数是菜单合成事件，见 handleUpdateInner）
        seen: [...seenUpdates].filter((x) => x >= 0).slice(-SEEN_RING_MAX),
        fullkeys: Object.fromEntries(fullKeyStore),
        lastreply: Object.fromEntries(lastReply),
        stripkb: [...strippedKb].slice(-200),
        stripfail: Object.fromEntries([...stripFail.entries()].slice(-200)),
        halted: [...haltedSet],
        filters: { ...filters },
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
        aliases: Object.fromEntries(aliasMap),
        bar: Object.fromEntries(pinnedBar),
        // R1036：与读回成对。少了写回，读回永远拿到空 → 等于没修。
        hcompact: Object.fromEntries(lastHostCompact),
        // 只有唯一写者会走到这里（见 isLiveWriter）；watch 始终落盘，
        // 外部改动由 syncPersistedTarget 采纳后再回写。
        watch: [...watchedSessions],
      })
    atomicWrite(STATE_PATH, body, PRIVATE_FILE_MODE)
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
// （pinject delivered sid=ses_f339… 出现在 [alt] 日志里），也就是用户看到的
// "两个 Bot 都回同一条消息"。真正的加载由 configureBot() 在微任务里做（路径已就位）。
if (!BOOTSTRAP_BOT) loadPersistedState()
const clean = (s: unknown, n: number): string =>
  String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n)
const POLL_MS = Number(process.env.TG_POLL_MS ?? "2000") || 2000
// R1885：`/api/session` 的取回条数。实测服务端默认只给最近 50 个，而项目内实有 125 个 ——
// 不显式要数量，会话选择闸口会把「排在 50 名之外但真实存在」的会话误判为不存在。
// 注意：这**只能**走裸 HTTP；宿主内置 client 不转发 limit 参数（见 refreshSessionTitles 注释）。
// 取一个远大于本地各上限的数：本地最多也就 WATCH_MAX=8 条镜像 + LOOP_SESSIONS_CAP=16，
// 而这份列表的用途是**存在性判据**，宁全勿缺（多取的成本只是几十个标题字符串）。
const SESSION_LIST_LIMIT = 1000
const PUSH_MAX = 3800
const ACTIVE_WINDOW_MS = 10 * 60_000
const STOP_NOTIFY_MS = 60_000

const TZ = process.env.TG_TZ ?? loadFileEnv(CONFIG_PATH).TG_TZ ?? "Asia/Shanghai"
const fmtClock = (ms: unknown): string => {
  try {
    const t = Number(ms)
    if (!Number.isFinite(t) || t <= 0) return ""
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(t))
    const g = (ty: string): string => parts.find((x) => x.type === ty)?.value ?? ""
    return `${g("hour")}:${g("minute")}:${g("second")}`
  } catch {
    return ""
  }
}
const fmtTime = (ms: unknown): string => {
  try {
    const t = Number(ms)
    if (!Number.isFinite(t) || t <= 0) return ""
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(t))
    const g = (ty: string): string => parts.find((x) => x.type === ty)?.value ?? ""
    return `${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`
  } catch {
    return ""
  }
}

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

const htmlEsc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// ---------------------------------------------------------------------------
// R2228 循环注入状态卡（用户需求演进：逐条提醒刷屏 → 单张可编辑状态卡 + 置顶）。
// 纯函数 + 状态文件读写放模块级：文案与落盘可单测，不必起桥。
// 卡片 id 持久化到配置目录（/tmp 在进程重启会被清空，见 R1786 实录），热重载后
// 仍编辑同一条消息，不会每次重启都新建一张卡。
export type InjectCardState = { msgID?: number; count: number; lastAt: number; lastKind: string; lastSid: string; avgGapMs: number }
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
      lastKind: j?.lastKind === "recover" ? "recover" : "round",
      lastSid: typeof j?.lastSid === "string" ? j.lastSid : "",
      avgGapMs: Number(j?.avgGapMs) > 0 ? Number(j.avgGapMs) : 0,
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
      JSON.stringify({ msgID: st.msgID, count: st.count, lastAt: st.lastAt, lastKind: st.lastKind, lastSid: st.lastSid, avgGapMs: st.avgGapMs }),
    )
  } catch {
    /* best-effort：落盘失败只影响重载后的卡 id 复用，下次创建会自愈 */
  }
}
/** 状态卡文案（纯函数，统一 htmlEsc 动态字段；调用方传原始未转义文本）。 */
export const injectCardText = (o: {
  bot: string
  lastAt: number
  kind: string
  sid: string
  count: number
  avgGapMs: number
  gate: { stopped: boolean; by: string; reason: string }
  now: number
}): string => {
  const d = new Date(o.lastAt > 0 ? o.lastAt : o.now)
  const pad = (n: number): string => String(n).padStart(2, "0")
  const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const short = o.sid.replace(/^ses_/, "").slice(0, 10)
  const gap = o.avgGapMs > 0 ? `${Math.floor(o.avgGapMs / 60000)}分${pad(Math.round((o.avgGapMs % 60000) / 1000))}秒` : "—"
  const g = o.gate
  const gateLine = g.stopped
    ? `⏸ 循环已停${g.by ? `（by:${htmlEsc(g.by)}）` : ""}${g.reason ? ` · ${htmlEsc(g.reason).slice(0, 48)}` : ""}`
    : "▶ 循环运行中"
  return [
    `🔁 循环注入状态卡 · ${htmlEsc(o.bot)}`,
    `最后注入: ${stamp} · ${o.kind === "recover" ? "恢复" : "轮次"} · ses_${htmlEsc(short)}`,
    `累计: ${o.count} 次 · 平均间隔 ${gap}`,
    gateLine,
    `更新: 注入即自动编辑本卡（已置顶）`,
  ].join("\n")
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
  for (const tag of tags) {
    // 转义态的标签形如 &lt;b&gt; / &lt;/b&gt; / &lt;pre class="language-x"&gt;
    const re = new RegExp(`&lt;/?${tag}(?:&gt;|\\s[^&]*?&gt;)`, "g")
    const toks: Array<{ start: number; end: number; close: boolean }> = []
    let m: RegExpExecArray | null
    while ((m = re.exec(out)) !== null) toks.push({ start: m.index, end: m.index + m[0].length, close: m[0].startsWith("&lt;/") })
    if (toks.length === 0) continue
    const stack: number[] = []
    const paired: boolean[] = new Array(toks.length).fill(false)
    for (let i = 0; i < toks.length; i++) {
      if (!toks[i].close) stack.push(i)
      else if (stack.length > 0) {
        const open = stack.pop() as number
        paired[open] = true
        paired[i] = true
      }
    }
    if (!paired.some(Boolean)) continue // 全是落单标签 → 一律保持转义
    let res = ""
    let last = 0
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]
      res += out.slice(last, t.start)
      const raw = out.slice(t.start, t.end)
      res += paired[i] ? raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">") : raw
      last = t.end
    }
    out = res + out.slice(last)
  }
  return out
}

export const renderProtoBlock = (title: string, body: string): string => {
  const lines = String(body ?? "").split("\n").map((l) => htmlEsc(l))
  // 标题的 <b> 是我们自己生成的真标签（不需复活）；body 里被转义的真标签按配对情况复活。
  return revivePairedEntities(`<b>${htmlEsc(title)}</b>\n${lines.join("\n")}`, ["b", "pre"])
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
      .map((c) => c.replace(/<\/?b\s*>/g, "").replace(/\*\*/g, "").trim())
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
          // R1838：表格正文是**派生纯文本**（renderTgTable 只画框线+单元格文字），必须 htmlEsc
          // 后才能塞进 <pre>。此前直发：单元格里的 `a < b` 会留下裸 `<`、`x & y` 留下裸 `&`，
          // 在 HTML parse_mode 下要么被 TG 判非法整条降级为纯文本（表格破相），要么把后续
          // 文本当标签吞掉。与 renderProtoBlock（L2035 已 htmlEsc）保持一致。
          out.push(`<pre>${htmlEsc(body)}</pre>`)
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

const INTERNAL_LOG_LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\S*\s+\[(tg-bridge|auto-continue)\]|auto-continue: eval|getUpdates failed|proto (send|edit) (ok|failed|drop)|answerCallback|cb (recv|refresh|full)|^\[(tg-bridge|auto-continue)\]/
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

// 凭据脱敏：Telegram 的调用形如 https://api.telegram.org/bot<TOKEN>/sendMessage，
// 只要任何一条日志带上 URL（fetch 异常、错误对象、调试打印），token 就落盘了。
// R1886：形态扩到 provider 侧 —— 宿主/provider 的原样错误文本经 sanitizeLog(err) 进日志，
// 而 /errors 与 /logs 会把日志回显到会话窗口；误伤控制：sk- 需 >=12 位且 \b 夹住、
// query 密钥参数须带 ?/& 前缀、只抹值保留参数名。当前无线上泄漏证据（命中 0）。
export const redactSecrets = (s: string): string =>
  s
    .replace(/\/bot\d{5,}:[A-Za-z0-9_-]{8,}/g, "/bot<redacted>")
    .replace(/\bbot\d{5,}:[A-Za-z0-9_-]{8,}\b/g, "bot<redacted>")
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "<redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "<redacted>")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/g, "$1 <redacted>")
    .replace(/([?&](?:api_key|apikey|access_token|token|key)=)[^&\s"'<>]{6,}/gi, "$1<redacted>")
// R1873：日志"去控制字符"的**单一来源**（`sanitizeLog` 与 `log()` 出口共用）。目的：
// 任何进日志的文本都必须是单行（`\n`/控制字符 → 空格），否则外部文本可撕裂/伪造日志行。
export const stripLogControls = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, " ")
const sanitizeLog = (s: unknown): string => {
  let out = stripLogControls(String(s))
  // 再兜一层：把本进程真实持有的 token 值直接抹掉（不依赖它长得像不像 token）
  if (TOKEN.length >= 20) out = out.split(TOKEN).join("<TOKEN>")
  return redactSecrets(out).slice(0, 300)
}

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
 * HTML 标签配平（模块级、可测）。
 *
 * 为什么需要：截断可能把 `<pre><code>…` 切断，助手正文里也可能带落单的 `</code>`；
 * 两者都会让 Telegram 400，而旧行为是**退化成纯文本**（格式全丢 + 每次记一条 error）。
 * 这里在发送前做栈式修复：删掉无匹配的闭合标签、补上缺失的闭合标签。
 * 只处理我们自己会生成的标签（b/pre/code/blockquote），其余原样保留。
 */
export const balanceHtmlTags = (input: string): string => {
  let out = String(input ?? "")
  if (!out.includes("<")) return out
  // R1010：`<i>` 必须一起处理。缺口是**真的** —— 看门狗页脚（L750 的"内容取自会话记录"）
  // 与 ctx 后缀的说明文字都用 <i>，而正文一旦在这类行中间被截断，<i> 就是落单的。
  const TAGS = ["b", "i", "pre", "code", "blockquote"]
  const tokenRe = /<(\/?)(b|i|pre|code|blockquote)(?:\s[^>]*)?>/g
  for (const tag of TAGS) {
    let guard = 0
    for (;;) {
      const idx = out.lastIndexOf(`</${tag}>`)
      if (idx < 0 || guard++ > 64) break
      const before = out.slice(0, idx)
      const opens = (before.match(new RegExp(`<${tag}(?:[ >])`, "g")) || []).length
      const closesBefore = (before.match(new RegExp(`</${tag}>`, "g")) || []).length
      if (opens > closesBefore) break // 这一处有对应开标签，不是落单的
      out = out.slice(0, idx) + out.slice(idx + tag.length + 3)
    }
  }
  const stack: string[] = []
  let mm: RegExpExecArray | null
  tokenRe.lastIndex = 0
  while ((mm = tokenRe.exec(out)) !== null) {
    const name = mm[2] as string
    if (mm[1] === "/") {
      const at = stack.lastIndexOf(name)
      if (at >= 0) stack.splice(at, 1)
    } else {
      stack.push(name)
    }
  }
  for (let i = stack.length - 1; i >= 0; i--) out += `</${stack[i]}>`
  return out
}

/**
 * `splitHtmlChunks` 定长切片的安全切点：保证 `[i, cut)` 不落在标签 `<...>` 或实体 `&...;` 中间。
 *
 * 为什么必须有：R1064 的定长切片按 `i += max` 硬切，切点可能落在标签/实体内部：
 *  · 片尾 `<b`（无 `>`）：`validateHtmlText` **不报**（它的标签正则要 `>`），若 Telegram 报 400，
 *    因该片含 `<` 会走"剥标签重发纯文本"降级 → 丢格式（不丢消息）。
 *  · 片尾 `&am`/`&`（无 `;`）：`validateHtmlText` 报"实体不完整"，而若该片**不含 `<`**，
 *    发送层的 400 降级分支（`status===400 && chunks[i].includes("<")`）**不触发** →
 *    `noteDrop` 并**整片丢弃** → 用户看到"消息发送不完整"（正是 R1064 要修的病症）。
 * 与 `truncateAt` 同策略：回退到最近的 `<`/`&` 之前，余下字符留给下一片，不丢内容。
 */
export const safeHtmlCut = (line: string, i: number, max: number): number => {
  let end = Math.min(i + max, line.length)
  if (end >= line.length) return end
  const lt = line.lastIndexOf("<", end - 1)
  const gt = line.lastIndexOf(">", end - 1)
  if (lt > gt) end = lt
  const amp = line.lastIndexOf("&", end - 1)
  const semi = line.lastIndexOf(";", end - 1)
  if (amp > semi) end = amp
  if (end <= i) end = Math.min(i + max, line.length) // 兜底：保证切片循环前进
  return end
}

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

export const validateHtmlText = (text: string): string | null => {
  const t = String(text ?? "")
  // 1) 标签配对（只关心 b/i/s/u/code/pre/a/blockquote）
  const stack: string[] = []
  const re = /<\/?([a-zA-Z]+)(\s[^>]*)?>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) {
    const raw = m[0]
    const name = (m[1] ?? "").toLowerCase()
    if (raw.startsWith("</")) {
      const top = stack.pop()
      if (top !== name) return `标签错位: </${name}> 对应的是 <${top ?? "无"}>`
    } else if (!raw.endsWith("/>")) {
      stack.push(name)
    }
  }
  if (stack.length > 0) return `标签未闭合: <${stack.join(">, <")}>`
  // 2) 实体完整性（截断的 &xxx; 是 400 高发原因）
  const badAmp = /&(?!(amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);)[^\s<]{0,8}/.exec(t)
  if (badAmp) return `实体不完整: ${JSON.stringify(badAmp[0])}`
  return null
}

// R1635：纯函数 —— 从 Telegram 错误响应体解析 retry_after（秒）。非 JSON / 无 parameters 返回 0。
export const parseTgRetryAfter = (text: string): number => {
  try {
    const j = JSON.parse(text) as { parameters?: { retry_after?: number } }
    if (j && typeof j === "object") return Number(j?.parameters?.retry_after) || 0
  } catch { /* 非 JSON 响应 */ }
  return 0
}

// R1635：纯函数 —— 冷却判断。until=冷却截止 ms；now=当前 ms。true=仍在冷却（跳过 rename）。
export const renameCooling = (until: number, now: number): boolean => until > now

// R1834：纯函数 —— 由 setMyName/setMyShortDescription 的失败响应算出"本次冷却秒数"。
//
// 缺口：旧逻辑只在 `retryAfter > 0` 时才 noteRename429()。若 Telegram（或中间的
// 网关/代理）回 429 但响应体**不可解析**（无 parameters.retry_after），就**不装冷却**，
// 而 poll 每 60s 会再调一次 → 持续 hammer，可能把限流拖得更久。429 必须**始终**装冷却。
// 规则：
//   * retryAfter > 0             → 用原值（保留"尊重 TG 给的超长 retry_after"这一既有行为）；
//   * status===429 且 retryAfter≤0 → 用保守兜底（默认 300s）；
//   * 其它状态且无 retry_after    → 0（瞬态错误不额外冷却，允许下轮 poll 重试）。
// 非有限/负数 retryAfter 视为"未给"。
export const rename429Seconds = (status: number, retryAfterSec: number, fallbackS = 300): number => {
  const ra = Number(retryAfterSec)
  if (Number.isFinite(ra) && ra > 0) return Math.max(1, Math.floor(ra))
  return status === 429 ? Math.max(1, Math.floor(fallbackS)) : 0
}

// R1844：纯函数 —— botname-429.json 的写入合并。冷却截止是**单调**时间戳，逐 bot 取 max。
// 账本跨 bot/跨实例（重载）共享且是 read-modify-write：取 max 保证并发写不会把某 bot 的冷却改小，
// 顺带规范化掉非正/非法条目。返回值可直接 atomicWrite 落盘。
export const mergeRename429Until = (
  disk: Record<string, { until?: number } | undefined>,
  bot: string,
  until: number,
): Record<string, { until: number }> => {
  const out: Record<string, { until: number }> = {}
  for (const [k, v] of Object.entries(disk)) {
    const u = Number(v?.until) || 0
    if (u > 0) out[k] = { until: u }
  }
  out[bot] = { until: Math.max(out[bot]?.until ?? 0, Number(until) || 0) }
  return out
}

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

// R1823：群聊命令的 @botname 后缀剥离（纯函数）。Telegram 在群聊会把命令改写成 `/cmd@BotName`；
// 各命令块的参数切片按 "/cmd " 前缀做，带 @ 后缀时前缀失配 → 参数被吞空（/use、/watch、/alias）
// 或错位（/sendto 把 "botname" 当成会话名）。只剥离**紧跟在首个命令 token 后**的 @后缀：
// 对普通文本、已含空格的命令、以及参数里出现的 @ 均零影响（正则要求 @ 紧跟命令 token、中间不能有空格）。
export const stripCmdBotSuffix = (text: string): string =>
  text.replace(/^(\/[A-Za-z0-9_]+)@[A-Za-z0-9_]+/, "$1")

// R1830：取「命令 token 之后的参数」的通用纯函数，取代各块硬编码的 `text.startsWith("/cmd ")` 切片。
// 动机（R1823 同一缺陷类的**残余分支**）：命令名经 CMD_ALIAS 归一（/u→use）、且 stripCmdBotSuffix 已剥 @suffix 后，
// 文本可能仍是 `/u 3`；此时按 `/use ` 切片得到空串 → `/u 3` 静默退化成"看当前目标"，`/r 10` 退化成默认 5。
// 规则：去首部空白 → 必须 `/` 开头 → 跳过第一个非空白 token（命令名）→ 返回其余（保留内部空格）。
// 对普通文本、无参命令、参数内 @ 均零副作用。
export const commandArg = (text: string): string => {
  const t = String(text ?? "").trimStart()
  if (!t.startsWith("/")) return ""
  const m = /^\/[^\s]+/.exec(t)
  return m ? t.slice(m[0].length).trim() : ""
}

// R1846：命令 token 归一（小写）。Telegram **原样投递**用户键入的大小写（只有菜单自动补全才是小写），
// 而命令名恒为小写。旧实现 cmd 不做 toLowerCase：`/Menu`、`/USE`、`/U` 既不命中任何命令块，
// 也不在 KNOWN_CMDS 内 → 被回成「❓ 未知命令 /Menu」（用户明明敲的是正确命令），且永远走不到
// 真实处理。此处在**入口**统一归一，别名表 CMD_ALIAS（键本就小写）随之自然命中。
export const normalizeCmd = (text: string): string => {
  const t = String(text ?? "")
  if (!t.startsWith("/")) return ""
  return t.slice(1).split(/[\s@]/)[0].toLowerCase()
}

// R1636：纯函数 —— 速率限制（429）时"下一次循环该等多久"的**指数退避**。
// 背景：原 floodWaitSeconds 是**平**的 —— 不管连着挨几次 429，只要 Telegram
// 给的 retry_after 一样大，等待就一样长，于是"冷却结束→再打一次→再 429"以
// 固定节奏无限循环，把 bot 永久锁在限流里（Telegram 反而越给越长的 retry_after）。
// 现在：连续第 n 次 429 的等待 = max(指数项 base·2^(n-1), Telegram 的 retry_after)，
// 封顶 cap；**成功一次即清零** attempt。抖动（jitter）让多 Bot / 多会话的重试
// 不在同一个毫秒撞上，避免"齐步走"再次触发限流。
// 不变量：返回值**永远 ≥ min(cap, Telegram 要求的 retry_after)**（抖动因子 ≥1）。
// ⚠️ retry_after > cap（默认 900s）时**不**成立 —— 超大 retry_after 会被 cap 收敛
// （有意为之，见测试"retry_after 巨大时按 cap 收敛"）。准确表述是"最慢每 cap 秒重试一次"，
// 而非"绝不早于 Telegram 允许的时间"。
export const FLOOD_BACKOFF_BASE_S = 60
export const FLOOD_BACKOFF_CAP_S = 900
export const FLOOD_BACKOFF_FLOOR_S = 5
export const FLOOD_BACKOFF_JITTER = 0.25

export type FloodBackoffInput = {
  /** Telegram 给的 retry_after（秒）；0/缺省/非法 = 未给。 */
  retryAfter?: number
  /** 已连续挨到的 429 次数（首次 = 1）。0/缺省按"首次"处理。 */
  attempt?: number
  /** 退避基数（秒），默认 60。 */
  baseSeconds?: number
  /** 封顶（秒），默认 900；小于 base 时按 base 处理。 */
  capSeconds?: number
  /** 抖动比例 0..1，默认 0.25。0 = 无抖动（完全确定）。 */
  jitter?: number
  /** 注入 [0,1) 随机数，供测试确定化；缺省取 0.5。 */
  rand?: number
}

export const floodBackoffSeconds = (input: FloodBackoffInput = {}): number => {
  const posOr = (v: unknown, dflt: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : dflt
  }
  const base = posOr(input.baseSeconds, FLOOD_BACKOFF_BASE_S)
  const cap = Math.max(base, posOr(input.capSeconds, FLOOD_BACKOFF_CAP_S))
  const jitter = Math.min(1, Math.max(0, Number(input.jitter ?? FLOOD_BACKOFF_JITTER)))
  const attempt = Math.max(0, Math.floor(posOr(input.attempt, 0)))

  // 指数项 base·2^(attempt-1)。shift 先夹到 30，避免 attempt 很大时
  // 2^attempt 直接溢出成 Infinity（min 能兜住，但先夹更清楚、也让日志好看）。
  const shift = Math.min(Math.max(attempt, 1) - 1, 30)
  const exponential = attempt <= 0 ? base : Math.min(cap, base * Math.pow(2, shift))

  // Telegram 项：尊重 retry_after，仍夹在 [floor, cap]（与限流等待旧公式一致）。
  const ra = Number(input.retryAfter ?? 0)
  const telegram = Number.isFinite(ra) && ra > 0 ? Math.min(cap, Math.max(FLOOD_BACKOFF_FLOOR_S, Math.ceil(ra))) : 0

  // 取两者较大者：我们自己退避可以比 Telegram 更保守，但**不能更激进**。
  const wait = Math.max(exponential, telegram)
  if (jitter <= 0) return Math.round(wait)
  const r = Number(input.rand)
  const u = Number.isFinite(r) && r >= 0 && r < 1 ? r : 0.5
  // u ≥ 0 ⇒ 因子 ≥ 1 ⇒ 结果 ≥ wait ≥ retry_after（不变量成立）。
  return Math.min(cap, Math.round(wait * (1 + jitter * u)))
}

export const validateInlineKeyboard = (kb: unknown): string | null => {
  if (kb === undefined || kb === null) return null
  if (!Array.isArray(kb)) return "inline_keyboard 不是数组"
  for (let i = 0; i < kb.length; i++) {
    const row = kb[i]
    if (!Array.isArray(row)) return `第 ${i} 行不是数组（每行必须是按钮数组）`
    if (row.length === 0) return `第 ${i} 行是空行`
    for (let j = 0; j < row.length; j++) {
      const b = row[j] as any
      if (!b || typeof b !== "object") return `第 ${i} 行第 ${j} 个按钮不是对象`
      const text = String(b.text ?? "")
      if (!text) return `第 ${i} 行第 ${j} 个按钮缺少 text`
      if (text.length > 64) return `第 ${i} 行第 ${j} 个按钮 text 超 64 字符（${text.length}）`
      const data = b.callback_data
      if (data !== undefined) {
        const bytes = Buffer.byteLength(String(data), "utf8")
        if (bytes > 64) return `第 ${i} 行第 ${j} 个按钮 callback_data 超 64 字节（${bytes}: ${String(data).slice(0, 40)}）`
        if (!String(data)) return `第 ${i} 行第 ${j} 个按钮 callback_data 为空`
      }
      if (b.url === undefined && data === undefined && b.web_app === undefined) {
        return `第 ${i} 行第 ${j} 个按钮既没有 callback_data 也没有 url`
      }
    }
  }
  return null
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
  loopstop: "/loop stop",
  loopstart: "/loop start",
  retry: "/retry",
  pause: "/pause",
  resume: "/resume",
  flush: "/flush",
  drop: "/drop",
  dropq: "/dropq",
  stripall: "/stripall",
  sessions: "/sessions",
  info: "/info",
  queue: "/queue",
  digest: "/digest",
  version: "/version",
  owner: "/owner",
  whoami: "/whoami",
  errors: "/errors",
  logs: "/logs",
  inject_now: "/inject now",
  inject_idle: "/inject idle",
  watch: "/watch",
  unwatch: "/unwatch",
  migrate: "/migrate",
  help: "/help",
  selfmute: "/selfmute",
  healcards: "/healcards",
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
  loud: "/loud",
  quiet: "/quiet",
}

export const buildMenuKeyboard = (
  view: string,
  opts: { paused?: boolean; stopped?: boolean; selfmute?: boolean; guard?: GuardCfg; bgAuto?: boolean; bgShellAuto?: boolean; bgPromoteMs?: number } = {},
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
  // 菜单阈值按钮：轮切到下一档，按钮文案带目标档，回调把目标秒数带给命令。
  const bgThNext = (ms: number): number => {
    const i = BG_TH_STEPS.indexOf(ms)
    return BG_TH_STEPS[(i + 1) % BG_TH_STEPS.length] ?? BG_TH_STEPS[0] ?? 60_000
  }
  // 注意：inline_keyboard 的一"行"必须是**扁平的按钮数组**。
  // 之前写成 [[btn],[btn]]（行里再套数组）→ Telegram 直接 400，菜单发不出去。
  const b = (label: string, data: string): unknown => ({ text: label, callback_data: data })
  if (view === "sess") {
    const sess = [...readSessionListSync()].slice(0, 8)
    const rows: unknown[][] = sess.map((s: any) => [
      { text: clean(s?.title || s?.id?.slice(0, 12) || "?", 22), callback_data: `use:${s.id}` },
    ])
    rows.push([b("📋 完整列表", "ma:sessions")])
    rows.push([b("⬅️ 返回", "m:root")])
    return rows
  }
  if (view === "push") {
    return [
      [b("🔊 全部推送", "ma:loud"), b("🔇 推送设置", "ma:quiet")],
      [b(paused ? "▶️ 恢复推送" : "⏸ 暂停推送", paused ? "ma:resume" : "ma:pause")],
      [b("注入:立即", "ma:inject_now"), b("注入:回合后", "ma:inject_idle")],
      [b("附加镜像列表", "ma:watch"), b("清空镜像", "ma:unwatch")],
      [b("⬅️ 返回", "m:root")],
    ]
  }
  if (view === "loop") {
    // 只放「循环/回合/守卫」——后台相关挪去独立的 bg 页，队列/补发挪去 sys（R1505 归组）。
    // R234 子页整理小步4：由 5 行 3 处孤行收敛为 4 行（守卫详情与循环开关联排，
    // 两个守卫开关成对）；紧急动作（停止回合/重试）仍在首行最易点到。
    return [
      [b("⏹ 停止当前回合", "ma:stop"), b("🔁 重试上一条", "ma:retry")],
      [b(stopped ? "▶️ 继续循环" : "⏹ 停止循环", stopped ? "ma:loopstart" : "ma:loopstop"), b("🛡 守卫详情/最近触发", "ma:guardinfo")],
      [b(gProblem ? "🛑 问题即停：开" : "🛑 问题即停：关", "ma:guardprob"), b(gWeb ? "🌐 搜索即停：开" : "🌐 搜索即停：关", "ma:guardweb")],
      [b("⬅️ 返回", "m:root")],
    ]
  }
  if (view === "bg") {
    // 后台专门页（R1505）：提升 + 自动转后台 + shell 自动后台 + 阈值 + 能力状态。
    // R234 子页整理小步4：原 6 行每行 1 键（全竖排）→ 4 行；「立即转后台」与能力状态
    // 联排（动作+其依据顺手可查），两个自动开关成对；阈值按钮文案较长独占一行。
    const nextSec = Math.round(bgThNext(bgMs) / 1000)
    return [
      [b("🧵 立即转后台", "ma:bg"), b("ℹ️ 后台能力/直连状态", "ma:bgstatus")],
      [b(bgAutoOn ? "⚡ 自动转后台：开" : "⚡ 自动转后台：关", "ma:bgauto"), b(bgShellAuto ? "🖥 shell 自动后台：开" : "🖥 shell 自动后台：关", "ma:bgshell")],
      [b("⏱ 超时阈值：" + Math.round(bgMs / 1000) + "s › " + nextSec + "s", "ma:bgth")],
      [b("⬅️ 返回", "m:root")],
    ]
  }
  // R234 sys 页分组重排（菜单整理小步2）：
  //  · 分区顺序 = 使用频率与风险：只读诊断置顶 → 队列操作 → 修整 → 危险动作（两个 🗑 丢弃
  //    成对集中在一行，便于一眼识别、也避免与查看类动作穿插误点）→ 会话与身份 → 元信息 → 设置。
  //  · 消除孤行按钮：原 12 行里 selfmute/healcards 各自独占一行，现全部成对（仅「返回」独立收尾）。
  //  · 动作表零改动：所有 callback_data 沿用既有键，MENU_ACTION_TEXT 映射原样生效。
  if (view === "sys") {
    return [
      [b("ℹ️ 目标详情", "ma:info"), b("🕒 最近动态", "ma:digest")],
      [b("❌ 错误日志", "ma:errors"), b("📜 运行日志", "ma:logs")],
      [b("📋 查看队列", "ma:queue"), b("🗂 会话列表", "ma:sessions")],
      [b("🚀 立即补发", "ma:flush"), b("📡 队列置顶", "qpin")],
      [b("🧽 清理旧按钮", "ma:stripall"), b("🩹 纠正卡住的工具卡", "ma:healcards")],
      [b("🗑 丢弃外发队列", "ma:drop"), b("🗑 丢弃注入队列", "ma:dropq")],
      [b("🧬 迁移到新会话", "ma:migrate"), b("🪪 我是谁", "ma:whoami")],
      [b("🤖 版本/owner", "ma:owner"), b("🔢 版本号", "ma:version")],
      [b(selfmute ? "🔊 本 Bot 应答：静默中（点此改为应答）" : "🤫 本 Bot 应答：开启（点此改为只答命令）", "ma:selfmute"), b("❓ 帮助", "ma:help")],
      [b("⬅️ 返回", "m:root")],
    ]
  }
  // R231 根菜单整理：5 个入口排成 3×2（末行不再孤悬一个「系统」）；
  // 「后台」与「系统」原先共用 🛠 图标易混 —— 后台改 ⚙（与其页内「线程/阈值」语义一致）；
  // R2231 「模型」入驻根菜单（等价 /model），帮助移入系统页（ma:help 仍在）。
  return [
    [b("🗂 会话", "m:sess"), b("📣 推送", "m:push")],
    [b("🔁 循环", "m:loop"), b("⚙️ 后台", "m:bg")],
    [b("🤖 模型", "ma:model"), b("🛠 系统", "m:sys")],
  ]
  }

export const TgBridgePlugin: Plugin = async ({ client }) => {
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
  const IS_SERVE = process.argv.some((a) => a === "serve")
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
        `本桥**调不动**压缩（compact 接口缺失），但**宿主会自己压**：2026-09-26 15:36 实测 48%→4%。`,
        noCache ? `注意：当前数字缺少缓存计数，是**下界**，实际更高。` : ``,
        ageS > 600 ? `该数字是 ≥${Math.round(ageS / 60)} 分钟前的采样。` : ``,
        ``,
        `到 100% 之前建议二选一：`,
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
      j.bots[BOT_ID] = e
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

  // Menu signature cache: hot reloads should not spend Telegram quota on identical commands.
  const registerMyCommands = async (): Promise<void> => {
    try {
      // 收敛后的命令面板：手机端命令菜单只暴露 6 个入口，其余功能全在 /menu 按钮菜单里。
      // 文本命令全部保留（菜单动作复用同一条处理链），只是不再占菜单位置。
      const commands = [
        { command: "menu", description: "打开控制台（全部功能）" },
        { command: "use", description: "切换会话 /use [序号|名称|前缀|ID]" },
        { command: "loop", description: "自动循环开关 /loop [start|stop|status]" },
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
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = (msgs[i] as any) ?? {}
          const info = m?.info ?? {}
          // 压缩标记（v1 形 data 或 v2 形 type）：遇到最近一次已完成压缩即停，不再往前取
          const mtype = String(m?.type ?? info?.type ?? "")
          const mstatus = String(m?.status ?? info?.status ?? "")
          if (/compaction/i.test(mtype) && (mstatus === "" || /completed/i.test(mstatus))) {
            stoppedAtCompaction = true
            break
          }
          // 判据与 noteUsage 对齐：**只看 input > 0 是错的** —— 宿主经常只报 cache 而把
          // input 报 0（本项目实测多数轮次如此）。旧判据让回读直接"找不到样本"放弃，
          // 于是显示值长期不刷新、每张卡片都挂"（N 分钟前）"。缓存前缀本身就是上下文。
          const tIn = Number(info?.tokens?.input ?? 0)
          const tCache = Number(info?.tokens?.cache?.read ?? 0) + Number(info?.tokens?.cache?.write ?? 0)
          if (info?.role === "assistant" && (tIn > 0 || tCache > 0)) {
            noteUsage(sid, info)
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
              await log("info", `[tg-bridge] ctx backfill ${sanitizeLog(sid).slice(0, 12)}=${fmtK(total)}/${winTxt} (${pctTxt}) in=${fmtK(uu.input)} out=${fmtK(uu.output)} rea=${fmtK(uu.reasoning)} cr=${fmtK(uu.cacheRead)} cw=${fmtK(uu.cacheWrite)} [msg]`)
            }
            return
          }
        }
        // 没有可用的消息口径：只把账本当诊断信息输出，绝不写进 ctxUsage（否则 100% 假象）
        if (ledger && !ctxUsage.has(sid)) {
          const life = ledger.input + ledger.output + ledger.reasoning
          await log(
            "info",
            `[tg-bridge] ctx backfill ${sanitizeLog(sid).slice(0, 12)}: no active-window value (msgs=${msgs.length}, stoppedAtCompaction=${stoppedAtCompaction}; lifetime=${fmtK(life)} [db] ignored for window)`
          )
          return
        }
        await log("info", `[tg-bridge] ctx backfill ${sanitizeLog(sid).slice(0, 12)}: no post-compaction assistant (msgs=${msgs.length}, stoppedAtCompaction=${stoppedAtCompaction})`)
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
    const home = process.env.HOME ?? "/root"
    const reg = JSON.parse(readFileSync(`${home}/.local/state/opencode/service.json`, "utf8")) as {
      url?: string
      password?: string
    }
    const url = String(reg?.url ?? "").replace(/\/+$/, "")
    const pw = String(reg?.password ?? "")
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
      await log(
        n > 0 ? "info" : "error",
        n > 0
          ? `[tg-bridge] ctx model windows: ${n} models (HttpApi /api/model)`
          : "[tg-bridge] ctx model windows: 0 models — 窗口将回落 1M 兜底，ctx 百分比与压缩阈值均不可信",
      )
      return
    }
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
  // 自愈请求挂起位：轮询在飞时不能发 getUpdates（见 sanityCheckOffset 注释）
  let sanityPendingReason: string | null = null
  // 在飞的长轮询句柄：新实例在 setup 里抢占租约后，旧实例必须在几秒内**主动中断**
  // 自己那次 20 秒长轮询，否则新实例第一次 getUpdates 必然 409（换代抖动）。
  let pollAbort: AbortController | null = null
  let pollAbortTakenOver = false
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
  // R1569：turn-end note 轮询的"实例启动时间"基准。热重载后新实例的 turnEndNotified
  // Set 是空的——若没有这个守卫，会把**已通知过**的最近 completed 消息再补发一条重复
  // note（每次热重载每会话可能 1 条）。只认 boot 之后完成的消息即可避免补发。
  const turnNoteBootAt = Date.now()
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
    timer?: ReturnType<typeof setTimeout>
  }>()
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
  const cachedSessionList: Array<{ id: string; title?: string }> = []
  // R1884：上次记进日志的条数（-1 = 还没记过）。仅用于"变化才记"，避免刷屏。
  let lastLoggedSessionCount = -1
  // R1885：裸 HTTP 取**全量**会话列表。凭证与 `/api/model`（R1881）同源。
  // 返回 null 表示"取不到"（service.json 不可读 / 网络失败 / 非数组），调用方据此回落。
  const fetchSessionListHttp = async (): Promise<any[] | null> => {
    try {
      const home = process.env.HOME ?? "/root"
      const reg = JSON.parse(readFileSync(`${home}/.local/state/opencode/service.json`, "utf8")) as {
        url?: string
        password?: string
      }
      const url = String(reg?.url ?? "").replace(/\/+$/, "")
      const pw = String(reg?.password ?? "")
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
          cachedSessionList.push({ id, title: title || undefined })
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
  const RENAME_SIG_PATH = "REDACTED_ROOT/.config/opencode/botname-sig.json"
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
    const RENAME_429_PATH = "REDACTED_ROOT/.config/opencode/botname-429.json"
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
  type SendResult = { r: "sent" | "retry" | "drop"; id?: number; fallback?: boolean; desc?: string; status?: number }
  let floodUntil = 0
  let fallbackUntil = 0
  let lastFloodLogAt = 0
  // 限流说明：硬限流期间**任何**消息都发不出去（限制的是整个 Bot，不只是某个方法），
  // 所以"正在限流"这类通知根本送不到 —— 硬发只会进队列一起等，白占一条。
  // 诚实的做法是限流结束、第一条成功发出之后，补一句"刚才限流了多久"。
  let floodNoticeFor: { chat: string; since: number; queued: number } | null = null
  // 限流期内“本 Bot 不可用”提示的节流（每分钟最多一条）
  let lastUnavailableNoticeAt = 0
  // R1636：连续 429 计数（指数退避的 attempt 来源）。主 Bot / 备用 Bot 各算各的 ——
  // 备用通道健康不代表主通道健康，混算会让主 Bot 恢复后仍被"连坐"继续长退避。
  // 任一次成功即清零该通道的计数（真正恢复，而不是"等够了就再试"）。
  let primary429Streak = 0
  let fallback429Streak = 0
  // 限流等待：**尊重** Telegram 给的 retry_after，下限 5s、上限 15 分钟。
  // 此前是四处各写一遍"封顶 120s / 下限 60s"的公式。retry_after 最大可到 3600 秒，
  // 封顶 120 秒意味着限流期内我们每隔 2 分钟就发一次**注定失败**的请求，Telegram 往往
  // 会把 retry_after 越给越长。等待期由本地闸门挡着（根本不发请求），所以放大上限
  // 不增加请求量，只会少挨几次 429，并让内容在允许的第一时间送达。
  // R1636：现在**指数退避**（不再是平的）：连续第 n 次 429 等 base·2^(n-1)，
  // 与 Telegram 的 retry_after 取大者。attempt 由 tgFetch 的连续计数传入，
  // 一旦成功就清零 —— 详见 floodBackoffSeconds（唯一实现，本处只做转发）。
  const FLOOD_WAIT_CAP_S = FLOOD_BACKOFF_CAP_S
  const floodWaitSeconds = (retryAfter?: number, attempt = 1): number =>
    floodBackoffSeconds({ retryAfter, attempt })
  type TelegramResult = { ok: boolean; id?: number; status?: number; desc?: string; retryAfter?: number; viaFallback?: boolean }
  const callTelegram = async (base: string, method: string, body: Record<string, unknown>): Promise<TelegramResult> => {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      try {
        const j = (await res.json()) as any
        const id = Number(j?.result?.message_id)
        return { ok: true, id: Number.isFinite(id) ? id : undefined }
      } catch {
        return { ok: true }
      }
    }
    let desc = ""
    let retryAfter = 0
    try {
      const j = (await res.json()) as any
      desc = String(j?.description ?? "")
      const ra = Number(j?.parameters?.retry_after)
      if (Number.isFinite(ra) && ra > 0) retryAfter = ra
    } catch {
      desc = ""
    }
    if (!desc) {
      try { desc = (await res.text()).slice(0, 200) } catch { desc = "" }
    }
    if (!retryAfter) {
      const m = /retry after (\d+)/i.exec(desc)
      if (m) retryAfter = Number(m[1])
    }
    return { ok: false, status: res.status, desc: desc.slice(0, 200), retryAfter }
  }
  const fallbackBody = (body: Record<string, unknown>): Record<string, unknown> => {
    // callback 只会回到发送消息的 Bot。备用 Bot 没有主 Bot 的 callback
    // 轮询，因此备用发送一律去掉按钮：正文/命令回执立即可达，但不会出现
    // 看似可用、实际无法处理的死按钮；需要按钮时等待主 Bot 恢复。
    if (body.reply_markup !== undefined) {
      const out = { ...body }
      delete out.reply_markup
      return out
    }
    return body
  }
  const tgFetch = async (
    method: string,
    body: Record<string, unknown>,
    preferFallback = false,
  ): Promise<{ ok: boolean; id?: number; status?: number; desc?: string; viaFallback?: boolean }> => {
    try {
      const canFallback =
        Boolean(fallbackApiBase) &&
        (method === "sendMessage" ||
          method === "pinChatMessage" ||
          method === "unpinChatMessage" ||
          (preferFallback && method === "editMessageText"))
      const fbBody = method === "sendMessage" || method === "editMessageText" ? fallbackBody(body) : body
      const now = Date.now()
      if (preferFallback && fallbackApiBase && method === "editMessageText") {
        if (now < fallbackUntil) return { ok: false, status: 429, desc: "local fallback flood gate active" }
        const direct = await callTelegram(fallbackApiBase, method, fbBody)
        if (direct.ok) {
          fallback429Streak = 0
          return { ...direct, viaFallback: true }
        }
        if (direct.status === 429) {
          const wait = floodWaitSeconds(direct.retryAfter, ++fallback429Streak)
          fallbackUntil = Date.now() + (wait + 1) * 1000
          return { ok: false, status: direct.status, desc: direct.desc, viaFallback: true }
        }
        // 所有权标记不准确时再尝试主 Bot，避免把可编辑消息永久卡住。
      }
      if (now < floodUntil && !canFallback) return { ok: false, status: 429, desc: "local flood gate active" }
      if (canFallback && now < fallbackUntil) return { ok: false, status: 429, desc: "local fallback flood gate active" }

      let primary: TelegramResult
      if (now < floodUntil && canFallback) {
        primary = await callTelegram(fallbackApiBase, method, fbBody)
        if (primary.ok) {
          fallback429Streak = 0
          return { ...primary, viaFallback: true }
        }
        if (primary.status === 429) {
          const wait = floodWaitSeconds(primary.retryAfter, ++fallback429Streak)
          fallbackUntil = Date.now() + (wait + 1) * 1000
        }
        return { ok: false, status: primary.status, desc: primary.desc, viaFallback: true }
      }

      primary = await callTelegram(apiBase, method, body)
      if (primary.ok) {
        primary429Streak = 0
        return primary
      }
      if (primary.status === 429 && canFallback) {
        const secondary = await callTelegram(fallbackApiBase, method, fbBody)
        if (secondary.ok) {
          fallback429Streak = 0
          return { ...secondary, viaFallback: true }
        }
        if (secondary.status === 429) {
          const wait = floodWaitSeconds(secondary.retryAfter, ++fallback429Streak)
          fallbackUntil = Date.now() + (wait + 1) * 1000
        }
      }
      if (primary.status === 429) {
        const waitSeconds = floodWaitSeconds(primary.retryAfter, ++primary429Streak)
        floodUntil = Math.max(floodUntil, Date.now() + (waitSeconds + 1) * 1000)
        // R1895：进闸即写共享标记 —— 自己此刻起发不出任何消息，只有别的 Bot 能替我说。
        // 每次 429 都写（合并语义：until 取 max、since 保留同次起点），不额外去抖：
        // 这是一次文件写 + rename，且只在 429 分支（受本地闸门保护，不会每拍都走）。
        markSelfFlooded(BOT_ID, floodUntil)
        if (Date.now() - lastFloodLogAt > 10_000) {
          lastFloodLogAt = Date.now()
          const rawRa = Number(primary.retryAfter ?? 0)
          const capped =
            Number.isFinite(rawRa) && rawRa > FLOOD_WAIT_CAP_S ? ` (已按 ${FLOOD_WAIT_CAP_S}s 封顶，原始 ${rawRa}s)` : ""
          await log(
            "info",
            `telegram 429 cooldown=${waitSeconds}s rawRetryAfter=${primary.retryAfter || "none"}${capped} fallback=${canFallback ? "yes" : "no"} streak=${primary429Streak}`,
          )
        }
      }
      return { ok: false, status: primary.status, desc: primary.desc }
    } catch (err) {
      // ⚠️ 此前这里 `return { ok: false }` —— **把异常整个丢掉**：调用方拿不到 status、
      // 也拿不到原因，只能记成 `status=?`（实测 12 条一模一样的"神秘失败"）。
      // 现在把原因带回来：status 0 = 网络层未拿到响应（下游已按可重试处理）。
      return { ok: false, status: 0, desc: sanitizeLog(err).slice(0, 160) || "network exception" }
    }
  }
  const truncateAt = (text: string, max: number): [string, boolean] => {
    if (text.length <= max) return [text, false]
    let cut = text.slice(0, max)
    const br = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "), cut.lastIndexOf("。"))
    if (br > max * 0.6) cut = cut.slice(0, br + 1)
    else {
      const sp = cut.lastIndexOf(" ")
      if (sp > max * 0.6) cut = cut.slice(0, sp + 1)
    }
    while (cut.length > 0) {
      const c = cut[cut.length - 1]
      if (c === "<" || c === "&" || (cut.length > 3 && cut.slice(-4) === "</pre")) {
        cut = cut.slice(0, cut.length - 1)
        continue
      }
      const amp = cut.lastIndexOf("&")
      if (amp > cut.length - 10 && cut.slice(amp).includes(";") === false) cut = cut.slice(0, amp)
      break
    }
    let end = cut.lastIndexOf("</pre>")
    if (end >= 0 && end > cut.length - 40) cut = cut.slice(0, end)
    const brk = cut.indexOf("<pre>")
    if (brk >= 0 && brk > cut.length - 20) cut = cut.slice(0, brk)
    // 兜底：上面两条只处理"`<pre>` 离末尾很近"的情况，而实测那张坏卡的
    // `<blockquote><pre><code>` 起点离末尾很远 → 两条都不触发，开标签被留在正文里。
    // 无论上面怎么处理，最后都按**实际未闭合的标签栈**补齐（balanceHtmlTags 是唯一实现）。
    // 用**唯一**的那个配平实现（balanceHtmlTags），不要在这里另写一份：
    // R1010 教训 —— 我曾在这里另写了一个"只补不删"的简化版，于是同一个文件里
    // 出现两份标签知识：简化版不认 <i>、也不删落单闭标签，两份迟早分叉。
    return [balanceHtmlTags(cut), true]
  }
  // R1064：超长文本切分（按行边界，尽量不从中劈开；HTML 标签交给每段 balanceHtmlTags 配平）。
  const splitHtmlChunks = (text: string, max: number): string[] => {
    const chunks: string[] = []
    let cur = ""
    const push = (): void => {
      if (cur.trim()) chunks.push(cur)
      cur = ""
    }
    for (const ln of text.split("\n")) {
      if (ln.length > max) {
        push()
        for (let i = 0; i < ln.length; ) {
          const end = safeHtmlCut(ln, i, max)
          chunks.push(ln.slice(i, end))
          i = end
        }
        continue
      }
      if (cur && cur.length + 1 + ln.length > max) push()
      cur = cur ? `${cur}\n${ln}` : ln
    }
    push()
    return chunks
  }
  // R1898：桥侧最后一次成功投递（R1728 静默 watchdog 基线）在 sendTextRaw /
  // editTextRaw 的每个 `sent` 返回点**源头刷新**。此前只在 protoSend 的 3 个分支刷新，
  // 而循环期卡片以**编辑重渲染**为主（proto edit ok）、另有队列/命令回执/菜单等 7 类
  // 成功送达路径各自不刷新 → 基线长期停滞 → `proto silent 15/30/45min` 误报
  //（2026-10-06 实测，同时段日志里 send/edit 全部 ok）。源头一处修，未来新路径不再漏。
  const sendTextRaw = async (chatID: string, text: string, kb?: unknown, silent?: boolean, replyTo?: number): Promise<SendResult> => {
    // R1064：超长消息分段发送，不再 truncateAt 截断丢弃（用户报"消息发送不完整"）。
    if (text.length > PUSH_MAX) {
      const chunks = splitHtmlChunks(text, PUSH_MAX)
      const kbErr = validateInlineKeyboard(kb ? (kb as unknown) : undefined)
      if (kbErr) await log("error", `sendMessage precheck keyboard invalid: ${kbErr}`)
      let firstId = 0
      for (let i = 0; i < chunks.length; i++) {
        const body: Record<string, unknown> = {
          chat_id: Number(chatID) || chatID,
          text: balanceHtmlTags(chunks[i]),
          parse_mode: "HTML",
        }
        if (i === 0 && kb) body.reply_markup = { inline_keyboard: kb }
        if (silent) body.disable_notification = true
        if (i === 0 && replyTo) body.reply_to_message_id = replyTo
        const hErr = validateHtmlText(String(body.text ?? ""))
        if (hErr) await log("error", `sendMessage chunk precheck html invalid: ${hErr}`)
        const r = await tgFetch("sendMessage", body)
        if (r.ok) {
          // ⚠️ R1806：`r.id` 的类型是 `number | undefined`（`callTelegram` 在 HTTP 2xx 时
          // 有两条产路不给 id：① `result.message_id` 缺失/非数字 ② `res.json()` 抛异常）。
          // 而 `firstId` 由上面的 `= 0` 推断成 `number`，**bun build 不报错**
          // （strictNullChecks 关闭）→ 运行时 `undefined` 会被无声灌进来。
          // 生产实证：R1805 在归档里查到 3 次该形态（`proto send sent` 且消息其实已送达）。
          //
          // 所以**不要**在这里写 `firstId = r.id ?? 0` 之类"修补"：0 与 undefined 语义不同，
          // 而真正的容错在调用点 —— `protoDeliveryVerdict` 把两者都判成
          // `delivered:true, degraded:true`（已送达但无法锚定卡片）。
          // 本行保持原样，是为了让"送达但无 id"这个事实能原样传上去。
          if (i === 0) firstId = r.id as number
          continue
        }
        const status = r.status ?? 0
        if (status === 429 || status >= 500 || status === 0) {
          await log("info", `sendMessage chunk ${i + 1}/${chunks.length} failed (chat=${sanitizeLog(chatID)}): ${status || "network-exception"} (will retry whole)`)
          return { r: "retry", status, desc: status || "network-exception" }
        }
        if (status === 400 && chunks[i].includes("<")) {
          // R1888：**先解码、后剥标签**。text 是已 htmlEsc 的 HTML（随后按 parse_mode=HTML
          // 发出），所以旧顺序 `.replace(/<[^>]*>/g,"")` 打在转义文本上**是空操作** ——
          // 紧接着的解码又把 &lt;b&gt; 还原成真标签，于是「剥标签纯文本降级」反而把标签
          // 当**字面文本**原样送到用户面前（实测 `<b>粗体</b> 正文` 原样送达，用户看到标签）。
          // 调换顺序后剥的才是真标签 → `粗体 正文`；其余用例（`ctx <1%`、`a & b`、
          // 讲解用的字面实体）两种顺序结果完全一致，不受影响。
          const plain = chunks[i].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<[^>]*>/g, "")
          // R1880：与非分段路径（下方那条 400 降级）对齐。旧实现在这里只发 `{chat_id, text}`：
          //   • **丢 reply_markup** —— 按钮消失、用户点不到（本轮 dim 5 的正题）；
          //   • **丢 disable_notification** —— 本该静默的思考/状态卡变响铃；
          //   • **丢 reply_to_message_id**；
          //   • 成功时**零日志** —— 非分段路径会记一条，所以日志里看不出"按钮被剥掉了"；
          //   • r2 若再失败会掉进下面的 drop 日志、报的是**原始 400** 而非 r2 的真实状态，
          //     两次失败被压成一次，定位时看到的是一个不存在的错误码。
          const fb: Record<string, unknown> = { chat_id: Number(chatID) || chatID, text: plain.slice(0, PUSH_MAX) }
          if (i === 0 && kb) fb.reply_markup = { inline_keyboard: kb }
          if (silent) fb.disable_notification = true
          if (i === 0 && replyTo) fb.reply_to_message_id = replyTo
          const r2 = await tgFetch("sendMessage", fb)
          if (r2.ok) {
            // 同 R1806：r2.id 可能是 undefined，容错在调用点（protoDeliveryVerdict 判 degraded）。
            if (i === 0) firstId = r2.id as number
            await log("info", `sendMessage plain-fallback ok (chat=${sanitizeLog(chatID)}) chunk=${i + 1}/${chunks.length}${i === 0 && kb ? " (kb kept)" : ""}`)
            continue
          }
          await log("error", `sendMessage plain-fallback failed (chat=${sanitizeLog(chatID)}) chunk=${i + 1}/${chunks.length}: ${r2.status ?? 0} desc=${sanitizeLog(r2.desc ?? "").slice(0, 160)}`)
        }
        await log("error", `sendMessage chunk ${i + 1}/${chunks.length} dropped (chat=${sanitizeLog(chatID)}): ${status} desc=${sanitizeLog(r.desc ?? "").slice(0, 160)}`)
        noteDrop("send-chunk", `chat=${sanitizeLog(chatID)} status=${status} chunk=${i + 1}/${chunks.length}`)
        return { r: "drop", desc: r.desc ?? "", status }
      }
      inboundCounters.outbound += chunks.length
      await log("info", `sendMessage chunked ok (chat=${sanitizeLog(chatID)}) parts=${chunks.length} len=${text.length}`)
      // R1898：投递基线在**源头**刷新（见 sendTextRaw 头部注释）
      lastProtoSendAt = Date.now()
      return { r: "sent", id: firstId, len: text.length }
    }
    const [cut, truncated] = truncateAt(text, PUSH_MAX)
    const body: Record<string, unknown> = {
      chat_id: Number(chatID) || chatID,
      text: `${cut}${truncated ? htmlEsc(`\n[truncated -${text.length - cut.length} chars]`) : ""}`,
      parse_mode: "HTML",
    }
    if (kb) body.reply_markup = { inline_keyboard: kb }
    if (silent) body.disable_notification = true
    if (replyTo) body.reply_to_message_id = replyTo
    const kbErr = validateInlineKeyboard(body.reply_markup ? (kb as unknown) : undefined)
    if (kbErr) await log("error", `sendMessage precheck keyboard invalid: ${kbErr}`)
    const rawText0 = dropStaleRunning(String(body.text ?? ""))
    if (rawText0 !== String(body.text ?? "")) body.text = rawText0
    const rawText = String(body.text ?? "")
    const balanced = balanceHtmlTags(rawText)
    if (balanced !== rawText) body.text = balanced
    const htmlErr = validateHtmlText(String(body.text ?? ""))
    if (htmlErr) await log("error", `sendMessage precheck html invalid: ${htmlErr}`)
    else if (balanced !== rawText) await log("info", `html balanced before send (len=${rawText.length}→${balanced.length})`)
    const r = await tgFetch("sendMessage", body)
    if (r.ok) {
      inboundCounters.outbound++
      lastProtoSendAt = Date.now() // R1898 源头刷新基线
      return { r: "sent", id: r.id, fallback: r.viaFallback, len: String(body.text ?? "").length }
    }
    const status = r.status ?? 0
    if (status === 429 && r.desc === "local flood gate active") {
      return { r: "retry", status, desc: "local flood gate active" }
    }
    if (status === 429 || status >= 500 || status === 0) {
      await log("info", `sendMessage failed (chat=${sanitizeLog(chatID)}): ${status || "network-exception"} (will retry)`)
      return { r: "retry", status, desc: status || "network-exception" }
    }
    if (status === 400) {
      // HTML 非法（如标签错位）：剥标签纯文本降级重发一次，保证送达；键保留（400 错在正文不在 markup）。
      // R1888：同分段路径 —— **先解码、后剥标签**，否则剥标签打在转义文本上是空操作，
      // 解码又把标签还原成字面文本，降级反而把 `<b>`/`<pre>` 送到用户面前。
      const plain = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<[^>]*>/g, "")
      const fb: Record<string, unknown> = { chat_id: Number(chatID) || chatID, text: plain.slice(0, PUSH_MAX) }
      if (kb) fb.reply_markup = { inline_keyboard: kb }
      const r2 = await tgFetch("sendMessage", fb)
      if (r2.ok) {
        await log("info", `sendMessage plain-fallback ok (chat=${sanitizeLog(chatID)})`)
        lastProtoSendAt = Date.now() // R1898 源头刷新基线
        return { r: "sent", id: r2.id, fallback: r2.viaFallback }
      }
    }
    // 永久失败必须记 API 的真实原因（desc），只记正文等于瞎猜：
    // 400 既可能是 HTML 非法，也可能是 inline_keyboard 不合法（callback_data 超 64 字节等）。
    const kbShape = kb ? JSON.stringify(kb).slice(0, 220) : "(none)"
    await log(
      "error",
      `sendMessage dropped (chat=${sanitizeLog(chatID)}): ${status} (no retry) desc=${sanitizeLog(r.desc ?? "").slice(0, 160)} kb=${kbShape} text=${sanitizeLog(text).slice(0, 100)}`
    )
    noteDrop("send", `chat=${sanitizeLog(chatID)} status=${status} len=${text.length}: ${sanitizeLog(text).slice(0, 120)}`)
    // 把真实原因带给调用方：否则上层只能记"丢了"，事后无法判断是 HTML 非法还是
    // 键盘非法（callback_data 超 64 字节是最常见的一种）。
    return { r: "drop", desc: r.desc ?? "", status }
  }
  const editTextRaw = async (chatID: string, messageID: number, text: string, kb?: unknown, preferFallback = false): Promise<SendResult> => {
    lastEditBody = text
    const [cut, truncated] = truncateAt(text, PUSH_MAX)
    const body: Record<string, unknown> = {
      chat_id: Number(chatID) || chatID,
      message_id: messageID,
      text: `${cut}${truncated ? htmlEsc(`\n[truncated -${text.length - cut.length} chars]`) : ""}`,
      parse_mode: "HTML",
    }
    if (kb !== undefined) body.reply_markup = kb ? { inline_keyboard: kb } : { inline_keyboard: [] }
    // 编辑路径同样要配平：截断会切断 <pre><code>，正文可能带落单 </code>
    {
      const t0 = dropStaleRunning(String(body.text ?? ""))
      if (t0 !== String(body.text ?? "")) body.text = t0
      const t1 = balanceHtmlTags(t0)
      if (t1 !== t0) {
        body.text = t1
        await log("info", `html balanced before edit (msg=${messageID}, len=${t0.length}→${t1.length})`)
      }
    }
    // 与 sendTextRaw 同样的发送前自检：编辑路径的按钮（stop/full/fold）也要保证合法
    const kbErrE = validateInlineKeyboard(body.reply_markup ? (kb as unknown) : undefined)
    if (kbErrE) await log("error", `editMessageText precheck keyboard invalid: ${kbErrE}`)
    const r = await tgFetch("editMessageText", body, preferFallback)
    // R1898：编辑是循环期卡片的**主要**送达方式（整张重渲染）——源头刷新基线，
    // 否则只编辑不发送的窗口里 watchdog 会误报 `proto silent`（2026-10-06 实测）。
    if (r.ok) {
      lastProtoSendAt = Date.now()
      return { r: "sent", id: r.id ?? messageID, fallback: r.viaFallback, len: String(body.text ?? "").length }
    }
    // 内容一字不差时 TG 回 400 message is not modified：屏上本就是对的，按成功处理，不降级重发
    if (r.status === 400 && /not modified/i.test(r.desc ?? "")) {
      await log("info", `editMessageText same (chat=${sanitizeLog(chatID)}, msg=${messageID}): already up to date`)
      lastProtoSendAt = Date.now() // R1898 同文也是"链路活着"的证据
      return { r: "sent", id: messageID }
    }
    const status = r.status ?? 0
    // status 0 = fetch 抛异常（网络不可达/DNS/超时），**必须可重试**。
    // 此前只判 429/5xx，把网络异常当永久失败 → 00:54 那次网络抖动直接把菜单点击
    // 变成"点了没反应"（用户报告 /menu 打不开的一类成因）。
    if (status === 0 || status === 429 || status >= 500) return { r: "retry", status, desc: status || "network-exception" }
    await log("error", `editMessageText failed (chat=${sanitizeLog(chatID)}, msg=${messageID}): ${status} (no retry) desc=${sanitizeLog(r.desc ?? "").slice(0, 160)}`)
    noteDrop("edit", `chat=${sanitizeLog(chatID)} msg=${messageID} status=${status} len=${text.length}`)
    return { r: "drop" }
  }

  const flushQueue = async (): Promise<void> => {
    if (flushing || outQueue.length === 0) return
    flushing = true
    try {
      while (outQueue.length > 0) {
        const head = outQueue[0]!
        // 排队超 15 分钟的瞬时提示（📌💉⏳✅）已过时，直接丢，给真正的内容让路
        if (
          Date.now() - (head.ts ?? 0) > 15 * 60_000 &&
          /^(📌|💉|⏳|✅|◻️)/.test(String(head.text ?? ""))
        ) {
          outQueue.shift()
          await log("info", `dropped stale hint (len=${head.text.length}, left=${outQueue.length})`)
          savePersistedState()
          continue
        }
        const r = await sendTextRaw(head.chat, head.text, head.kb, undefined, head.replyTo)
        if (r.r === "retry") {
          if (!floodNoticeFor) floodNoticeFor = { chat: head.chat, since: Date.now(), queued: outQueue.length }
          break
        }
        // 限流刚结束：把"刚才发生了什么"说清楚，别让聊天里凭空缺一段。
        if (floodNoticeFor) {
          const f = floodNoticeFor
          floodNoticeFor = null
          const secs = Math.max(1, Math.round((Date.now() - f.since) / 1000))
          if (secs >= 20) {
            await log("info", `flood recovered (waited ${secs}s, queued=${f.queued})`)
            await reply(f.chat, `✅ Telegram 限流已恢复（刚才等待约 ${secs} 秒${f.queued ? `，期间积压 ${f.queued} 条已继续补发` : ""}）`)
          }
        }
        outQueue.shift()
        if (r.r === "sent") {
          lastPushAt = new Date().toISOString()
          await log("info", `sent queued to ${sanitizeLog(head.chat)} (len=${head.text.length}, left=${outQueue.length})`)
        } else {
          await log("error", `dropped queued to ${sanitizeLog(head.chat)} (len=${head.text.length}, left=${outQueue.length})`)
        }
        // 该 chat 排空即删占位条
        if (!outQueue.some((q) => q.chat === head.chat)) {
          const ph = listPlaceholder.get(head.chat)
          if (ph) {
            listPlaceholder.delete(head.chat)
            try {
              await tgFetch("deleteMessage", { chat_id: Number(head.chat) || head.chat, message_id: ph })
            } catch {
              /* best-effort */
            }
          }
        }
        savePersistedState()
      }
    } finally {
      flushing = false
    }
  }

  const sendQueued = async (chatID: string, text: string, kb?: unknown, replyTo?: number): Promise<void> => {
    if (!text) return
    // 没有积压且当前没有占位/防洪闸时，先直接发送；只有明确失败才创建队列项。
    // 这样实时 assistant 内容不会短暂进入 outQueue，队列长度也能真实反映待重试消息。
    const canDirect =
      outQueue.length === 0 &&
      !listPlaceholder.has(chatID) &&
      (Date.now() >= floodUntil || Boolean(fallbackApiBase))
    if (canDirect) {
      const direct = await sendTextRaw(chatID, text, kb, undefined, replyTo)
      if (direct.r === "sent") {
        lastPushAt = new Date().toISOString()
        await log("info", `direct outbound sent (chat=${sanitizeLog(chatID)}) len=${text.length}`)
        savePersistedState()
        return
      }
      if (direct.r === "drop") {
        await log("error", `direct outbound dropped (chat=${sanitizeLog(chatID)}): no retry`)
        savePersistedState()
        return
      }
      // retry：继续走下面的持久化队列，绝不把失败误报成已发送。
    }
    const congested = outQueue.length > 0
    const item = { chat: chatID, text, ts: Date.now(), kb, replyTo }
    // 命令回执优先于旧通知，避免用户刚发的 /whoami、/loop status 卡在历史队列尾。
    if (text.trimStart().startsWith("[tg-bridge]")) outQueue.unshift(item)
    else outQueue.push(item)
    if (outQueue.length > 50) {
      outQueue.shift()
      await log("error", "outbound queue full (50): dropped oldest")
      noteDrop("queue-full", "outbound queue full (50): dropped oldest")
    }
    // 拥塞时先立占位条（直发不进队），排空即删；限流期跳过占位（省一次触网）
    if (congested && !listPlaceholder.has(chatID) && Date.now() >= floodUntil) {
      try {
        const pr = await tgFetch("sendMessage", {
          chat_id: Number(chatID) || chatID,
          text: "⏳ 已列队，发送中…",
          ...(replyTo ? { reply_to_message_id: replyTo } : {}),
        })
        if (pr.ok && pr.id) listPlaceholder.set(chatID, pr.id)
      } catch {
        /* best-effort */
      }
    }
    savePersistedState()
    await flushQueue()
  }

  const reply = async (chatID: string, text: string, kb?: unknown): Promise<void> => {
    const quote = currentInbound && currentInbound.chat === chatID ? currentInbound.msgID : undefined
    if (commandReplyMode) {
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

  // 只有最新回复保留按钮：新回复落地即扒掉上一条同会话回复的键
  const trackReplyButtons = async (sess: string, chatID: string, msgID: number, kb: unknown[][] | undefined, key: string): Promise<void> => {
    if (!sess || !kb) return
    const prev = lastReply.get(sess)
    if (prev && prev.id !== msgID) {
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
      if (rows !== null) {
        try {
          const r = await tgFetch("editMessageReplyMarkup", { chat_id: Number(prev.chat) || prev.chat, message_id: prev.id, reply_markup: { inline_keyboard: rows } })
          await log("info", `demote prev buttons (session=${sanitizeLog(sess)} msg=${prev.id} kind=${kind} ${r.ok ? "ok" : "fail"})`)
          if (r.ok && pk) {
            strippedKb.add(pk)
            if (strippedKb.size > 500) {
              const first = strippedKb.values().next()
              if (!first.done) strippedKb.delete(first.value)
            }
          }
        } catch {
        /* best-effort: 旧消息过旧则跳过 */
      }
    }
    }
    lastReply.set(sess, { chat: chatID, id: msgID, key })
    savePersistedState()
  }

  // 关键消息遇到 429/本地 flood gate 时保留并退避重试；思考/工具/状态卡仍按防洪策略舍弃。
  const scheduleProtoRetry = (
    key: string,
    chatID: string,
    text: string,
    kb: unknown[][] | undefined,
    silent: boolean,
    editId = 0,
    fallback = false
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
    const item = { chatID, text, kb, silent, editId, fallback, attempt: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined }
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
      const r = item.editId > 0
        ? await editTextRaw(item.chatID, item.editId, item.text, item.kb, item.fallback)
        : await sendTextRaw(item.chatID, item.text, item.kb, item.silent)
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
        // 故这是潜在面硬化。默认 12 次 ≈ 退避累计 5 分钟，足以扛过瞬时抖动；
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
    item.timer = setTimeout(() => void run(), 5_000)
  }

  // 启动回扫：protoMap 里残留的旧 :message: 键一律扒键（新回复落地后自然只剩最新）。
  // TUI  standby 直接 return，此处只在 serve 执行。
  const backfillStrip = async (): Promise<void> => {
    try {
      if (G[GEN_KEY] !== myGen || !ownsPollLease()) return
      if (loopStopped()) return
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
      for (const [k, v] of [...protoMap.entries()]) {
        if (!k.includes(":message:") && !k.includes(":ask:")) continue
        const sid = k.split(":")[0] ?? ""
        if (!sid) continue
        const cur = bySess.get(sid) ?? 0
        if (v.id > cur) bySess.set(sid, v.id)
      }
      let n = 0
      for (const [k, v] of [...protoMap.entries()]) {
        if (!k.includes(":message:") && !k.includes(":ask:")) continue
        const sid = k.split(":")[0] ?? ""
        if (v.fallback === true) continue
        if ((bySess.get(sid) ?? 0) === v.id) {
          lastReply.set(sid, { chat, id: v.id, key: k })
          continue
        }
        // 已处理过的跳过（否则每次重载都重数 89，还白 hammer TG 招 429）
        if (strippedKb.has(k)) continue
        // 旧键清理是低优先级；限流闸开启时立即让路给实时回复/工具消息。
        if (Date.now() < floodUntil) {
          await log("info", "backfill strip deferred (flood gate active)")
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
                await log("error", `backfill strip deferred (mid=${v.id}, status=429; flood gate, 瞬时失败不计入放弃)`)
                break
              }
              const kind = status === 0 ? `network/no-response${r.desc ? ` (${r.desc})` : ""}` : `status=${status}`
              const why = status === 0 ? "网络层失败可重试" : "服务端瞬时失败可重试"
              await log("error", `backfill strip failed (mid=${v.id}, ${kind}; ${why}，不计入放弃)`)
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
      while (strippedKb.size > 500) {
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
    const stopFront = frontSessionID || persistedFront
    const stopSid = key.split(":")[0] ?? ""
    if (loopStopped() && !key.includes(":ask:") && (!stopFront || stopSid !== stopFront)) return
    // 防洪脱载：限流闸开启时只保 💬 回复与问询卡，思考/工具/状态卡直接舍（不断 append 就是 429 永动机）
    if (Date.now() < floodUntil && (key.includes(":thinking:") || key.includes(":tool:") || key.includes(":status:"))) {
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
    if (edit && prev) {
      const r = await editTextRaw(chatID, prev.id, text, kb, prev.fallback === true)
      if (r.r === "sent") {
        protoMap.set(key, { id: prev.id, text, fallback: r.fallback === true || prev.fallback === true })
        noteHash()
        savePersistedState()
        await log("info", `proto edit ok (${sanitizeLog(key)}) msg=${prev.id} len=${text.length} h=${h ? h.slice(0, 8) : "-"}`)
      } else {
        rollback()
        await log("error", `proto edit failed (${sanitizeLog(key)}) → degrade send`)
        const n = await sendTextRaw(chatID, text, kb, silent)
        // R1877：降级新发也走**同一条送达判定**（`protoDeliveryVerdict`），不再手写 if/else。
        const ndv = protoDeliveryVerdict(n)
        if (ndv.delivered && !ndv.degraded && n.id) {
          protoMap.set(key, { id: n.id, text, fallback: n.fallback === true })
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
          noteHash()
          savePersistedState()
          lastPushAt = new Date().toISOString()
          if (sess) touchActivity(sess)
          lastProtoSendAt = Date.now()
          await log("warn", `proto edit-degrade delivered (${sanitizeLog(key)}) no message_id, 无法锚定卡片: ${ndv.why}`)
        } else if (n.r === "retry") {
          scheduleProtoRetry(key, chatID, text, kb, silent, prev.id, prev.fallback === true)
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
    const r = await sendTextRaw(chatID, text, kb, silent)
    // R1802：送达判定交给纯函数（原型是 `r.r==="sent" && r.id`，会把"已送达但无 id"读成失败）
    const dv = protoDeliveryVerdict(r)
    if (dv.delivered && !dv.degraded && r.id) {
      protoMap.set(key, { id: r.id, text, fallback: r.fallback === true })
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
      await log("info", `proto send ok (${sanitizeLog(key)}) msg=${r.id} len=${text.length} h=${h ? h.slice(0, 8) : "-"}`)
    } else if (dv.delivered) {
      // R1802：**TG 已接受、用户已收到**，只是没回 message_id → 我方无法锚定这张卡（不能
      // protoMap.set、不能挂按钮）。绝不能 rollback（会把已送达当未投递再走重试/降级），
      // 也不能不刷新 lastProtoSendAt（否则 R1728 watchdog 基线被污染成误报）。
      // 注意文案：**不用 error 级**——原实现在这里记 `proto send sent` 且级别为 error，
      // 造成"措辞说成功、级别说失败"，任何按级别或按关键字的判据都会读错一边。
      noteHash()
      savePersistedState()
      lastPushAt = new Date().toISOString()
      if (sess) touchActivity(sess)
      lastProtoSendAt = Date.now()
      await log("warn", `proto send degraded (${sanitizeLog(key)}) no message_id, 无法锚定卡片: ${dv.why}`)
    } else {
      rollback()
      if (r.r === "retry") scheduleProtoRetry(key, chatID, text, kb, silent)
      await log("error", `proto send ${r.r} (${sanitizeLog(key)}) len=${text.length}`)
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
    const degraded = Date.now() < floodUntil || Date.now() < fallbackUntil
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

  const protoPushAssistantMessage = async (sessionID: string, chatID: string, m: any, force = false, mode: 'full' | 'text' = 'full'): Promise<void> => {
    noteOwnSession(sessionID)   // R1054：走到这里 = 本 bot 真的要投递这个会话
    const msgKey = String(m?.id ?? m?.info?.id ?? "m").slice(0, 20)
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
          await protoSend(`${sessionID}:thinking:${msgKey}:${pIdx}`, chatID, protoBlock(ptitle("🧠 思考", p, m, sessionID), body), true, undefined, undefined, undefined, force)
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
          await protoSend(`${sessionID}:message:${msgKey}:${pIdx}`, chatID, protoBlock(ptitle(base, p, m, sessionID), rbody), true, undefined, undefined, undefined, force)
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
        for (const m of rows) if (m?.info?.role === "assistant") lastAssistant = m
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
    // （用户报"又不会自动循环了"；总闸 reason=manual stop ses_f260d5c5 就是这么来的）。
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
    if (loopStopped() && !allowStopped) return `loop stopped（本 Bot=${BOT_ID} 已暂停注入；/loop start 恢复本 Bot，其它 Bot 不受影响）`
    const startedAt = Date.now()
    const wasAlreadyStopped = loopStopped()
    try {
      await client.session.promptAsync({
        path: { id: target },
        body: { parts: [{ type: "text", text: `[TG user message]${ctx ? ` (回复引用：${ctx})` : ""} ${text}` }] },
      })
      const stopDuringPrompt = loopStopped() && (!wasAlreadyStopped || loopStopTimestamp() > startedAt)
      if (stopDuringPrompt) {
        try {
          await (client.session as any).interrupt?.({ path: { id: target } })
        } catch {
          /* best-effort */
        }
        return "loop stopped（注入期间收到停止）"
      }
      busyTurn.add(target)
      if (busyTurn.size > 200) {
        const fk = busyTurn.values().next()
        if (!fk.done) busyTurn.delete(fk.value)
      }
    } catch (err) {
      return `inject failed: ${sanitizeLog(err).slice(0, 200)}`
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
    if (Date.now() < floodUntil) {
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
          if (n === lastQPinCount) return
          const now = Date.now()
          // ⚠️ 与 R988 的限流分支同一类缺陷：5 秒节流早退不置 qpinDirty → 计数更新被丢弃
          // （lastQPinCount 只在成功时写，故下次刷新能自愈；没有下次刷新就一直停在旧数字）。
          if (now - lastQPinEdit < 5000) {
            qpinDirty = true
            return
          }
          const statusLine = await qpinStatusFor((fixedTarget ?? frontSessionID ?? persistedFront) ?? "")
          const r = await editTextRaw(chat, mid, `${statusLine}\n📥 队列中：共 ${n} 条（注入 ${nPin} · 外发 ${nOut}，/queue 查看）`)
          if (r.r === "sent") {
            lastQPinEdit = now
            lastQPinCount = n
          } else {
            await log("error", `queue pin edit failed (mid=${mid}, r=${r.r})`)
          }
          return
        }
        try {
          const statusLine = await qpinStatusFor((fixedTarget ?? frontSessionID ?? persistedFront) ?? "")
          const r = await tgFetch("sendMessage", {
            chat_id: Number(chat) || chat,
            text: `${statusLine}\n📥 队列中：共 ${n} 条（注入 ${nPin} · 外发 ${nOut}，/queue 查看）`,
            disable_notification: true,
          })
          if (r.ok && r.id) {
            queuePin.set(chat, r.id)
            queuePinOn.set(chat, true)
            if (!queuePinHist.includes(r.id)) queuePinHist.push(r.id)
            while (queuePinHist.length > 12) queuePinHist.shift()
            lastQPinCount = n
            lastQPinEdit = Date.now()
            savePersistedState()
            try {
              await tgFetch("pinChatMessage", { chat_id: Number(chat) || chat, message_id: r.id, disable_notification: true })
            } catch {
              /* best-effort */
            }
            await log("info", `queue pin created (n=${n})`)
          } else {
            await log("error", `queue pin create failed (status=${r.status ?? "?"})`)
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
  queuePinRequest = () => {
    void refreshQueuePin()
  }
  // 置顶注入队列泵：同会话串行，逐条提示；失败停泵队首保留（/flush 重试 /dropq 清掉）
  // 空闲判定的静默期：AI 可能**长时间不输出**，或正处于"两轮输出之间"（上一轮已
  // completed、下一轮还没落盘/还没开始流式）。只看"最后一条 assistant 是否 completed"
  // 会把这个空档判成空闲 → 注入落进正在跑的回合。要求"最近 N 毫秒无新事件"作为兜底。
  const IDLE_SETTLE_MS = 10_000
  const turnActuallyIdle = async (sid: string): Promise<boolean> => {
    try {
      const res = await client.session.messages({ path: { id: sid } })
      const rows = Array.isArray(res?.data) ? res.data : []
      const noIdle = (why: string): boolean => {
        void log("info", `idle check: not idle (${why}, sid=${sanitizeLog(sid).slice(0, 12)})`)
        return false
      }
      // ① 静默期：最近有事件就不算空闲（覆盖"两轮输出之间"与"长时间正在思考"）
      const lastEv = lastActivity.get(sid) ?? 0
      if (lastEv > 0 && Date.now() - lastEv < IDLE_SETTLE_MS) return noIdle(`事件 ${Math.round((Date.now() - lastEv) / 1000)}s 前`)
      // ② 找到最后一条 assistant
      let lastAssistantTime = 0
      let lastAssistantCompleted = 0
      for (let i = rows.length - 1; i >= 0; i--) {
        const row: any = rows[i]
        const info = row?.info ?? row
        if (info?.role !== "assistant") continue
        lastAssistantTime = Number(info?.time?.created ?? row?.time?.created ?? 0)
        lastAssistantCompleted = Number(info?.time?.completed ?? row?.time?.completed ?? 0)
        break
      }
      if (lastAssistantCompleted <= 0) {
        // 没有 completed 的 assistant 仍在运行；不把事件丢失误判为空闲。
        return rows.length > 0 && lastAssistantTime === 0 ? !busyTurn.has(sid) : noIdle("最后一条 assistant 未完成")
      }
      // ③ 最后一条消息若是"晚于该 assistant 完成时间的 user 消息" → 回合刚开始，不能插
      const newest: any = rows[rows.length - 1]
      const nInfo = newest?.info ?? newest
      const nCreated = Number(nInfo?.time?.created ?? newest?.time?.created ?? 0)
      if (nCreated > lastAssistantCompleted) return noIdle("最新消息晚于上一轮完成（回合刚开始）")
      // ④ 近期任何工具处于 running/pending → 还在干活
      for (let i = rows.length - 1, seen = 0; i >= 0 && seen < 6; i--, seen++) {
        const row: any = rows[i]
        for (const pp of partsOf(row)) {
          if (String(pp?.type ?? "") !== "tool") continue
          const stt = String((pp as any)?.state?.status ?? "")
          if (stt === "running" || stt === "pending") return noIdle(`工具 ${String(pp?.tool ?? "?").slice(0, 16)} 仍 ${stt}`)
        }
      }
      busyTurn.delete(sid)
      return true
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
        if (haltedSet.delete(sid)) savePersistedState()
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
    const overTh = cu ? ctxTotal(cu) / windowFor(cu.modelID, cu.providerID) >= compactPrefs.threshold : false
    // 注入时机提示必须说真话：busyTurn 会被 turnActuallyIdle 提前清掉，单看它会把
    // “正在跑”说成“空闲”。这里用与泵同源的判定（读最后一条 assistant 是否 completed）。
    let injectNote = ""
    if (injectMode === "idle") {
      const reallyIdle = busyTurn.has(target) ? false : await turnActuallyIdle(target)
      injectNote = reallyIdle ? "（已确认无进行中的回合，将立即注入）" : "（本轮进行中，结束后自动注入）"
    } else {
      injectNote = "（立即插入模式：不等待回合结束）"
    }
    await reply(chatID, `📌 已加入注入队列 → ${target.slice(0, 12)}（第 ${pos} 位，/queue 置顶查看，/dropq 取消）${overTh ? "（⚠️ ctx 已超阈值，建议先 /compact）" : ""}${injectNote}`)
    await log("info", `pinject queued sid=${sanitizeLog(target).slice(0, 12)} pos=${pos} len=${text.length}`)
    void pumpInject(target)
  }


  /** 机器人注册表（与 plugins/tg-bridge-v2.ts 的 REGISTRY_PATH 保持一致）。 */
  const BOT_REGISTRY_PATH = "REDACTED_ROOT/.config/opencode/tg-bots.json"
  const BOT_ENV_DIR = "REDACTED_ROOT/.config/opencode"
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
    const entry = "REDACTED_ROOT/.config/opencode/plugins/tg-bridge-v2.ts"
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
  const handleAddBot = async (args: string[], chatID: string): Promise<void> => {
    const tokenForNewBot = (args[0] ?? "").trim()
    if (!tokenForNewBot) {
      await reply(
        chatID,
        [
          "用法：/addbot <token> [chatId] [标签]",
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
    const targetChat = (args[1] ?? "").trim().replace(/^@/, "") || String(chatID).replace(/^@/, "")
    const label = (args.slice(2).join(" ") || "").trim() || `Bot ${new Date().toISOString().slice(0, 16).replace("T", " ")}`

    // 验真：失败就不碰注册表（不留僵尸条目）
    const v = await verifyBotToken(tokenForNewBot)
    if (!v.ok) {
      await reply(chatID, `❌ token 无效，Telegram 拒绝：${v.desc ?? "未知错误"}\n（注册表未改动）`)
      return
    }

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
    const entry = triggerBridgeReload()
    // ⚠️ 这一段**不含 token**：回执只给 id / @username / 后续步骤。
    await reply(
      chatID,
      [
        `✅ 已登记 ${id}${v.username ? `（@${v.username}）` : ""}`,
        `· 标签：${label}`,
        `· 允许会话：${targetChat}`,
        `· 已触发桥侧重载：${entry.split("/").pop() ?? entry}`,
        "",
        "还差一步（我做不了）：请把这个新机器人拉进目标会话，它才能收到消息。",
        `若 1–2 分钟内没看到它的 plugin loaded (bot=${id}…，说明没起来，把 /info 发我看。`,
      ].join("\n"),
    )
    await log("info", `addbot registered id=${id} username=${v.username ? "@" + v.username : "?"} chat=${sanitizeLog(targetChat).slice(0, 16)} (token 未记录)`)
  }


  /** 循环会话名单（与 auto-continue 的 LOOP_SESSIONS_PATH 一致）。 */
  const LOOP_SESSIONS_FILE = "REDACTED_ROOT/.config/opencode/loop-sessions.json"
  /** 显式关闭的会话（`/loop off`）—— 必须独立于正向名单，见 auto-continue 里的原因。 */
  const LOOP_OFF_FILE = "REDACTED_ROOT/.config/opencode/loop-sessions-off.json"

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
  const handleLoopScope = async (on: boolean, chatID: string): Promise<void> => {
    const target = fixedTarget ?? (await activeFront())
    if (!target || !target.startsWith("ses_")) {
      await reply(chatID, "❌ 当前没有目标会话（先 /use 选一个）")
      return
    }
    const tag = sessionTag(target)
    const list = readIdList(LOOP_SESSIONS_FILE)
    const off = readIdList(LOOP_OFF_FILE)
    if (on) {
      const e1 = writeIdList(LOOP_OFF_FILE, off.filter((x) => x !== target))
      const e2 = writeIdList(LOOP_SESSIONS_FILE, [...list.filter((x) => x !== target), target])
      if (e1 || e2) {
        await reply(chatID, `❌ 写入失败：${e1 || e2}`)
        return
      }
      await reply(
        chatID,
        `✅ 本会话循环已开：${tag}
（只影响这一个会话；全局闸用 /loop stop）`,
      )
      await log("info", `loop scope on sid=${sanitizeLog(target).slice(0, 14)} (per-session)`)
    } else {
      const e1 = writeIdList(LOOP_OFF_FILE, [...off.filter((x) => x !== target), target])
      const e2 = writeIdList(LOOP_SESSIONS_FILE, list.filter((x) => x !== target))
      if (e1 || e2) {
        await reply(chatID, `❌ 写入失败：${e1 || e2}`)
        return
      }
      await reply(
        chatID,
        `⏸ 本会话循环已关：${tag}
（其它会话不受影响；全局闸用 /loop stop）`,
      )
      await log("info", `loop scope off sid=${sanitizeLog(target).slice(0, 14)} (per-session)`)
    }
  }

  const HELP_TEXT = [
    "📚 [tg-bridge] 可用命令",
    "【会话管理】",
    "· /help — 显示本列表",
    "· /loop on — 本会话（当前目标）加入自动循环",
    "· /loop off — 本会话退出自动循环（其它会话不受影响）",
    "· /addbot <token> [chatId] [标签] — 登记一个新机器人（登记后需你手动把它拉进会话）",
    "· /sessions — 列出会话，带 [切换] 按钮（别名 /s；之后直接回序号也可选）",
    "  (⭐前台=GUI当前 · ◎活跃=10分钟内有输出 · 📌钉选)",
    "· /use [序号|名称|前缀|ID] — 钉选会话（如：/use 3；别名 /u；空参看当前）",
    "· /recents — 最近 5 个会话",
    "· /alias [名] [会话] — 别名（/alias 列出；/alias del [名] 删除）",
    "· /clear — 取消钉选，跟随前台",
    "· /info — 当前目标会话详情",
    "· /new [标题] — 新建会话",
    "· /migrate — 压缩无门时的活路：新会话＋最近摘要（一点切换）",
    "· /sendto [会话] [文本] — 临时发到指定会话，不改钉选",
    "【历史与重放】",
    "· /replay [N] — 重发最近 N 条（默认 5，不推进标记；别名 /r）",
    "· /reload [N] — 同上，默认 5 条",
    "· /compaction — 推送最近一次压缩摘要",
    "【推送控制】",
    "· /quiet — 推送过滤+压缩设置菜单（别名 /q；/loud 只恢复推送）",
    "· /loud — 恢复全部推送（别名 /l）",
    "· /watch [会话] — 附加镜像该会话（只发最终回复正文，标题带会话名）",
    "· /unwatch [会话] — 取消附加镜像（不带参数=全部取消）",
    "【应答与独立】",
    "· /selfmute [on|off] — 本 Bot 是否只答命令（默认开启应答；每 Bot 独立，互不影响）",
    "· /menu — 打开按钮控制台（推荐入口，所有功能都能点）",
    "· /healcards — 按真实状态纠正卡在“执行中”的工具卡",
    "【运行控制】",
    "· /stop — 停自动循环＋中断当前回合（/loop start 恢复）",
    "· /undo — 同上（撤回上一回合）",
    "· /retry — 重发上一次注入（回复机器人消息发“重来”同效）",
    "· /loop [start|stop|status] — 自动循环开关（默认一直跑，用户 /loop stop 才停）",
    "· /autoguard [on|off|status|problem on|off|web on|off] — 自动停止守卫（检测到问题/网页搜索请求即停循环；菜单「🔁 循环」里也有开关）",
    "· /background [auto on|off|status] — 转后台（把阻塞中的同步子代理转后台；/background 立刻提升，整体自动配置用 auto）",
    "· /model [模型名|id] — 选择模型（无参=打开选择列表；点按钮或 /model <名称> 切换当前会话模型，下次生成生效）",
    "· /botname [名称] — 查看/设置 Bot 显示名（空参只读；自动改名为当前会话）",
    "· /botdesc [小字] — 查看/设置 Bot 小字简介（空参只读；自动改为会话短号）",
    "· /compact — 手动触发压缩（本宿主构建不可用时改用 /migrate）",
    "· /digest — 推送最近 10 条动态",
    "· /queue — 置顶查看注入队列+未发送队列",
    "· /stripall — 清掉所有旧回复按钮（最新一条保留）",
    "· /pause — 暂停实时推送（命令仍响应）",
    "· /resume — 恢复实时推送",
    "· /flush — 强制发送队列+继续注入",
    "· /drop — 丢弃队列",
    "· /dropq — 丢弃置顶注入队列",
    "· /inject [now|idle] — 注入时机（立即插入/完成插入）",
    "· /raw [文本] — 纯文本注入（不解析命令）",
    "· 直接发文字 — 进入置顶注入队列（串行注入，逐条提示）",
    "· 超长消息自动分段发送（≥3800 字拆多条，不再截断）",
    "· 询问事项手机可直接回复（数字/文字/按钮）",
    "【诊断】",
    "· /tgping（或 /ping tg）— 诊断信息",
    "· /version — 插件版本",
    "· /drops — 最近发送失败记录",
    "· /owner — poll owner 状态",
    "· /offset — 当前 offset",
    "· /logs [N] — tap 日志尾",
    "· /errors [N] — 最近错误",
    "· /whoami — 当前 chat 与目标",
    "━━━━━━━━━━━━━━━",
    "💬 直接发任意文本 → 注入到前台/已钉会话",
    "（长按机器人消息再回复，可带上引用上下文）",
    "（回合无正文结束提示 ◻️ 自然停止）",
  ].join("\n")

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

  const FILT_NAME: Record<string, string> = { reply: "💬 回复", think: "🧠 思考", tool: "🔧 工具", status: "✅ 完成" }
  const FILT_STATE = ["隐去", "仅标题", "全部"] as const
  const filtLine = (): string => {
    const short: Record<"reply" | "think" | "tool" | "status", string> = { reply: "回", think: "思", tool: "具", status: "态" }
    return "flt=" + (Object.keys(short) as Array<"reply" | "think" | "tool" | "status">).map((k) => `${short[k]}${filt(k)}`).join("") + (compactPrefs.auto ? ` 压开${Math.round(compactPrefs.threshold * 100)}` : " 压关") + (injectMode === "idle" ? " 注等" : " 注直")
  }
  const filterMenu = (): { text: string; kb: unknown[][] } => {
    const lines = ["🔇 推送过滤（点按钮切换：隐去→仅标题→全部）", "🗜 压缩设置（自动压缩开关 · 阈值轮切）"]
    const kb: unknown[][] = []
    for (const k of ["reply", "think", "tool", "status"] as const) {
      lines.push(`· ${FILT_NAME[k]}：${FILT_STATE[filt(k)]}`)
      kb.push([{ text: `${FILT_NAME[k]}：${FILT_STATE[filt(k)]} ›`, callback_data: `flt:${k}` }])
    }
    lines.push(`· 🗜 自动压缩：${compactPrefs.auto ? "开" : "关"}`)
    kb.push([{ text: `🗜 自动压缩：${compactPrefs.auto ? "开" : "关"} ›`, callback_data: "flt:compact:auto" }])
    lines.push(`· 🗜 压缩阈值：${Math.round(compactPrefs.threshold * 100)}%`)
    kb.push([{ text: `🗜 压缩阈值：${Math.round(compactPrefs.threshold * 100)}% ›`, callback_data: "flt:compact:th" }])
    lines.push(`· 💉 注入时机：${injectMode === "idle" ? "完成插入" : "立即插入"}`)
    kb.push([{ text: `💉 注入时机：${injectMode === "idle" ? "完成插入" : "立即插入"} ›`, callback_data: "flt:inject:mode" }])
    kb.push([
      { text: "全开", callback_data: "flt:all:2" },
      { text: "全隐", callback_data: "flt:all:0" },
      { text: "完成", callback_data: "flt:done" },
    ])
    return { text: lines.join("\n"), kb }
  }

  // ── 单一按钮菜单 ──────────────────────────────────────────────
  // 目标：命令数量收敛到手机上一屏可点。命令本身全部保留（文本备用），
  // 但日常操作只需要点菜单；菜单消息**就地编辑**，任何时候只有一条。
  const MENU_VIEWS = ["root", "sess", "push", "loop", "bg", "sys"] as const
  const menuText = (view: string): string => {
    const t = fixedTarget ?? frontSessionID ?? persistedFront
    const nm = t ? sessionTag(t) : "(未确定)"
    const head = `<b>🎛 控制台</b> · ${sanitizeLog(BOT_ID)}`
    if (view === "sess") {
      return [
        head,
        `当前目标：<b>${htmlEsc(nm)}</b>${t ? ` (${t.slice(0, 12)})` : ""}`,
        "",
        "点下面切换会话，或直接发 /sessions 看列表。",
      ].join("\n")
    }
    if (view === "push") {
      return [
        head,
        `推送：思考 ${filt("think")} · 工具 ${filt("tool")} · 正文 ${filt("reply")} · 状态 ${filt("status")}`,
        `附加镜像：${watchedSessions.size ? [...watchedSessions].map((s) => sessionTag(s)).join("、") : "(无)"}`,
        `注入时机：${injectMode === "idle" ? "回合结束后" : "立即"}`,
        pausedMode ? "⏸ 实时推送已暂停" : "▶️ 实时推送中",
        "",
        "点下面调整。",
      ].join("\n")
    }
    if (view === "loop") {
      return [
        head,
        loopStopped() ? "⏹ 自动循环：本 Bot 已停止（点“继续循环”恢复；其它 Bot 不受影响）" : "🔁 自动循环：本 Bot 运行中（ESC 或点“停止循环”仅停本 Bot）",
        `注入队列：${pinQueue.length} · 外发队列：${outQueue.length}`,
        "",
        "只放循环/回合/守卫。后台相关在「后台」页。",
      ].join("\n")
    }
    if (view === "bg") {
      const bg = readBg()
      return [
        head,
        `进程内后台 RPC：${bgApiLabel(bgApiShape(client))}`,
        `实验开关 ${BG_ENV_VAR}：${bgEnvOn() ? "开" : "未开"}`,
        `自动转后台：${bg.enabled ? "开" : "关"} · shell 自动后台：${bg.shellPromo !== false ? "开" : "关"}`,
        `插件层超时阈值：${Math.round(bg.promoteMs / 1000)}s（跑超自动转后台） · 冷却 ${Math.round(bg.cooldownMs / 1000)}s`,
        "",
        "点下面调整后台行为；阈值按钮点一下轮换档位。",
      ].join("\n")
    }
    if (view === "sys") {
      return [
        head,
        `版本 ${VERSION}`,
        `bot=${sanitizeLog(BOT_ID)}`,
        `状态文件 ${sanitizeLog(STATE_PATH)}`,
        `本 Bot 应答：${selfMute ? "只答命令" : "开启"}`,
        "",
        "上半页只读诊断；中段队列维护与丢弃（🗑）；底部为设置与帮助。",
      ].join("\n")
    }
    return [
      head,
      `目标会话：<b>${htmlEsc(nm)}</b>`,
      "",
      "按主题分页：会话 / 推送 / 循环 / 后台 / 模型 / 系统。",
    ].join("\n")
  }
  // 薄包装：把运行期状态喂给模块级的真定义（测试直接调 buildMenuKeyboard）
  // 后台提升的最近尝试时间（会话级，用于整体自动配置的冷却）与最近一次"为什么没动"的日志节流。
  const bgLastAttempt = new Map<string, number>()
  let bgLastWhyLogAt = 0
  const menuKeyboard = (view: string): unknown[][] =>
    // 守卫开关每次渲染现读（文件很小、只在开菜单时读），不做缓存：
    // 缓存会让刚点完按钮再开菜单看到旧状态，正是「改了没生效」的观感来源。
    buildMenuKeyboard(view, {
      paused: pausedMode,
      stopped: loopStopped(),
      selfmute: selfMute,
      guard: readGuard(),
      bgAuto: readBg().enabled,
      bgShellAuto: readBg().shellPromo !== false,
      bgPromoteMs: readBg().promoteMs,
    })
  // R1646：每个 chat 当前打开的菜单视图（root/子页）。ma 动作执行后「原地刷新」当前视图，
  // 而不是拽回根页 —— 用户明确要"点按钮不回到主菜单"。sync 时保持与 card 一致。
  const menuViewNow = new Map<string, string>()

  // ── R2231 模型选择：宿主直连 + 选择器缓存 ─────────────────────────────
  // 复用 R1881/R1399 的同源凭证（service.json + Basic encode("opencode:"+pw)）。
  // 所有宿主往返带显式 15s 超时（与文件内其它网络调用一致，避免半边僵死卡住命令应答）。
  const modelHttp = async (path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: any }> => {
    try {
      const home = process.env.HOME ?? "/root"
      const reg = JSON.parse(readFileSync(`${home}/.local/state/opencode/service.json`, "utf8")) as {
        url?: string
        password?: string
      }
      const url = String(reg?.url ?? "").replace(/\/+$/, "")
      const pw = String(reg?.password ?? "")
      if (!url || !pw) return { ok: false, status: 0, body: { error: "service.json 缺 url/password" } }
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
    const m = (b && typeof b === "object" ? (b.model ?? b) : null) as any
    if (m && typeof m.id === "string" && typeof m.providerID === "string") {
      return { id: m.id, providerID: m.providerID, variant: typeof m.variant === "string" ? m.variant : undefined }
    }
    return null
  }
  /** POST /api/session/{sid}/model → 204 表示切换成功。 */
  const modelHttpSet = async (sid: string, ref: { id: string; providerID: string }): Promise<{ ok: boolean; status: number; body: any }> =>
    modelHttp(`/api/session/${encodeURIComponent(sid)}/model`, {
      method: "POST",
      body: JSON.stringify({ model: ref }),
    })
  /** 选择器缩略缓存（每个 chat 一份，90s TTL）：按钮回调按下标解析模型，无需把长 id 塞进 64B 的 callback_data。 */
  const modelMenuCache = new Map<string, { list: ModelEntry[]; ts: number }>()
  const modelMenuText = (curKey: string, list: ModelEntry[]): string => {
    const curName = list.find((m) => m.key === curKey)
    const curLine = curKey ? `当前：<b>${htmlEsc(curName?.display ?? curKey)}</b>` : "当前：未知"
    return ["<b>🤖 选择模型</b>", curLine, `共 ${list.length} 个模型。点名称切换（下次生成生效）；也可发 /model <名称或 id>。`].join("\n")
  }
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
    // ── 单一按钮菜单：所有功能从这里进入（命令保留为文本备用） ──
    if (parts[0] === "m") {
      const view = parts[1] ?? "root"
      const kb = menuKeyboard(view)
      const target = cchat
      const text = menuText(view)
      menuViewNow.set(target, view)
      if (view === "root") {
        // 根菜单就地编辑成子菜单，避免每点一次多出一条消息
        const mid = Number(cq?.message?.message_id ?? 0)
        const r = mid ? await editTextRaw(target, mid, text, kb, false) : { r: "retry" as const, desc: "no message id to edit" }
        if (r.r !== "sent") await sendTextRaw(target, text, kb, false)
        else if (mid) protoMap.set(`menu:${target}`, { id: mid, text, fallback: false })
      } else {
        const mid = Number(cq?.message?.message_id ?? 0)
        const r = mid ? await editTextRaw(target, mid, text, kb, false) : { r: "retry" as const, desc: "no message id to edit" }
        if (r.r !== "sent") await sendTextRaw(target, text, kb, false)
      }
      await answer("菜单")
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
      // 会**自己开子菜单**的动作不能被拽回根页：/quiet（推送过滤设置）会另发一张
      // 带键盘的设置卡，若同时把原菜单卡收回根页，用户看到的就是"点了推送设置反而
      // 回到上层菜单"（实测即如此）。这类动作保持原菜单卡不动，由子菜单自己的
      // 「完成/关闭」按钮收尾。
      const SUBMENU_ACTIONS = new Set(["quiet"])
      if (mid && !SUBMENU_ACTIONS.has(act)) {
        // R1646：执行完**原地刷新当前视图**（用户所在子页），不再拽回根页。
        // 保持"只有一条菜单消息"不变（仍是 edit 而非 send），并让按钮顺带刷新运行期状态
        // （暂停/停止/守卫/后台开光等）。从未记录过视图时缺省 root，行为与旧版一致。
        const curView = menuViewNow.get(cchat) ?? "root"
        const kb = menuKeyboard(curView)
        const body = menuText(curView)
        const r = await editTextRaw(cchat, mid, body, kb, false)
        if (r.r === "sent") protoMap.set(`menu:${cchat}`, { id: mid, text: body, fallback: false })
      } else if (mid) {
        await log("info", `menu action opened submenu, card kept (act=${act})`)
      }
      await answer("已执行")
      return
    }
    if (parts[0] === "mdl") {
      // R2231 模型选择器按钮：set:<idx> 按下标切模型；refresh 重拉；pg:<n> 翻页；
      // nop=页码占位；close=收掉选择器消息。（选择器由 /model 命令或根菜单 🤖 模型 打开。）
      const sub = parts[1] ?? ""
      const mid = Number(cq?.message?.message_id ?? 0)
      if (sub === "close") {
        await answer("已关闭")
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
        if (mid) await editTextRaw(cchat, mid, "❌ 拉取模型列表失败（宿主 HttpApi GET /api/model 不可用）", [], false)
        return
      }
      const target = fixedTarget ?? (await activeFront())
      if (!target) {
        await answer("无法解析目标会话")
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
          if (mid) await editTextRaw(cchat, mid, `❌ 切换失败（HTTP ${res.status}）：${clean(why, 120)}`, [], false)
          return
        }
        await answer(`已切换 ${hit.display}`)
        const ses2 = await modelHttpSession(target)
        const cur2 = ses2 ? `${ses2.providerID}/${ses2.id}` : curKey
        modelMenuCache.set(cchat, { list, ts: Date.now() })
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
        if (mid) await editTextRaw(cchat, mid, modelMenuText(curKey, list), buildModelKeyboard(list, page, curKey), false)
        return
      }
      if (sub === "refresh") {
        await answer("已刷新")
        const fresh = await modelHttpList()
        const list2 = fresh.length > 0 ? fresh : list
        const ses2 = await modelHttpSession(target)
        const cur2 = ses2 ? `${ses2.providerID}/${ses2.id}` : curKey
        modelMenuCache.set(cchat, { list: list2, ts: Date.now() })
        if (mid) await editTextRaw(cchat, mid, modelMenuText(cur2, list2), buildModelKeyboard(list2, 0, cur2), false)
        return
      }
      await answer("未知按钮")
      return
    }
    if (parts[0] === "flt") {
      const sub = parts[1] ?? ""
      if (sub === "done") {
        await answer("已关闭")
        const doneMid = Number(cq?.message?.message_id ?? 0)
        if (doneMid) {
          try {
            const r = await tgFetch("deleteMessage", { chat_id: Number(cchat) || cchat, message_id: doneMid })
            if (!r.ok) await editTextRaw(cchat, doneMid, filterMenu().text, [])
          } catch {
            try {
              await editTextRaw(cchat, doneMid, filterMenu().text, [])
            } catch {
              /* best-effort */
            }
          }
        }
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
      } else if (sub === "reply" || sub === "think" || sub === "tool" || sub === "status") {
        setFilt(sub, (filt(sub) + 1) % 3)
      } else {
        await answer("未知按钮")
        return
      }
      const m = filterMenu()
      await answer(sub === "compact" ? "🗜已更新" : sub === "inject" ? "💉已更新" : `${FILT_NAME[sub === "all" ? "reply" : sub] ?? ""}已更新`)
      const mid = Number(cq?.message?.message_id ?? 0)
      if (mid) {
        await editTextRaw(cchat, mid, m.text, m.kb)
      } else {
        await reply(cchat, m.text, m.kb)
      }
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
    if (floodUntil > Date.now()) {
      const secs = Math.max(1, Math.ceil((floodUntil - Date.now()) / 1000))
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
      await reply(chatID, "[tg-bridge] target unpinned (follow foreground)")
      return
    }
    if (text === "/watch" || text.startsWith("/watch ") || cmd === "watch") {
      const want = commandArg(text)
      if (!want) {
        const list = [...watchedSessions]
        const head = `[tg-bridge] 附加镜像 ${list.length}/${WATCH_MAX}（只发最终回复正文，标题带会话名）`
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
      await reply(chatID, `📎 已附加镜像：${sessionTag(id)} (${id.slice(0, 12)})\n只发最终回复正文（不带思考/状态/工具流），降低 429 风险`)
      return
    }
    if (text === "/unwatch" || text.startsWith("/unwatch ") || cmd === "unwatch") {
      const want = commandArg(text)
      if (!want) {
        if (watchedSessions.size === 0) {
          await reply(chatID, "[tg-bridge] 附加镜像为空")
          return
        }
        const n = watchedSessions.size
        watchedSessions.clear()
        savePersistedState()
        await reply(chatID, `[tg-bridge] 已清空附加镜像（${n} 个会话）`)
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
        `[tg-bridge] pong ver=${VERSION}`,
        `push=${pushChatResolve()} active=${(activeSessionID ?? "").slice(0, 12) || "(none)"} front=${((fixedTarget ?? (await activeFront())) || "").slice(0, 12) || "(none)"}${fixedTarget ? " (钉选)" : ""}`,
        `events=${eventCount} lastPush=${lastPushAt || "(never)"} queue=${outQueue.length}`,
        `proto=${protoMap.size} blocks (可编辑: thinking/message/tool/status)`,
      ].join("\n")
      await reply(chatID, diag)
      return
    }
    if (text === "/menu" || cmd === "menu" || text === "/菜单" || text === "菜单") {
      const c = pushChatResolve() || chatID
      const body = menuText("root")
      const r = await sendTextRaw(c, body, menuKeyboard("root"), false)
      // R1802：判据与主投递路径同源。缺 message_id 时菜单**已送达**（用户看得见），
      // 只是无法锚定这张卡 → 后续切页会改为新发一张。仅记 warn，不 rollback。
      const mdv = protoDeliveryVerdict(r)
      if (mdv.delivered && r.id) protoMap.set(`menu:${c}`, { id: r.id, text: body, fallback: false })
      else if (mdv.delivered)
        await log("warn", `menu degraded (chat=${sanitizeLog(c)}) no message_id，菜单已送达但无法锚定`)
      menuViewNow.set(c, "root")
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
    const listSessions = async (limit: number): Promise<{ text: string; kb?: unknown }> => {
      await refreshSessionTitles()
      activeFrontOverride = ""
      const shown = cachedSessionList.slice(0, Math.max(1, limit))
      const lines: string[] = ["📚 可查看会话（/use [序号|名称|前缀|ID] 钉选，或直接回序号）"]
      if (shown.length === 0) {
        lines.push("（暂无已出现 idle 的会话，等一个前台事件后重试）")
        return { text: lines.join("\n") }
      }
      lines.push(`── 共 ${cachedSessionList.length} 个${shown.length < cachedSessionList.length ? `（列前 ${shown.length}）` : ""} ──`)
      const shownFront = fixedTarget ?? (await activeFront())
      const kb: unknown[][] = []
      selectGen++
      const myGen = selectGen
      const flatBtns: unknown[][] = []
      shown.forEach((s, i) => {
        const isActive = Date.now() - (lastActivity.get(s.id) ?? 0) < ACTIVE_WINDOW_MS
        const mark = s.id === shownFront ? " ⭐前台" : isActive ? " ◎活跃" : ""
        const pin = s.id === fixedTarget ? " 📌钉选" : ""
        const nm = clean(String(s.title ?? ""), 40) || "(无标题)"
        lines.push(`${i + 1}. ${nm} (${s.id.slice(0, 12)})${mark}${pin}`)
        if (flatBtns.length < 20) flatBtns.push([{ text: `切换 ${i + 1}`, callback_data: `use:${s.id}` }])
      })
      for (let r = 0; r < flatBtns.length; r += 5) kb.push(flatBtns.slice(r, r + 5).flat())
      pendingSelect.set(chatID, { gen: myGen, ids: shown.map((s) => s.id), ts: Date.now() })
      return { text: lines.join("\n"), kb: kb.length > 0 ? kb : undefined }
    }
    if (text === "/sessions" || cmd === "sessions") {
      const r = await listSessions(50)
      await reply(chatID, r.text, r.kb)
      return
    }
    if (text === "/recents" || cmd === "recents") {
      const r = await listSessions(5)
      await reply(chatID, r.text, r.kb)
      return
    }
    if (text === "/alias" || text.startsWith("/alias ") || cmd === "alias") {
      const rest = commandArg(text)
      if (!rest) {
        const lines = ["🏷 会话别名（/alias [名] [会话] 设置；/use [名] 使用）"]
        if (aliasMap.size === 0) lines.push("（暂无）")
        else for (const [k, v] of aliasMap) lines.push(`· ${k} → ${v.slice(0, 12)}`)
        await reply(chatID, lines.join("\n"))
        return
      }
      const sp = rest.search(/\s/)
      if (sp < 0) {
        const hit = aliasMap.get(rest.toLowerCase())
        await reply(chatID, hit ? `🏷 ${rest} → ${hit.slice(0, 12)}` : `🏷 无别名 ${rest}`)
        return
      }
      const name = rest.slice(0, sp).toLowerCase()
      const arg = rest.slice(sp + 1).trim()
      if (name === "del" || name === "rm") {
        aliasMap.delete(arg.toLowerCase())
        savePersistedState()
        await reply(chatID, `🏷 已删别名 ${arg}`)
        return
      }
      const id = await resolveSessionID(arg)
      if (!id.startsWith("ses_")) {
        await reply(chatID, `❌ 未找到匹配的会话：${clean(arg, 40)}（用 /sessions 查看列表）`)
        return
      }
      // R1872：与 /use（R1829）同一存在性不变量 —— 别名指向已删除/不存在的完整 ID 会成为
      // "毒别名"：/use 名字会报错（好），但 /watch 名字会经 aliasHit 直接拿到该死 id。
      const listOk = await refreshSessionTitles()
      if (!sessionIdAcceptable(id, cachedSessionList.map((s) => s.id), listOk)) {
        await reply(chatID, `❌ 会话不存在：${clean(arg, 40)}（可能已删除；用 /sessions 查看列表）`)
        return
      }
      aliasMap.set(name, id)
      if (aliasMap.size > 50) {
        const k = aliasMap.keys().next().value
        if (k !== undefined) aliasMap.delete(k)
      }
      savePersistedState()
      await reply(chatID, `🏷 ${name} → ${id.slice(0, 12)}`)
      return
    }
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
        await reply(chatID, "[tg-bridge] no session to stop")
        return
      }
      await reply(chatID, await doStop(target))
      return
    }
    if (text === "/loop on" || cmd === "loopon" || (cmd === "loop" && commandArg(text).toLowerCase() === "on")) {
      await handleLoopScope(true, chatID)
      return
    }
    if (text === "/loop off" || cmd === "loopoff" || (cmd === "loop" && commandArg(text).toLowerCase() === "off")) {
      await handleLoopScope(false, chatID)
      return
    }
    if (text === "/loop" || text.startsWith("/loop ") || cmd === "loop") {
      const arg = commandArg(text).toLowerCase()
      const ctlPath = "REDACTED_ROOT/.config/opencode/loop-ctl.json"
      const ctlLegacy = "/tmp/opencode/loop-ctl.json"
      const readCtl = (): any => {
        for (const p of [ctlPath, ctlLegacy]) {
          try {
            const j = JSON.parse(readFileSync(p, "utf8")) as any
            if (j && typeof j === "object") return j
          } catch {
            /* try next */
          }
        }
        return {}
      }
      const scopeAll = arg === "stop all"
      if (arg === "stop" || scopeAll) {
        // R1061：/loop stop 必须**总是**写共享总闸。旧实现 target 存在时只 doStop
        // （doStop 刻意不写总闸，避免卡上 ⏹ 误停两会话），总闸停在 stopped=false，
        // auto-continue 每分钟继续评估 → "命令暂停后循环仍然跑"。
        persistLoopStop(scopeAll ? "user /loop stop all" : "user /loop stop", scopeAll)
        const target = fixedTarget ?? (await activeFront())
        if (target) await doStop(target)
        await reply(
          chatID,
          scopeAll
            ? "[tg-bridge] loop stopped（**全部 Bot** 已停：全局闸写入，仅 /loop start all 恢复）"
            : `[tg-bridge] loop stopped（本 Bot=${BOT_ID} 已停循环；其它 Bot 不受影响。/loop start 恢复本 Bot，/loop stop all 可停全部）`
        )
        return
      }
      if (arg === "start" || arg === "start all") {
        const all = arg === "start all"
        if (all) {
          writeLoopCtl((j) => {
            j.stopped = false
            for (const k of Object.keys(j.bots ?? {})) (j.bots[k] as any).stopped = false
          })
        } else {
          clearLoopStop()
        }
        const target = fixedTarget ?? (await activeFront())
        if (target && haltedSet.delete(target)) savePersistedState()
        await reply(
          chatID,
          all
            ? "[tg-bridge] loop armed（全部 Bot 已恢复循环）"
            : `[tg-bridge] loop armed（本 Bot=${BOT_ID} 已恢复循环；其它 Bot 保持各自状态。/loop start all 可恢复全部）`
        )
        // 显式 start 后才恢复停止期间挂起的注入队列。
        for (const sid of new Set(pinQueue.map((qq) => qq.sid))) void pumpInject(sid)
        void refreshQueuePin()
        return
      }
      const ctl = readCtl()
      const stopped = ctl?.stopped === true
      const by = stopped && ctl?.by ? ` by=${ctl.by}` : ""
      // R1724：逐 Bot 闸状态（用户要求「不同机器人的循环设置要求单独」）。
      const botGates: string[] = (() => {
        try {
          const bots = (ctl?.bots ?? {}) as Record<string, { stopped?: unknown; sids?: unknown }>
          const names = Object.keys(bots).sort()
          if (names.length === 0) return []
          return names.map((k) => {
            const e = bots[k] ?? {}
            const st = e.stopped === true ? "停" : "运行"
            const sid0 = Array.isArray(e.sids) && typeof e.sids[0] === "string" ? (e.sids[0] as string).slice(0, 12) : "-"
            return `${k}=${st}${sid0}`
          })
        } catch {
          return []
        }
      })()
      // 逐会话如实播报：只说全局"running"会掩盖"某个会话其实没在循环"——
      // 这正是用户报告"另一个会话总是不循环"却从状态里看不出来的原因。
      const lines: string[] = [
        `[tg-bridge] loop status: ${stopped ? `stopped${by}（全局闸，/loop start all 恢复）` : "running（用户主动停止前一直循环）"}`,
      ]
      if (botGates.length > 0) lines.push(`· 逐 Bot 闸：${botGates.join("  ")}`)
      try {
        // 循环资格（粘性标志，与 auto-continue 同一份文件）
        const sticky = new Set<string>()
        try {
          const arr = JSON.parse(readFileSync("REDACTED_ROOT/.config/opencode/loop-sessions.json", "utf8"))
          if (Array.isArray(arr)) for (const x of arr) if (typeof x === "string") sticky.add(x)
        } catch {
          /* 无粘性文件 = 尚未识别 */
        }
        const seen = new Set<string>()
        for (const f of globSync("REDACTED_ROOT/.config/opencode/tg-chats*.json")) {
          try {
            const j = JSON.parse(readFileSync(f, "utf8")) as any
            const sid = typeof j?.front === "string" ? j.front : typeof j?.pinned === "string" ? j.pinned : ""
            if (!sid.startsWith("ses_") || seen.has(sid)) continue
            seen.add(sid)
            const tag = sessionTag(sid)
            const rnd = lastRound.get(sid)
            const act = lastActivity.get(sid)
            const mins = act ? Math.max(0, Math.round((Date.now() - act) / 60000)) : -1
            const mine = sid === (fixedTarget ?? frontSessionID ?? persistedFront) ? "（本 Bot）" : ""
            lines.push(
              `· ${tag} ${sid.slice(0, 12)}${mine} 循环=${sticky.has(sid) ? "是" : "未登记"}` +
                ` 最近轮次=${rnd ?? "?"} 活动=${mins >= 0 ? `${mins} 分钟前` : "未知"}`,
            )
          } catch {
            /* 单个状态文件读失败不影响其它 */
          }
        }
        if (lines.length === 1) lines.push("· （未读到任何目标会话）")
      } catch (err) {
        lines.push(`· 逐会话状态读取失败：${sanitizeLog(err).slice(0, 80)}`)
      }
      await reply(chatID, lines.join("\n"))
      return
    }
    if (text === "/background" || text.startsWith("/background ") || cmd === "background") {
      // 转后台（用户 2026-09-28 新增；菜单「🔁 循环」里也有按钮）。
      // 能力按**运行时探测**（不按版本号猜）：v2.0.10 OpenAPI=顶层 session.background，
      // v1.18.32=experimental.session.background（双路兼容）；session.subagent（创建）不在 API 面。
      const curBg = readBg()
      const shape = bgApiShape(client)
      const envOn = bgEnvOn()
      const capLabel = bgApiLabel(shape) === "无（不支持）" ? "无（不支持）·HTTP直连可用" : bgApiLabel(shape)
      // HTTP 直连可用性=宿主机服务注册可读（url+password 都在才算）。
      const bgHttpReady = ((): boolean => {
        try {
          const reg = JSON.parse(readFileSync(`${process.env.HOME ?? "/root"}/.local/state/opencode/service.json`, "utf8")) as {
            url?: string
            password?: string
          }
          return Boolean(reg?.url && reg?.password)
        } catch {
          return false
        }
      })()
      // R1505：状态用等宽表格回显（代码块恒定等宽 + box-drawing 边框对齐全靠等宽）。
      // R1509/R1510：配置清单按用户设计反馈用「键值列表」——标题+━分隔线、无竖线边框；
      // R1510 起用 tab 对齐（tabAlign:true，键补到 8 的倍数-1 + 单个 \t，值落 8 的倍数列）。
      const rpcSupport = (() => {
        const s: any = shape
        return Boolean(s?.promote || s?.subagent)
      })()
      const bgTable = (): string =>
        renderKvList(
          [
            ["进程内后台 RPC", rpcSupport ? "✅ 支持" : "❌ 不支持"],
            ["HTTP 直连兜底", bgHttpReady ? "✅ 可用（RPC 缺失时自动降级）" : "❌ 服务注册不可读"],
            ["实验开关", envOn ? "✅ 开" : "⭕ 未开"],
            ["自动转后台", curBg.enabled ? "✅ 开" : "❌ 关"],
            ["冷却时间", `${Math.round(curBg.cooldownMs / 1000)}s`],
            ["Shell 自动后台", curBg.shellPromo !== false ? "✅ 开" : "❌ 关"],
            ["Shell 提升熔断", curBg.shellPromo !== false ? "✅ 开（强制）" : "❌ 关"],
            ["插件层超时阈值", `${Math.round(curBg.promoteMs / 1000)}s`],
          ],
          { title: "⚙️ 后台策略", tabAlign: true },
        ) +
        `\n· ${BG_ENV_VAR}=${envOn ? "开" : "未开"}（列表里列窄，完整变量名放这里）`
      const bgStatus = (extra = ""): string =>
        `[tg-bridge] 后台能力：${capLabel}｜实验开关 ${BG_ENV_VAR}=${envOn ? "开" : "未开"}｜自动转后台=${curBg.enabled ? "开" : "关"}（冷却 ${Math.round(curBg.cooldownMs / 1000)}s）｜shell 自动后台=${curBg.shellPromo !== false ? "开" : "关"}｜超时阈值=${Math.round(curBg.promoteMs / 1000)}s${extra}\n` +
        "· 提升：把**正在阻塞**的同步子代理转后台（无端点时走宿主 HTTP 直连）\n" +
        "· 开关：/background auto on|off（整体配置）｜/background shell on|off（shell 自动后台）｜/background th <秒>（超时阈值）｜状态：/background status"
      const bgPromote = async (sid: string, why: string): Promise<string> => {
        const sessAny = (client as any)?.session
        const expSess = (client as any)?.experimental?.session
        const fn = sessAny?.background ?? expSess?.background
        if (typeof fn !== "function") {
          const viaHttp = await bgHttpPromote(sid)
          return viaHttp.ok ? viaHttp.text : `${viaHttp.text}（client 亦无该方法）`
        }
        try {
          const r = await fn.call(sessAny?.background ? sessAny : expSess, { sessionID: sid })
          const errTxt = String((r as any)?.data?.message ?? (r as any)?.data?.error ?? "").slice(0, 120)
          if (errTxt) return `✗ 提升被拒：${errTxt}`
          return `✓ 已请求转后台（${why}）会话 ${sid.slice(0, 12)}${envOn ? "" : `；⚠ 实验开关未开（${BG_ENV_VAR}），失败多半与此有关`}`
        } catch (err) {
          return `✗ 提升失败：${sanitizeLog(String(err)).slice(0, 120)}`
        }
      }
      const bgArg = commandArg(text)
      // R1822：shell 开关的 toggle 基准改用**真正生效**的 shellPromo（菜单「🖥 shell 自动后台」据此显示）。
      // 此前 toggle 基准是未被任何机制消费的 shellAuto → 按钮显示的"开/关"与实际强制提升状态不一致，
      // 用户反馈「菜单里的转后台按钮不能实际控制是否自动转后台」。
      const bgAct = parseBgArg(bgArg, { ...curBg, shellAuto: curBg.shellPromo !== false })
      if (bgAct.kind === "help") {
        await reply(chatID, `[tg-bridge] 用法：/background（立刻转后台）| /background auto on|off|toggle | /background shell on|off|toggle | /background th <秒> | /background status\n${bgStatus()}`)
        return
      }
      if (bgAct.kind === "status") {
        await reply(chatID, bgTable())
        return
      }
      if (bgAct.kind === "set") {
        writeBg({ ...curBg, enabled: bgAct.enabled })
        await reply(chatID, `[tg-bridge] 自动转后台 → ${bgAct.enabled ? "开" : "关"}\n${bgStatus()}`)
        return
      }
      if (bgAct.kind === "setshell") {
        writeBg({ ...curBg, shellAuto: bgAct.enabled, shellPromo: bgAct.enabled })
        await reply(chatID, `[tg-bridge] shell 自动后台 → ${bgAct.enabled ? "开" : "关"}\n${bgStatus()}`)
        return
      }
      if (bgAct.kind === "setth") {
        writeBg({ ...curBg, promoteMs: bgAct.ms })
        await reply(chatID, `[tg-bridge] 插件层超时阈值 → ${Math.round(bgAct.ms / 1000)}s（shell 跑超自动转后台；可再 /background th <秒> 调整）\n${bgTable()}`)
        return
      }
      const bgTarget = fixedTarget ?? (await activeFront())
      if (!bgTarget) {
        await reply(chatID, "[tg-bridge] 无法解析目标会话（没有任何已知会话）")
        return
      }
      bgLastAttempt.set(bgTarget, Date.now())
      await reply(chatID, await bgPromote(bgTarget, "手动按钮/命令"))
      return
    }
    if (cmd === "model" || text === "/model" || text.startsWith("/model ")) {
      // R2231 模型选择。无参 = 渲染选择器（mdl: 按钮驱动）；/model <名称|id|provider/id> = 直切。
      const mTarget = fixedTarget ?? (await activeFront())
      if (!mTarget) {
        await reply(chatID, "[tg-bridge] 无法解析目标会话（没有任何已知会话）")
        return
      }
      const list = await modelHttpList()
      if (list.length === 0) {
        await reply(chatID, "❌ 拉取模型列表失败（宿主 HttpApi GET /api/model 不可用）")
        return
      }
      const sesNow = await modelHttpSession(mTarget)
      const curKey = sesNow ? `${sesNow.providerID}/${sesNow.id}` : ""
      const arg = commandArg(text).trim()
      if (arg) {
        const hit = resolveModelRef(arg, list, sesNow ?? undefined)
        if (!hit) {
          const sample = list.slice(0, 12).map((m) => m.key).join("、")
          await reply(chatID, `❌ 未找到模型：${clean(arg, 40)}\n可用的（节选）：${sample}${list.length > 12 ? "…" : ""}\n发 /model 打开选择列表。`)
          return
        }
        const res = await modelHttpSet(mTarget, { id: hit.id, providerID: hit.providerID })
        if (!res.ok) {
          const why = typeof res.body === "object" && res.body ? String(res.body.error ?? "") || String(res.body) : String(res.body)
          await reply(chatID, `❌ 切换失败（HTTP ${res.status}）：${clean(why, 140)}`)
          return
        }
        await reply(chatID, `✅ ${sessionTag(mTarget)}（${mTarget.slice(0, 12)}）→ <b>${htmlEsc(hit.label)}</b>\n下次生成生效；随时 /model 查看或再切。`)
        return
      }
      modelMenuCache.set(chatID, { list, ts: Date.now() })
      await reply(chatID, modelMenuText(curKey, list), buildModelKeyboard(list, 0, curKey))
      return
    }
    if (text === "/autoguard" || text.startsWith("/autoguard ") || cmd === "autoguard") {
      // 自动停止守卫的开关/状态（用户 2026-09-28 新增，菜单「🔁 循环」里也有两枚按钮）。
      // 语义：problem = 助手宣告 [SIGNAL:PROBLEM] 或本轮 [STATUS: STOP] 时停循环；
      //       websearch = 助手请求网页搜索或真调了搜索工具时停循环（等用户授权）。
      const arg = commandArg(text).toLowerCase()
      const cur = readGuard()
      const onoff = (w: string): string => (w ? "开" : "关")
      const show = (): string => {
        const c = readGuard()
        const trip = readGuardLastTrip()
        const t = trip?.at ? `\n· 最近触发：${String(trip.kind ?? "?")}｜${String(trip.reason ?? "").slice(0, 100)}（${new Date(Number(trip.at)).toISOString().slice(11, 19)}Z 会话 ${String(trip.sid ?? "?").slice(0, 12)}）` : "\n· 最近触发：无"
        return `[tg-bridge] 自动停止守卫：问题即停=${onoff(c.problem)}｜搜索即停=${onoff(c.websearch)}${t}\n` +
          "· 触发后循环停住等你处理；恢复用 /loop start（菜单「继续循环」）\n" +
          "· 改开关：/autoguard on|off（全部）、/autoguard problem on|off、/autoguard web on|off"
      }
      // 解析交给共享纯函数（loop-guard.ts）：菜单按钮投送的正是「头 + 值」三段式，
      // 这条路径必须能被单测覆盖，不能只靠"看着对"。
      const act = parseGuardArg(arg, cur)
      if (act.kind === "status") {
        await reply(chatID, show())
        return
      }
      if (act.kind === "help") {
        await reply(chatID, `[tg-bridge] 用法：/autoguard [on|off|status] | problem on|off | web on|off\n${show()}`)
        return
      }
      writeGuard(act.cfg)
      const changed = act.cfg.problem !== cur.problem || act.cfg.websearch !== cur.websearch
      const head = act.what === "all" ? "守卫" : act.what === "problem" ? "问题即停" : "搜索即停"
      await reply(
        chatID,
        `[tg-bridge] ${head} → 问题=${onoff(act.cfg.problem)}｜搜索=${onoff(act.cfg.websearch)}${changed ? "" : "（无变化）"}\n${show()}`,
      )
      return
    }
    if (text === "/replay" || text.startsWith("/replay ") || text === "/reload" || text.startsWith("/reload ") || cmd === "replay" || cmd === "reload") {
      const target = (fixedTarget?.length ?? 0) > 0 ? fixedTarget : await activeFront()
      if (!target) {
        await reply(chatID, "[tg-bridge] no session to replay (none active/front/pinned)")
        return
      }
      const argText = commandArg(text)
      const nMax = (t: string): number => /^\d+$/.test(t) ? Math.min(Number(t), 200) : 0
      const n = argText === "all" || argText === "everything" ? 200 : (nMax(argText) || 5)
      const msgs = await fetchTail(target, n)
      if (!msgs) {
        await reply(chatID, `[tg-bridge] no messages for ${target.slice(0, 12)}`)
        return
      }
      for (const m of msgs) await protoPushAssistantMessage(target, String(chatID), m)
      const note = `加载最近 ${argText === "all" || argText === "everything" ? "全部" : n} 条消息`
      await reply(chatID, `[tg-bridge] ${note} → ${target.slice(0, 12)}（协议分条，未推进标记）`)
      return
    }
    if (text === "/compaction" || cmd === "compaction") {
      const target = (fixedTarget?.length ?? 0) > 0 ? fixedTarget : await activeFront()
      if (!target) {
        await reply(chatID, "[tg-bridge] no session for compaction lookup")
        return
      }
      const fn = (client as any)?.session?.latestCompaction
      if (typeof fn !== "function") {
        await reply(chatID, "[tg-bridge] compaction lookup unavailable (compat too old)")
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
        await reply(chatID, `[tg-bridge] no compaction row in ${target.slice(0, 12)}`)
        return
      }
      await protoPushAssistantMessage(target, String(chatID), m)
      await reply(chatID, `[tg-bridge] compaction → ${target.slice(0, 12)}（协议分条）`)
      return
    }
    if (text === "/digest" || cmd === "digest") {
      const target = (fixedTarget?.length ?? 0) > 0 ? fixedTarget : await activeFront()
      if (!target) {
        await reply(chatID, "[tg-bridge] no session to digest (none active/front/pinned)")
        return
      }
      const msgs = await fetchTail(target, 10)
      if (!msgs) {
        await reply(chatID, `[tg-bridge] no messages for ${target.slice(0, 12)}`)
        return
      }
      for (const m of msgs) await protoPushAssistantMessage(target, String(chatID), m)
      await reply(chatID, `[tg-bridge] digest ${msgs.length} 条 → ${target.slice(0, 12)}（协议分条）`)
      return
    }
    if (text === "/queue" || cmd === "queue") {
      const lines: string[] = [`📌 置顶注入队列（len=${pinQueue.length}）`]
      if (pinQueue.length === 0) {
        lines.push("（空 — 无待注入）")
      } else {
        pinQueue.slice(0, 10).forEach((item, i) => {
          const snippet = clean(item.text, 60).replace(/\n/g, " ")
          lines.push(`  ${i + 1}. → ${item.sid.slice(0, 12)} len=${item.text.length}（${fmtTime(item.ts) || "?"}）${snippet}`)
        })
        if (pinQueue.length > 10) lines.push(`  … 及另外 ${pinQueue.length - 10} 条`)
      }
      lines.push(`[tg-bridge] outbound queue（len=${outQueue.length}）`)
      if (outQueue.length === 0) {
        lines.push("（空 — 无待发消息）")
      } else {
        outQueue.slice(0, 10).forEach((item, i) => {
          const snippet = clean(item.text, 60).replace(/\n/g, " ")
          lines.push(`  ${i + 1}. → ${sanitizeLog(item.chat)} len=${item.text.length}（${fmtTime(item.ts) || "?"}）${snippet}`)
        })
        if (outQueue.length > 10) lines.push(`  … 及另外 ${outQueue.length - 10} 条`)
      }
      await reply(chatID, lines.join("\n"))
      return
    }
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
      while (strippedKb.size > 500) {
        const first = strippedKb.values().next()
        if (first.done) break
        strippedKb.delete(first.value)
      }
      savePersistedState()
      await log("info", `stripall done (cleared=${n})`)
      await reply(chatID, `[tg-bridge] 已清 ${n} 条旧回复按钮（最新一条保留，下条落地时照常轮换）`)
      return
    }
    if (text === "/version" || cmd === "version") {
      await reply(chatID, `[tg-bridge] ver=${VERSION} flt=${filtLine()}`)
      return
    }
    if (text === "/info" || cmd === "info") {
      const target = fixedTarget ?? (await activeFront())
      if (!target) {
        await reply(chatID, "[tg-bridge] no session (none active/front/pinned)")
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
      const m = filterMenu()
      await reply(chatID, m.text, m.kb)
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
        `[tg-bridge] 本 Bot 应答：${selfMute ? "只答命令（普通文本不再自动注入）" : "开启（普通文本照常自动注入）"} · bot=${sanitizeLog(BOT_ID)}`,
      )
      return
    }
    if (text === "/stop" || cmd === "stop") {
      const target = fixedTarget ?? (await activeFront())
      if (!target) {
        await reply(chatID, "[tg-bridge] no session to stop")
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
        await reply(chatID, "[tg-bridge] no session to compact")
        return
      }
      // 优先走宿主自带认证的内部通道（_client），本地裸 HTTP 无票必 401，只做兜底
      const base = (client as any)?._client
      if (base?.post) {
        try {
          await base.post({ url: `/api/session/${encodeURIComponent(target)}/compact` })
          await reply(chatID, `[tg-bridge] compact triggered for ${target.slice(0, 12)}`)
          return
        } catch (err) {
          await log("error", `compact via _client failed: ${sanitizeLog(err).slice(0, 160)}`)
        }
      }
      const fn = (client as any)?.session?.compact
      if (typeof fn !== "function") {
        await reply(chatID, "[tg-bridge] compact unavailable (compat too old)")
        return
      }
      try {
        await fn.call((client as any).session, { path: { id: target } })
        await reply(chatID, `[tg-bridge] compact triggered for ${target.slice(0, 12)}`)
      } catch (err) {
        const msg = sanitizeLog(err).slice(0, 200)
        const unavailable = /compact unavailable|no ctx\.session\.compact/i.test(msg)
        const hint = unavailable
          ? "\n本宿主构建未向插件开放压缩入口（无 ctx.session.compact、命令目录无 /compact、本机 API 需认证）。"
          : /401|n authorized|orized/i.test(msg)
            ? "（server要认证，插件调不动；压缩由服务端按需自动执行）"
            : ""
        const alt = unavailable ? "\n可用替代：/migrate（带最近摘要迁移到新会话）" : ""
        await reply(chatID, `[tg-bridge] compact failed: ${msg}${hint}${alt}`)
      }
      return
    }
    if (text === "/new" || text.startsWith("/new ") || cmd === "new") {
      const title = commandArg(text)
      const fn = (client as any)?.session?.createSession
      if (typeof fn !== "function") {
        await reply(chatID, "[tg-bridge] new unavailable (compat too old)")
        return
      }
      try {
        const r = await fn.call((client as any).session, title ? { title } : {})
        const nid = String((r as any)?.id ?? (r as any)?.sessionID ?? (r as any)?.data?.id ?? "")
        await reply(chatID, nid ? `[tg-bridge] created ${nid.slice(0, 12)}${title ? `（${clean(title, 30)}）` : ""}（用 /use 切换）` : "[tg-bridge] create returned no id")
      } catch (err) {
        await reply(chatID, `[tg-bridge] new failed: ${sanitizeLog(err).slice(0, 200)}`)
      }
      return
    }
    if (text === "/migrate" || cmd === "migrate") {
      // 压缩无门时的活路：新会话 + 最近动态摘要，全程手机可走
      const target = fixedTarget ?? (await activeFront())
      if (!target) {
        await reply(chatID, "[tg-bridge] no session to migrate")
        return
      }
      const cfn = (client as any)?.session?.createSession
      if (typeof cfn !== "function") {
        await reply(chatID, "[tg-bridge] migrate unavailable (compat too old)")
        return
      }
      await reply(chatID, "⏳ 正在打包迁移（读最近消息…）")
      let tail: any[] | null = null
      try {
        tail = await fetchTail(target, 40)
      } catch {
        tail = null
      }
      const lines: string[] = []
      for (const m of tail ?? []) {
        const info = (m as any)?.info ?? {}
        const role = info?.role === "user" ? "用户" : info?.role === "assistant" ? "助手" : "系统"
        const txt = partsOf(m)
          .filter((p: any) => p?.type === "text")
          .map((p: any) => String(p?.text ?? ""))
          .join("")
          .trim()
          .replace(/\s+/g, " ")
        if (!txt) continue
        lines.push(`【${role}】${txt.slice(0, 200)}`)
        if (lines.join("\n").length > 6000) break
      }
      if (lines.length === 0) {
        await reply(chatID, "[tg-bridge] 无可迁移内容（最近消息为空）")
        return
      }
      try {
        const r = await cfn.call((client as any).session, { title: `迁移-${target.slice(0, 8)}` })
        const nid = String((r as any)?.id ?? (r as any)?.sessionID ?? (r as any)?.data?.id ?? "")
        if (!nid) {
          await reply(chatID, "[tg-bridge] create returned no id")
          return
        }
        const perr = await doPrompt(nid, `【会话迁移】以下为旧会话 ${target.slice(0, 12)} 最近动态摘要，新会话延续工作：\n${lines.join("\n")}`, "")
        if (perr) {
          await reply(chatID, `[tg-bridge] 新会话已建但摘要注入失败：${perr}`)
          return
        }
        await reply(chatID, `✅ 已迁移到新会话 ${nid.slice(0, 12)}（${lines.length} 条摘要），点按钮切换：`, [[{ text: `切换 ${nid.slice(0, 12)}`, callback_data: `use:${nid}` }]])
        await log("info", `migrate ${target.slice(0, 12)} -> ${nid.slice(0, 12)} (${lines.length} lines)`)
      } catch (err) {
        await reply(chatID, `[tg-bridge] migrate failed: ${sanitizeLog(err).slice(0, 200)}`)
      }
      return
    }
    if (text === "/drops" || cmd === "drops") {
      if (dropRing.length === 0) {
        await reply(chatID, "[tg-bridge] drops（0 — 无近期发送失败）")
        return
      }
      const lines = ["[tg-bridge] drops（最近）"]
      for (const d of dropRing.slice(-10)) lines.push(`· [${fmtTime(d.ts) || "?"}] ${d.kind}: ${d.detail}`.slice(0, 300))
      await reply(chatID, lines.join("\n"))
      return
    }
    if (text === "/pause" || cmd === "pause") {
      pausedMode = true
      savePersistedState()
      await reply(chatID, "[tg-bridge] paused（实时推送已停，命令仍响应；/resume 恢复）")
      return
    }
    if (text === "/resume" || cmd === "resume") {
      pausedMode = false
      savePersistedState()
      await reply(chatID, "[tg-bridge] resumed（实时推送已恢复）")
      return
    }
    if (text === "/flush" || cmd === "flush") {
      const n = outQueue.length
      await flushQueue()
      const pinSids = [...new Set(pinQueue.map((qq) => qq.sid))]
      for (const sid of pinSids) void pumpInject(sid)
      await reply(chatID, `[tg-bridge] flushed（之前积压 ${n} 条，剩余 ${outQueue.length} 条；注入队列 ${pinQueue.length} 条已触发继续）`)
      return
    }
    if (text === "/drop" || cmd === "drop") {
      const n = outQueue.length
      outQueue.length = 0
      for (const [c, mid] of [...listPlaceholder.entries()]) {
        listPlaceholder.delete(c)
        try {
          await tgFetch("deleteMessage", { chat_id: Number(c) || c, message_id: mid })
        } catch {
          /* best-effort */
        }
      }
      savePersistedState()
      await reply(chatID, `[tg-bridge] dropped（已丢弃 ${n} 条队列消息及占位条）`)
      return
    }
    if (text === "/dropq" || cmd === "dropq") {
      const n = pinQueue.length
      pinQueue.length = 0
      savePersistedState()
      await reply(chatID, `[tg-bridge] dropped pin queue（已丢弃 ${n} 条待注入）`)
      return
    }
    if (text === "/inject" || cmd === "inject" || text.startsWith("/inject ")) {
      const want = commandArg(text).toLowerCase()
      if (want === "now" || want === "idle") {
        injectMode = want
        savePersistedState()
        await reply(chatID, `[tg-bridge] 注入时机 → ${want === "idle" ? "完成插入（等 AI 本轮结束）" : "立即插入（默认）"}`)
        return
      }
      await reply(chatID, `[tg-bridge] 注入时机当前：${injectMode === "idle" ? "完成插入" : "立即插入"}（/inject now|idle 切换，也可在 /quiet 菜单点选）`)
      return
    }
    if (text === "/owner" || cmd === "owner") {
      let info = "(file missing)"
      try {
        const j = JSON.parse(readFileSync(OWNER_PATH, "utf8")) as any
        const fmtOwn = (o: any): string => {
          if (!o || typeof o.id !== "string") return "(none)"
          const age = typeof o.ts === "number" ? `${Math.round((Date.now() - o.ts) / 1000)}s前` : "?"
          return `${o.id.slice(0, 12)}（${age}）`
        }
        info = `tg=${fmtOwn(j?.tg)} ac=${fmtOwn(j?.ac)}`
      } catch (err) {
        info = `read failed: ${sanitizeLog(err).slice(0, 100)}`
      }
      await reply(chatID, `[tg-bridge] owner: ${info}`)
      return
    }
    if (text === "/offset" || cmd === "offset") {
      await reply(chatID, `[tg-bridge] offset=${persistedOffset}`)
      return
    }
    if (text === "/logs" || text.startsWith("/logs ") || cmd === "logs") {
      const arg = commandArg(text)
      const n = /^\d+$/.test(arg) ? Math.min(Number(arg), 40) : 20
      let lines: string[] = []
      try {
        const data = readFileSync(TAP_PATH, "utf8").split("\n").filter((l) => l.trim() !== "")
        lines = data.slice(-n)
      } catch (err) {
        await reply(chatID, `[tg-bridge] logs read failed: ${sanitizeLog(err).slice(0, 100)}`)
        return
      }
      if (lines.length === 0) {
        await reply(chatID, "[tg-bridge] logs（空）")
        return
      }
      // R1845：/logs 读的是**宿主**插件日志（TAP_PATH）—— 里面可能夹带其它插件/undici 写的
      // 原始 fetch URL（含 bot token）或用户粘贴的密钥，这些行**没经过**本插件的 log() 出口脱敏。
      // 直接把原文发到 Telegram = 把可能泄露的密钥送到 TG 服务器。发送前统一脱敏：
      //   redactSecrets 抹 token 形态；再按本进程真实 TOKEN 精确抹除（不赌形态匹配）。
      const dump = lines.join("\n")
      const safeDump = TOKEN.length >= 20 ? dump.split(TOKEN).join("<TOKEN>") : dump
      await reply(chatID, `[tg-bridge] logs（近${lines.length}行）\n${redactSecrets(safeDump).slice(-3500)}`)
      return
    }
    if (text === "/errors" || text.startsWith("/errors ") || cmd === "errors") {
      const arg = commandArg(text)
      const n = /^\d+$/.test(arg) ? Math.min(Number(arg), 30) : 5
      if (errorRing.length === 0) {
        await reply(chatID, "[tg-bridge] errors（0 — 无近期错误）")
        return
      }
      const lines = ["[tg-bridge] errors（最近）"]
      for (const e of errorRing.slice(-n)) lines.push(`· [${fmtTime(e.ts) || "?"}] ${e.msg}`.slice(0, 300))
      await reply(chatID, lines.join("\n"))
      return
    }
    if (text === "/whoami" || cmd === "whoami") {
      const target = fixedTarget ?? (await activeFront())
      await reply(chatID, [`[tg-bridge] whoami`, `· chat=${sanitizeLog(chatID)}`, `· target=${(target || "(none)").slice(0, 12)}${fixedTarget ? "（已钉选）" : ""}`, `· ver=${VERSION}`].join("\n"))
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
        await reply(chatID, "[tg-bridge] healcards：没有可用的推送 chat")
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
              // 同上：已被巡检对账纠正过就别再写第二遍（runningAt 已清、状态已落盘）。
              if (alreadyReconciled(key, stt)) continue
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
    const KNOWN_CMDS = new Set(["menu", "watch", "unwatch", "help", "start", "sessions", "use", "clear", "tgping", "ping", "replay", "reload", "compaction", "digest", "queue", "version", "info", "quiet", "loud", "stop", "compact", "new", "migrate", "sendto", "raw", "drops", "undo", "retry", "recents", "alias", "loop", "pause", "resume", "flush", "drop", "dropq", "inject", "owner", "offset", "logs", "errors", "whoami", "stripall", "selfmute", "healcards", "addbot", "botname", "botdesc", "autoguard", "background", "model"])
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
      await log("info", `selfmute ignored plain text (bot=${sanitizeLog(BOT_ID)}, len=${text.length})`)
      await reply(chatID, "🤫 本 Bot 当前是「只答命令」：这条没注入。恢复自动应答：/selfmute off")
      return
    }
    await log("info", `inject from tg (chat=${sanitizeLog(chatID)}, len=${text.length}) -> foreground=${sanitizeLog(target)}`)
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
        await log("error", "poll loop not owner, waiting (keep timer for takeover)")
      }
      return
    }
    if (pollLostLogged) {
      pollLostLogged = false
      await log("info", "poll loop took ownership")
    }
    claimPollOwner(pollInstanceId, "tg")
    syncPersistedTarget()
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
      const url = `${apiBase}/getUpdates?offset=${encodeURIComponent(offset)}&limit=10&timeout=20`
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
  const peekLatestUpdateId = async (): Promise<number | null> => {
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 15000)
      try {
        const r = await fetch(`${apiBase}/getUpdates?offset=-1&limit=1`, {
          headers: { "content-type": "application/json" },
          signal: ctl.signal,
        })
        if (!r.ok) return null
        const j: any = await r.json().catch(() => null)
        const arr = Array.isArray(j?.result) ? j.result : []
        if (arr.length === 0) return null
        const id = Number(arr[arr.length - 1]?.update_id)
        return Number.isFinite(id) ? id : null
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return null
    }
  }
  // 兄弟基线：扫描其它 Bot 的状态文件，取它们 lastRealUpdateId 的最大值。
  // 只在本实例自己没有任何真实处理记录时使用（否则自己就是最准的基线）。
  const siblingBaseline = (): number | null => {
    if (lastRealUpdateId > 0) return null
    let best = 0
    for (const f of globSync("REDACTED_ROOT/.config/opencode/tg-chats*.json")) {
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
    const real = await peekLatestUpdateId()
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
        clearInterval(leaseWatch)
        return
      }
      if (!pollAbort || polling === false) return
      if (ownsPollLease()) return
      pollAbortTakenOver = true
      try {
        pollAbort.abort()
      } catch {
        /* already gone */
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
      if (now >= floodUntil) clearSelfFlooded(BOT_ID, now)
      // 自己正在限流：此时替别人喊也发不出去（sendTextRaw 直接 retry 进队列），跳过。
      if (now < floodUntil) return
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
        const hr = await bgHttpPromote(sid)
        await log(hr.ok ? "info" : "warn", `bg-auto http-fallback: ${hr.text.slice(0, 140)} (session=${sanitizeLog(sid).slice(0, 12)})`)
        return
      }
      try {
        await fn.call(sessAny?.background ? sessAny : expSess, { sessionID: sid })
        await log("info", `bg-auto promoted: session=${sanitizeLog(sid).slice(0, 12)} why=${sanitizeLog(d.why)}`)
      } catch (err) {
        await log("error", `bg-auto failed: session=${sanitizeLog(sid).slice(0, 12)} err=${sanitizeLog(String(err)).slice(0, 120)}`)
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
  const lastCompactNotice = new Map<string, number>()
  const lastCompactTotal = new Map<string, number>()
  const COMPACT_DROP_RATIO = 0.6
  // 门槛：只有"积累了相当多上下文"之后的骤降才算压缩事件，避免小数字抖动/换模型窗口误报。
  const COMPACT_MIN_BEFORE = 50_000
  const COMPACT_NOTICE_DEDUPE_MS = 180_000
  const noteHostCompaction = async (
    sid: string,
    // R1035：加 "event" —— 宿主**主动报**的 compaction 事件（最可靠的一路）。
    how: "api" | "ctxdrop" | "event",
    atMs: number,
    before: number,
    after: number,
  ): Promise<void> => {
    if ((Date.now() - (lastCompactNotice.get(sid) ?? 0)) < COMPACT_NOTICE_DEDUPE_MS) return
    const chat = pushChatResolve()
    if (!chat) return
    lastCompactNotice.set(sid, Date.now())
    lastCompactTotal.set(sid, after)
    const u = ctxUsage.get(sid)
    const win = u ? windowFor(u.modelID, u.providerID) : 0
    const nm = clean(sessionNameOf(sid) || "", 40) || sid.slice(0, 12)
    const exact = how === "api" ? `${new Date(atMs).toISOString().replace("T", " ").slice(0, 16)}Z` : "刚刚（宿主未给出精确时间）"
    // 数字段与"怎么发现的"两段都交给纯函数判（v2lib/compact-notice.ts + 单测）。
    // 关键修正：`after <= 0` 是"**未知**"，对**所有**路成立（不只是 event）——
    // api 路拿不到 usage 时同样传 0，内联旧写法会显示"现在只占 0B"= 假数据。
    const body = [
      `<b>${compactTitle(how)}</b> · ${htmlEsc(nm)}`,
      ``,
      compactWaterLine(before, after, win),
      ``,
      compactHowLine(how, exact),
    ]
      .filter((l) => l !== "")
      .join("\n")
    // sendTextRaw 是**直调**的（不经过 protoSend）→ 成功时一行日志都不打，
    // "到底发没发"在日志里完全看不出来（L1932 的同款教训）→ 必须留痕。
    // 这次**不静默**：用户明确说过"压缩没有发"，静默卡片等于又发了个没用的东西。
    const r = await sendTextRaw(chat, protoBlock(`🗜 上下文已压缩`, body), undefined, false)
    await log(
      "info",
      `compaction notice (session=${sanitizeLog(sid).slice(0, 14)}, how=${how}, ` +
        `${compactLogDelta(before, after)}, result=${r.r}, at=${atMs})`,
    )
  }
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
        // 回填**前**留一份累计值：压缩会让它骤降，只有拿回填前的数字才判得出"降了"。
        const prevTotal = ctxUsage.has(sid) ? ctxTotal(ctxUsage.get(sid)!) : 0
        try {
          await backfillCtxUsage(sid)
        } catch {
          /* best-effort：下一轮再试 */
        }
        // 第二探测：ctx 骤降 = 压缩（API 漏报时的唯一救命通道）。
        // 门槛 + 去重都在 noteHostCompaction 里；这里只负责判"降了"。
        const nowTotal = ctxUsage.has(sid) ? ctxTotal(ctxUsage.get(sid)!) : 0
        const dropVerdict = compactDropVerdict(prevTotal, nowTotal, COMPACT_MIN_BEFORE, COMPACT_DROP_RATIO)
        if (dropVerdict.fire) {
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
              const pctNow = u ? (ctxTotal(u) / windowFor(u.modelID, u.providerID)) * 100 : -1
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
              r = await editTextRaw(
                chat,
                msgId,
                `${real === "completed" ? "✅ 已完成" : "❌ 失败"} · 用时约 ${mins} 分钟`,
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
            //   ① 宿主二进制（REDACTED_ROOT/.opencode/bin/opencode，185MB，strings 出 75 万行）里
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
    void backfillStrip()
  }, 5000)
  setTimeout(() => {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    runOffsetCheck("startup")
  }, 8000)
  setInterval(() => {
    if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
    runOffsetCheck("periodic")
  }, 10 * 60_000)

  // R1567：turn-end note 改为**轮询**（用户指令：AI 主动结束输出→每轮一条短提示）。
  // 实证：宿主写完 time.completed 后不再发 message.updated 事件（msg_0eacd1e69 在
  // 01:36:47 后零事件、01:36:48.4 才被 auto-continue 轮询读出终态）→ 事件驱动
  // 结构性看不见终态，必须与 auto-continue（L1584 acTimer 轮询）同源。从尾部反向
  // 找最近一条 completed>0 的 assistant 消息，按消息 id 去重；不受 loopStopped 限制
  // （无论有无循环都要提示）；pausedMode / TURN_END_NOTIFY 门控不变。
  setInterval(() => {
    void (async () => {
      if ((globalThis as Record<string, unknown>)[GEN_KEY] !== myGen) return
      if (!TURN_END_NOTIFY || pausedMode) return
      // R1596：非主实例不发 turn-end note（alt/bot3 的 front 是各自项目的会话，见
      // TURN_NOTE_OWNER_ONLY 注释）——放在最前，避免镜像/异项目会话白跑采样。
      if (noteOwnerOnlySkipped({ ownerOnly: TURN_NOTE_OWNER_ONLY, isOwner: QUEUE_CARD_OWNER })) return
      const sid = fixedTarget ?? frontSessionID ?? persistedFront
      if (!sid || !isPrimaryPush(sid)) return
      const chat = pushChatResolve()
      if (!chat) return
      try {
        const pe = await client.session.messages({ path: { id: sid } })
        const arr = Array.isArray(pe?.data) ? pe.data : []
        if (!arr.length) return
        for (let i = arr.length - 1; i >= 0; i--) {
          const m = arr[i] as any
          if (String(m?.role ?? m?.info?.role ?? "") !== "assistant") continue
          const completed = Number(m?.time?.completed ?? m?.info?.time?.completed ?? 0)
          if (!(completed > 0)) continue
          // R1569：热重载后新实例 Set 为空，旧消息（含已通知过的）会再补发 →
          // 只认本实例启动之后完成的消息。
          if (completed < turnNoteBootAt) break
          // R1597：安静窗——完成不足 TURN_NOTE_QUIET_MS 的消息跳过评估（宿主注入
          // 下一条循环提示前撞上的轮询会误判"已停摆"）。等下轮再评估。
          if (completed > Date.now() - TURN_NOTE_QUIET_MS) continue
          const mid = String(m?.id ?? m?.info?.id ?? "")
          const noteKey = `${sid}:${mid}`
          if (turnEndNotified.has(noteKey)) break
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
          const note = turnEndLine(
            TURN_NOTE_LOOP_SKIP
              ? { loop: false, name: sessionNameOf(sid) }
              : { loop: !loopStopped(), round: noteRound, name: sessionNameOf(sid) }
          )
          void sendQueued(String(chat), note)
            .then(() => log("info", `turn-end note sent (session=${sanitizeLog(sid).slice(0, 12)} mid=${mid.slice(0, 12)})`))
            .catch(() => { /* best-effort */ })
          break
        }
      } catch {
        /* best-effort */
      }
    })()
  }, 20_000)

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
        const role = String(m?.role ?? m?.info?.role ?? "")
        const typ = String(m?.type ?? m?.info?.type ?? "")
        if (role !== "assistant" && typ !== "assistant") continue
        const content = partsOf(m)
        const hasText = content.some(
          (p: any) => (p?.type === "text" || p?.type === "reasoning") && String(p?.text ?? "").trim()
        )
        if (!hasText) continue
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
          (k) => k.startsWith(`${sid}:message:${msgKey}:`) || k.startsWith(`${sid}:thinking:${msgKey}:`)
        )
        if (seen) continue
        await protoPushAssistantMessage(sid, String(chat), m, false, "full")
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
  let lastCardPinAt = 0
  const pinInjectCard = async (chat: string, mid: number, tag: string): Promise<void> => {
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
    } catch (err) {
      await log("warn", `inject card pin error (bot=${BOT_ID}): ${sanitizeLog(err).slice(0, 100)}`)
    }
  }
  const ensureInjectCardPin = async (chat: string, mid: number, now: number): Promise<void> => {
    // 不与队列卡抢置顶（同一 chat 只有一条置顶；队列有卡时让位，避免两卡互相顶）。
    // 否则每 10 分钟静默重申一次：自愈被别处置顶顶掉 / 重载后置顶丢失。
    // 重复 pin 同一条 Telegram 幂等且静默，代价可忽略。
    if (queuePin.get(chat) !== undefined) return
    if (lastCardPinAt > 0 && now - lastCardPinAt < 600_000) return
    lastCardPinAt = now
    await pinInjectCard(chat, mid, "keep")
  }
  try {
    registerInjectNotifier(BOT_ID, async (sessionID, kind) => {
      if (!ownsLoopSession(sessionID)) return
      const now = Date.now()
      if (now - lastCardEditAt < 30_000) return
      lastCardEditAt = now
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
      const text = injectCardText({
        bot: BOT_ID,
        lastAt: now,
        kind,
        sid: sessionID,
        count: st.count,
        avgGapMs: st.avgGapMs,
        gate: loopGateInfo(),
        now,
      })
      await log(
        "info",
        `inject card update (bot=${BOT_ID}, msg=${st.msgID ?? "new"}, kind=${kind}, count=${st.count}, session=${sanitizeLog(sessionID).slice(0, 12)})`,
      )
      if (st.msgID) {
        const r = await editTextRaw(chat, st.msgID, text)
        if (r.r === "sent") {
          writeInjectCardState(BOT_ID, st)
          await ensureInjectCardPin(chat, st.msgID, now)
          return
        }
        if (r.r === "retry") {
          // 网络/429/5xx：卡还在，别重发（越失败越发）；落盘计数，下轮注入继续编辑
          writeInjectCardState(BOT_ID, st)
          await log("info", `inject card edit deferred (bot=${BOT_ID}, msg=${st.msgID}, status=${r.status ?? 0})`)
          return
        }
        // drop：消息已被删/不可编辑 → 清理卡 id 走重建
        await log(
          "warn",
          `inject card edit failed (bot=${BOT_ID}, msg=${st.msgID}, r=${r.r}${r.desc ? `, desc=${sanitizeLog(r.desc).slice(0, 80)}` : ""}) → recreate`,
        )
        st.msgID = undefined
      }
      const s = await sendTextRaw(chat, text, undefined, true)
      if (s.r === "sent" && typeof s.id === "number" && s.id > 0) {
        st.msgID = s.id
        writeInjectCardState(BOT_ID, st)
        await log("info", `inject card created (bot=${BOT_ID}, msg=${s.id}, count=${st.count})`)
        lastCardPinAt = now
        await pinInjectCard(chat, s.id, "create")
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
          } else {
            busyTurn.add(msgSid)
            if (busyTurn.size > 200) {
              const fk = busyTurn.values().next()
              if (!fk.done) busyTurn.delete(fk.value)
            }
          }
        }
        // 压缩即清零（①）：compaction 事件到 → 水位置零，下条 assistant 重建
        if (msgSid && takeCompacted(msgSid)) {
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
      if (sid) await onIdle(sid)
    },
  }
}