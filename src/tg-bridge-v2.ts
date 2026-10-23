/**
 * 多 Bot 桥接入口（注册表驱动）。
 *
 * 设计目标：以后增加机器人时「一键接入」——只往
 *   $HOME/.config/opencode/tg-bots.json  追加一条（id + 各自的 token env 文件），
 * 不改代码、不新建插件文件。
 *
 * 每个 Bot 一套（互不干扰）：
 *   - 独立 getUpdates 轮询（不同 token 不会 409 冲突）
 *   - 独立状态文件 / poll owner 租约 / 命令缓存 / strip 记录 / tap 日志
 *   - 独立代号命名空间（TG_GEN_KEY），互不把对方判成过期实例
 *   - 独立 front / pinned / watch / 队列 / 置顶 / 别名 / 过滤设置
 * 有意共享：
 *   - loop-ctl.json（自动循环总闸是全局的，任一 Bot 的 /loop stop 都应停全局）
 *   - opencode 会话本身
 *
 * 为什么用「设 env + cache-bust 动态 import」：
 *   桥接模块的路径/代号是模块顶层常量，只有让每个 Bot 拿到独立的模块实例
 *   才会真正隔离。动态 import 必须**顺序 await**（并行会互相污染 env）。
 *   specifier 带 v2lib 源文件 mtime：改源码 → 新模块实例 → 新实例用同一个 Bot
 *   的代号把旧实例判成过期并接管，旧实例自行退出（generation gating）。
 */
import { readFileSync, writeFileSync, renameSync, statSync, appendFileSync, cpSync, rmSync, readdirSync, mkdirSync } from "node:fs"

/** 诊断写文件：插件的 console.error 会进 server 的 stderr（socket），日志里看不到。
 *  可用 TG_BRIDGE_DIAG_LOG 改写：隔离回归测试要写自己的日志，不能污染生产 diag（R-round2）。 */
const DIAG_PATH = process.env.TG_BRIDGE_DIAG_LOG ?? "/tmp/opencode/tg-bots-instance.log"
const diag = (msg: string): void => {
  try {
    appendFileSync(DIAG_PATH, `${new Date().toISOString()} ${msg}\n`, { encoding: "utf8", mode: 0o600 })
  } catch {
    /* best-effort */
  }
  console.error(msg)
}

const REGISTRY_PATH = process.env.TG_BOTS_PATH ?? `REDACTED_ROOT/.config/opencode/tg-bots.json`
const BRIDGE_SRC = `REDACTED_ROOT/.opencode/v2lib/tg-bridge.ts`
const V2LIB_DIR = `REDACTED_ROOT/.opencode/v2lib`
/** 快照根目录：必须在项目树内，裸包（@opencode-ai/*）靠向上找 node_modules 解析。 */
const LIVE_ROOT = `REDACTED_ROOT/.opencode/.v2lib-live`

/** 快照总数上限 3 份（**含本次**）：每份 ~536K，不清会随装载次数无限涨。 */
const gcLive = (tag: string, keepName: string): void => {
  try {
    const dirs = readdirSync(LIVE_ROOT)
      .filter((n) => n.startsWith(`${tag}-`) && n !== keepName)
      .map((n) => {
        const p = `${LIVE_ROOT}/${n}`
        return { p, m: statSync(p).mtimeMs }
      })
      .sort((a, b) => b.m - a.m)
    // dirs 已排除本次 → slice(2) 才是"总计 3 份（含本次）"。
    // 曾写成 slice(3) = 实际留 4 份：注释说 3、行为是 4，注释和行为不一致比没注释更坏。
    for (const d of dirs.slice(2)) {
      try {
        rmSync(d.p, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * 把 v2lib 整目录快照到全新路径再 import。**热重载能生效的前提**：只给主模块加
 * cache-bust 不够 —— 共享模块的相对 import 会解析成无 query 的旧 URL 命中缓存，
 * 于是新增导出在链接期就报「Export named ... not found」（真实事故 2026-09-28 02:33:43）。
 * 复制失败退回真实目录：会退回吃缓存的旧行为，但绝不能让三个 Bot 一起起不来。
 */
const snapshotV2lib = (tag: string): string => {
  const name = `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const dir = `${LIVE_ROOT}/${name}`
  try {
    // 只确保根目录存在，**绝不能 rm 整个根**：两个插件可能同一拍重载，会互删快照。
    mkdirSync(LIVE_ROOT, { recursive: true })
    let clean = false
    for (let attempt = 0; attempt < 2; attempt++) {
      const probe = `${V2LIB_DIR}/tg-bridge.ts`
      const before = statSync(probe).mtimeMs
      cpSync(V2LIB_DIR, dir, { recursive: true })
      // 撕裂快照检查：复制期间源文件被改 → 这份快照半新半旧，删掉重来
      if (before === statSync(probe).mtimeMs) {
        clean = true
        break
      }
      rmSync(dir, { recursive: true, force: true })
    }
    // R2433：连续两次都撕裂时，上一轮已把 dir 删掉 —— 旧代码直接 `return dir` 会返回一个
    // **不存在的路径**（L229 的 `await import(live/...)` 不在 try/catch 内 → setup 抛错 →
    // 三个 Bot 全部起不来）。与"复制失败"同策略：退回真实目录。
    if (!clean) {
      diag(`[tg-bridge] snapshot torn twice, fallback to live tree`)
      return V2LIB_DIR
    }
    gcLive(tag, name)
    return dir
  } catch (err) {
    diag(`[tg-bridge] snapshot failed, fallback to live tree: ${String(err).slice(0, 160)}`)
    return V2LIB_DIR
  }
}
const COMPAT_SRC = `REDACTED_ROOT/.opencode/v2lib/_v2compat.ts`

type BotSpec = {
  id: string
  label?: string
  envFile?: string
  fallbackEnvFile?: string
  noFallback?: boolean
  pushChat?: string
}

const readRegistry = (): BotSpec[] => {
  const out: BotSpec[] = []
  const seen = new Set<string>()
  const add = (b: BotSpec): void => {
    if (!b.id || !/^[a-z0-9_-]{1,24}$/i.test(b.id) || seen.has(b.id)) return
    seen.add(b.id)
    out.push(b)
  }
  try {
    const j = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as any
    const arr = Array.isArray(j?.bots) ? j.bots : []
    for (const b of arr) {
      add({
        id: String(b?.id ?? "").trim(),
        label: typeof b?.label === "string" ? b.label : undefined,
        envFile: typeof b?.envFile === "string" && b.envFile ? b.envFile : undefined,
        fallbackEnvFile: typeof b?.fallbackEnvFile === "string" && b.fallbackEnvFile ? b.fallbackEnvFile : undefined,
        noFallback: b?.noFallback === true,
        pushChat: typeof b?.pushChat === "string" && b.pushChat ? b.pushChat : undefined,
      })
    }
  } catch {
    /* 无注册表：继续走自动发现 / 单实例默认行为 */
  }
  // 无代码接入：任何 `tg-bot<id>.env`（含 TG_BOT_TOKEN）都会自动成为一个 Bot。
  // 这样「一次性增加多个 Bot」只需放文件（CI 侧由 tg-bots.extra secret / 批量脚本落盘），
  // 注册表哪怕被旧模板覆盖也不会让 bot3/bot4 静默消失（2026-10-21 工厂重置实况）。
  // 注册表显式条目优先（同 id 不重复），发现到的按文件名排序，启动顺序稳定。
  const home = process.env.HOME ?? "/root"
  for (const dir of [`${home}/.config/opencode`, `${home}/.opencode`]) {
    let names: string[] = []
    try {
      names = readdirSync(dir).sort()
    } catch {
      continue
    }
    for (const n of names) {
      const m = /^tg-bot([a-z0-9_-]{1,24})\.env$/i.exec(n)
      if (!m) continue
      // /addbot 的 id 形如 bot3，落盘文件是 tg-bot3.env；这里必须还原成同一个 id，
      // 否则注册表 bot3 与自动发现的 3 会各起一个实例、抢同一个 token（409）。
      const sfx = m[1].toLowerCase()
      const id = sfx.startsWith("bot") ? sfx : `bot${sfx}`
      if (seen.has(id)) continue
      const envFile = `${dir}/${n}`
      const env = readEnvFile(envFile)
      if (!env.TG_BOT_TOKEN) continue
      add({ id, label: env.TG_BOT_LABEL || id, envFile, noFallback: true })
    }
  }
  // 主 Bot：注册表缺失时也用 tg.env 自动接回（工厂重置后注册表可能只剩模板）。
  if (!seen.has("primary")) {
    for (const p of [`${home}/.opencode/tg.env`, `${home}/.config/opencode/tg.env`]) {
      if (readEnvFile(p).TG_BOT_TOKEN) {
        add({ id: "primary", label: "CI", envFile: p })
        break
      }
    }
  }
  // 去重：同一个 Telegram token 只能有一个轮询者。两个 Bot 条目用同一 token 会
  // 互相抢 getUpdates → 409 风暴（2026-10-23 实测：TG_BOT3_TOKEN 与 TG_BOT4_TOKEN
  // 是同一个 token，bot4 因此永远收不到消息）。保留第一个（primary 优先）。
  const tokenOwner = new Map<string, string>()
  const unique: BotSpec[] = []
  for (const b of out) {
    const tok = readEnvFile(b.envFile).TG_BOT_TOKEN ?? ""
    if (!tok) {
      unique.push(b)
      continue
    }
    const prev = tokenOwner.get(tok)
    if (prev) {
      diag(`[tg-bridge-v2] duplicate token: ${b.id} dropped (same token as ${prev})`)
      continue
    }
    tokenOwner.set(tok, b.id)
    unique.push(b)
  }
  return unique.length > 0 ? unique : [{ id: "primary" }]
}

/** 读 env 文件（只取键，不打印任何值） */
const readEnvFile = (path?: string): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!path) return out
  try {
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      const i = line.indexOf("=")
      if (i <= 0) continue
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "")
    }
  } catch {
    /* 文件不存在：该 Bot 视为未配置 */
  }
  return out
}

/**
 * 启动前 token 鉴权（R2507）。
 *
 * 只按形状校验会放过“格式合法但已被 Telegram 吊销”的 token：桥会启动，然后每 2 秒
 * getUpdates 一次 401，日志被同一签名刷屏，用户却收不到任何消息。这里在实例化前
 * 调一次 getMe，**只对确定性鉴权失败（400/401/403 / Unauthorized）跳过该 Bot**；
 * 网络超时、429、5xx 等瞬时错误仍放行，交给 poll 重试，避免误杀。
 *
 * token 只存在内存 Map 的 key 里，不写日志、不落盘。
 */
type TokenCheck = { ok: boolean; definitive: boolean; desc?: string; at: number }
const TOKEN_CHECK_TTL_MS = 10 * 60_000
const tokenCheckCache = new Map<string, TokenCheck>()
const checkBotToken = async (token: string): Promise<TokenCheck> => {
  const now = Date.now()
  const cached = tokenCheckCache.get(token)
  if (cached && now - cached.at < TOKEN_CHECK_TTL_MS) return cached
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    })
    const j = (await res.json().catch(() => null)) as any
    const desc = String(j?.description ?? `HTTP ${res.status}`).slice(0, 120)
    if (res.ok && j?.ok) {
      const ok: TokenCheck = { ok: true, definitive: true, at: now }
      tokenCheckCache.set(token, ok)
      return ok
    }
    const authRejected =
      res.status === 400 || res.status === 401 || res.status === 403 ||
      /unauthorized|not found|invalid.*token/i.test(desc)
    const out: TokenCheck = { ok: !authRejected, definitive: authRejected, desc, at: now }
    tokenCheckCache.set(token, out)
    return out
  } catch (err) {
    // 无法判断（断网/超时）→ 放行，不能因为一次网络抖动把 Bot 永久跳过。
    const out: TokenCheck = { ok: true, definitive: false, desc: String(err).slice(0, 120), at: now }
    tokenCheckCache.set(token, out)
    return out
  }
}

/** 跳过某个 Bot 时必须显式退休它的旧实例，否则旧 poll 循环会继续 401。 */
const retireBotInstance = (id: string): void => {
  const key = `__tgBridgeGen_${id}`
  const g = globalThis as Record<string, unknown>
  g[key] = (typeof g[key] === "number" ? (g[key] as number) : 0) + 1
  diag(`[tg-bridge-v2] retired skipped instance ${key}`)
}

/** 记录被跳过的 Bot，供 /info 与人工排查；不含 token。 */
const writeTokenStatus = (invalid: Array<{ id: string; desc: string }>): void => {
  const path = `REDACTED_ROOT/.config/opencode/tg-token-invalid.json`
  try {
    if (invalid.length === 0) {
      rmSync(path, { force: true })
      return
    }
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify({ updatedAt: new Date().toISOString(), bots: invalid }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    /* 诊断文件失败不影响桥启动 */
  }
}

// R-round2（2026-10-17 根因修复）：这里读到的是**模块顶层一次性常量**。
// 热重载只对缓存模块重调 setup()、不重求值顶层 → 顶层 bots 会永远停在进程启动时的
// 注册表，/addbot 新增的 bot 因此「登记了却不上线」（13:49:15 对照实验证明）。
// 改成 let + refreshRegistry()，由 setup() 每次进入时重读。
let bots = readRegistry()
let primarySpec = bots[0] ?? { id: "primary" }
// D4 诊断（R1）：模块求值即打印注册表读取结果——用于区分「入口被缓存只重跑 setup
// （旧 bots）」与「setup 循环卡死」两种「新 bot 不上线」故障（2026-10-17 实测排查）。
diag(`[tg-bridge-v2] module eval: registry ids=${bots.map((b) => b.id).join(",")}`)
let primaryEnv = readEnvFile(primarySpec.envFile ?? `REDACTED_ROOT/.config/opencode/tg.env`)

/** 重读注册表 + 重算 primary 派生值。必须在 setup() 开头调用（见上方注释）。 */
const refreshRegistry = (): void => {
  bots = readRegistry()
  primarySpec = bots[0] ?? { id: "primary" }
  primaryEnv = readEnvFile(primarySpec.envFile ?? `REDACTED_ROOT/.config/opencode/tg.env`)
}

/** 读某个状态文件的 front（只读，不修改任何实例状态）。 */
const readFrontFrom = (path: string): string | undefined => {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as any
    const f = typeof j?.front === "string" && /^ses_[A-Za-z0-9_-]+$/.test(j.front) ? j.front : ""
    return f || undefined
  } catch {
    return undefined
  }
}

/**
 * 为某个 Bot 生成显式配置（**不再改 process.env**）。
 * env 方案有个隐蔽的致命坑：入口热重载会重新求值整个模块图，上一次为备用 Bot
 * 写入的 env 会被“主实例”继承 → 两个实例用同一个 token 轮询 → getUpdates 409
 * 风暴 + 状态互相覆盖（实测踩过）。显式传参没有这个问题。
 * token/白名单只放进内存配置对象，绝不写日志。
 */
const botConfig = (bot: BotSpec, index: number) => {
  const sfx = `-${bot.id}`
  const own = readEnvFile(bot.envFile)
  const token = own.TG_BOT_TOKEN ?? own.TG_FALLBACK_BOT_TOKEN ?? ""
  const allowed = own.TG_ALLOWED_CHAT ?? primaryEnv.TG_ALLOWED_CHAT ?? ""
  const push = bot.pushChat ?? own.TG_PUSH_CHAT ?? primaryEnv.TG_PUSH_CHAT ?? ""
  return {
    id: bot.id,
    // 用户可见名（@username）由注册表 label 提供；状态文件/租约仍用稳定 id。
    label: bot.label,
    // 首个 Bot 沿用历史代号 __tgBridgeGen：这样它能接管（判过期）升级前遗留的旧实例，
    // 否则新旧实例会并存抢同一个 token → getUpdates 409 风暴。
    genKey: index === 0 ? undefined : `__tgBridgeGen_${bot.id}`,
    // 首个 Bot 沿用历史状态文件：auto-continue 的循环作用域读的是 tg-chats.json，
    // 换路径会让“当前循环会话”与桥接脱节。
    statePath: index === 0 ? `REDACTED_ROOT/.config/opencode/tg-chats.json` : `REDACTED_ROOT/.config/opencode/tg-chats${sfx}.json`,
    // 首个 Bot 沿用历史 owner 文件名：既让既有租约检查/AC 写入指向同一处，
    // 也保证换代时旧实例的租约能被直接接管。
    ownerPath: index === 0 ? "/tmp/opencode/tg-poll-owner.json" : `/tmp/opencode/tg-poll-owner${sfx}.json`,
    commandCachePath: `/tmp/opencode/tg-command-cache${sfx}.json`,
    stripStatePath: `/tmp/opencode/strip-run${sfx}.json`,
    stripFailPath: `/tmp/opencode/stripfail${sfx}.json`,
    tapPath: `/tmp/opencode/tg${sfx}.log`,
    configPath: bot.envFile ?? `REDACTED_ROOT/.config/opencode/tg.env`,
    fallbackEnvPath: bot.noFallback ? null : bot.fallbackEnvFile ?? null,
    token,
    // 新实例没有自己的 front 时继承主实例当前目标（之后各自独立）
    // R2500：非主实例的起始 front 必须读**它自己**的状态文件，绝不能读 primary 的。
    // 旧实现读 tg-chats.json（primary.front）→ 冷启动时若非主实例 persistedFront 尚为空，
    // 就会抢占 primary 会话 → 三 Bot 目标塌缩成一个、bot3/bot4 各自循环死
    // （2026-10-18 实报「循环注入提示卡没有更新，并且没有循环」的根因）。
    initialFront:
      index === 0
        ? undefined
        : readFrontFrom(`REDACTED_ROOT/.config/opencode/tg-chats${sfx}.json`),
    // 队列置顶卡只有一个 owner（同一 chat 里 Telegram 不允许跨 Bot 编辑）
    queueCardOwner: index === 0,
    // 非主实例从空 watch 开始：避免镜像主会话造成两个 Bot 交叉发言
    initialWatch: index === 0 ? undefined : [],
    // 备用投递通道：noFallback 的实例显式关闭；其余由 configureBot 从 fallbackEnvPath 读
    fallbackToken: bot.noFallback ? "" : undefined,
    allowedChats: allowed,
    pushChat: push,
  }
}

const srcVersion = (): string => {
  try {
    return `${statSync(BRIDGE_SRC).mtimeMs}-${statSync(COMPAT_SRC).mtimeMs}`
  } catch {
    return "0"
  }
}

/**
 * 每个 Bot 都用「cache-bust 动态 import + 显式 configureBot」启动，**包括主 Bot**。
 * 绝不能只用静态 import：热重载会重新求值模块图，那时 process.env 里可能还留着
 * 上一次为其它 Bot 写入的值 → 主实例被换成别的 token → 两个实例同 token 轮询
 * → getUpdates 409 风暴（实测踩过：主 token 一度完全没人轮询）。
 */
export default {
  id: "tg-bridge-v2",
  setup: async (context: any) => {
    // R-round2：热重载的唯一入口就是重调本函数——注册表必须在这里重读，
    // 否则顶层缓存的 bots 会让新增 bot 永远进不来。诊断行用于验证「确实读到了新注册表」。
    refreshRegistry()
    diag(`[tg-bridge-v2] setup: registry ids=${bots.map((b) => b.id).join(",")}`)
    // 从注册表移除/去重的 Bot，其旧实例不会因为“新 setup 没遍历到它”而自动停：
    // 它的代号键不在本轮重置范围内，poll 循环会继续跑并抢同一个 token（实测：bot4
    // 与 bot3 同 token 被去重后，bot4 旧实例仍在 getUpdates → bot3 永久 409）。
    // 这里把所有“已不在当前注册表”的代号键 +1，旧实例下一拍即判定自己被换代并退出。
    {
      const want = new Set(bots.map((b) => `__tgBridgeGen_${b.id}`))
      for (const k of Object.keys(globalThis)) {
        if (!k.startsWith("__tgBridgeGen_") || k.endsWith("__writerGen") || want.has(k)) continue
        const g = globalThis as Record<string, unknown>
        g[k] = (typeof g[k] === "number" ? (g[k] as number) : 0) + 1
        diag(`[tg-bridge-v2] retired stale instance ${k} (bot removed from registry)`)
      }
    }
    const disposers: Array<(() => void) | void> = []
    const version = srcVersion()
    // 一次 setup 快照一份，三个 Bot 共用；仍按 ?bot= 分成三个模块实例（见上方注释）。
    const live = snapshotV2lib("bridge")
    // 不带 query：与 v2lib 内部 "./_v2compat" 同一 URL，避免 _v2compat 出现两个实例
    // （它有模块级 Map/Set/db 句柄，劈成两半会让 token 统计与 db 缓存各算各的）。
    const compat: any = await import(`${live}/_v2compat.ts`)
    const { v2Bridge } = compat as { v2Bridge: (...a: any[]) => any }
    // R1790：**装载时**先保全上一进程留下的日志。
    // R1786 实测 /tmp/opencode 在进程重启时被整体清空（三个日志全归零，
    // systemd-tmpfiles-clean.timer=active），而未到 2MB 阈值时 rotateIfNeeded 不触发
    // → 重启前的日志既没归档也不轮转，直接消失（实际损失 04:00–08:07 全部诊断证据）。
    //
    // 为什么放**入口装载器**而不是 _v2compat 顶层：顶层会被 tests/*.test.ts 的 import 触发
    // （log-rotate / scope-guard 等 10 个测试文件都 import tg-bridge），那就会在**跑测试时
    // 轮转生产日志**。入口是生产专用路径，且每次 setup 只执行一次。
    try {
      const r = compat?.archiveOnStartup?.({ path: compat.TAP_PATH, archiveDir: compat.LOG_ARCHIVE_DIR })
      if (r?.rotated) diag(`[tg-bridge-v2] 启动前日志已归档 ${r.archive} (归档 ${r.archivedBytes}B / 留尾 ${r.keptBytes}B)`)
    } catch (e) {
      // 保全失败绝不能挡住启动：日志是诊断材料，不是命脉
      diag(`[tg-bridge-v2] 启动日志保全失败（不影响启动）: ${String(e).slice(0, 140)}`)
    }
    const invalidBots: Array<{ id: string; desc: string }> = []
    for (const [idx, bot] of bots.entries()) {
      diag(`[tg-bridge:${bot.id}] loading (idx=${idx})`)
      try {
        const mod: any = await import(`${live}/tg-bridge.ts?bot=${bot.id}&v=${version}`)
        const configure = mod?.configureBot ?? mod?.default?.configureBot
        const factory = mod?.TgBridgePlugin ?? mod?.default?.TgBridgePlugin
        if (typeof factory !== "function" || typeof configure !== "function") {
          diag(`[tg-bridge:${bot.id}] module missing TgBridgePlugin/configureBot (keys=${Object.keys(mod ?? {}).join(",").slice(0, 200)})`)
          continue
        }
        const cfg: any = botConfig(bot, idx)
        if (!cfg.token) {
          diag(`[tg-bridge:${bot.id}] skipped: token missing`)
          invalidBots.push({ id: bot.id, desc: "token missing" })
          if (idx > 0) retireBotInstance(bot.id)
          continue
        }
        // 鉴权失败的非主 Bot 直接跳过：启动它只会每 2s 刷一次 401，且永远收不到消息。
        // 主 Bot 即使鉴权失败也启动（否则连通知/修复入口都没有），由 poll 的鉴权熔断兜底。
        const tokenCheck = await checkBotToken(cfg.token)
        if (!tokenCheck.ok) {
          if (tokenCheck.definitive && idx > 0) {
            diag(`[tg-bridge:${bot.id}] skipped: Telegram rejected token (${tokenCheck.desc ?? "unauthorized"})`)
            invalidBots.push({ id: bot.id, desc: tokenCheck.desc ?? "unauthorized" })
            retireBotInstance(bot.id)
            continue
          }
          diag(
            `[tg-bridge:${bot.id}] token check warning (${tokenCheck.definitive ? "rejected" : "transient"}): ` +
              `${tokenCheck.desc ?? "unknown"}; starting anyway`,
          )
        }
        configure(cfg)
        const plugin: any = v2Bridge(`tg-bridge-v2:${bot.id}`, (client) => factory({ client } as any))
        disposers.push(await plugin.setup?.(context))
        diag(
          `[tg-bridge:${bot.id}] instance registered (label=${bot.label ?? bot.id}, token=${cfg.token ? "set" : "MISSING"}, allowed=${cfg.allowedChats ? "set" : "MISSING"}, push=${cfg.pushChat ? "set" : "MISSING"})`
        )
      } catch (err) {
        diag(`[tg-bridge:${bot.id}] instance failed: ${String(err).slice(0, 300)}`)
      }
    }
    writeTokenStatus(invalidBots)
    return () => {
      for (const d of disposers) {
        try {
          d?.()
        } catch {
          /* best-effort */
        }
      }
    }
  },
}

// addbot reload 2026-10-17T13:32:56Z

// addbot reload 2026-10-17T13:40:39Z (round1 verify)
