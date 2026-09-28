/**
 * 多 Bot 桥接入口（注册表驱动）。
 *
 * 设计目标：以后增加机器人时「一键接入」——只往
 *   REDACTED_ROOT/.config/opencode/tg-bots.json  追加一条（id + 各自的 token env 文件），
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
import { readFileSync, statSync, appendFileSync, cpSync, rmSync, readdirSync, mkdirSync } from "node:fs"

/** 诊断写文件：插件的 console.error 会进 server 的 stderr（socket），日志里看不到 */
const DIAG_PATH = "/tmp/opencode/tg-bots-instance.log"
const diag = (msg: string): void => {
  try {
    appendFileSync(DIAG_PATH, `${new Date().toISOString()} ${msg}\n`, { encoding: "utf8", mode: 0o600 })
  } catch {
    /* best-effort */
  }
  console.error(msg)
}

const REGISTRY_PATH = process.env.TG_BOTS_PATH ?? "REDACTED_ROOT/.config/opencode/tg-bots.json"
const BRIDGE_SRC = "REDACTED_ROOT/.opencode/v2lib/tg-bridge.ts"
const V2LIB_DIR = "REDACTED_ROOT/.opencode/v2lib"
/** 快照根目录：必须在项目树内，裸包（@opencode-ai/*）靠向上找 node_modules 解析。 */
const LIVE_ROOT = "REDACTED_ROOT/.opencode/.v2lib-live"

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
    for (let attempt = 0; attempt < 2; attempt++) {
      const probe = `${V2LIB_DIR}/tg-bridge.ts`
      const before = statSync(probe).mtimeMs
      cpSync(V2LIB_DIR, dir, { recursive: true })
      // 撕裂快照检查：复制期间源文件被改 → 这份快照半新半旧，删掉重来
      if (before === statSync(probe).mtimeMs) break
      rmSync(dir, { recursive: true, force: true })
    }
    gcLive(tag, name)
    return dir
  } catch (err) {
    diag(`[tg-bridge] snapshot failed, fallback to live tree: ${String(err).slice(0, 160)}`)
    return V2LIB_DIR
  }
}
const COMPAT_SRC = "REDACTED_ROOT/.opencode/v2lib/_v2compat.ts"

type BotSpec = {
  id: string
  label?: string
  envFile?: string
  fallbackEnvFile?: string
  noFallback?: boolean
  pushChat?: string
}

const readRegistry = (): BotSpec[] => {
  try {
    const j = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as any
    const arr = Array.isArray(j?.bots) ? j.bots : []
    const out: BotSpec[] = []
    for (const b of arr) {
      const id = String(b?.id ?? "").trim()
      if (!id || !/^[a-z0-9_-]{1,24}$/i.test(id)) continue
      if (out.some((x) => x.id === id)) continue
      out.push({
        id,
        label: typeof b?.label === "string" ? b.label : undefined,
        envFile: typeof b?.envFile === "string" && b.envFile ? b.envFile : undefined,
        fallbackEnvFile: typeof b?.fallbackEnvFile === "string" && b.fallbackEnvFile ? b.fallbackEnvFile : undefined,
        noFallback: b?.noFallback === true,
        pushChat: typeof b?.pushChat === "string" && b.pushChat ? b.pushChat : undefined,
      })
    }
    if (out.length > 0) return out
  } catch {
    /* 无注册表：退回单实例默认行为 */
  }
  return [{ id: "primary" }]
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

const bots = readRegistry()
const primarySpec = bots[0] ?? { id: "primary" }
const primaryEnv = readEnvFile(primarySpec.envFile ?? "REDACTED_ROOT/.config/opencode/tg.env")

/** 主实例当前目标（给新实例做起始 front；只读，不修改主实例状态） */
const readPrimaryFront = (): string | undefined => {
  try {
    const j = JSON.parse(readFileSync("REDACTED_ROOT/.config/opencode/tg-chats.json", "utf8")) as any
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
    // 首个 Bot 沿用历史代号 __tgBridgeGen：这样它能接管（判过期）升级前遗留的旧实例，
    // 否则新旧实例会并存抢同一个 token → getUpdates 409 风暴。
    genKey: index === 0 ? undefined : `__tgBridgeGen_${bot.id}`,
    // 首个 Bot 沿用历史状态文件：auto-continue 的循环作用域读的是 tg-chats.json，
    // 换路径会让“当前循环会话”与桥接脱节。
    statePath: index === 0 ? "REDACTED_ROOT/.config/opencode/tg-chats.json" : `REDACTED_ROOT/.config/opencode/tg-chats${sfx}.json`,
    // 首个 Bot 沿用历史 owner 文件名：既让既有租约检查/AC 写入指向同一处，
    // 也保证换代时旧实例的租约能被直接接管。
    ownerPath: index === 0 ? "/tmp/opencode/tg-poll-owner.json" : `/tmp/opencode/tg-poll-owner${sfx}.json`,
    commandCachePath: `/tmp/opencode/tg-command-cache${sfx}.json`,
    stripStatePath: `/tmp/opencode/strip-run${sfx}.json`,
    stripFailPath: `/tmp/opencode/stripfail${sfx}.json`,
    tapPath: `/tmp/opencode/tg${sfx}.log`,
    configPath: bot.envFile ?? "REDACTED_ROOT/.config/opencode/tg.env",
    fallbackEnvPath: bot.noFallback ? null : bot.fallbackEnvFile ?? null,
    token,
    // 新实例没有自己的 front 时继承主实例当前目标（之后各自独立）
    initialFront: index === 0 ? undefined : readPrimaryFront(),
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
    const disposers: Array<(() => void) | void> = []
    const version = srcVersion()
    // 一次 setup 快照一份，三个 Bot 共用；仍按 ?bot= 分成三个模块实例（见上方注释）。
    const live = snapshotV2lib("bridge")
    // 不带 query：与 v2lib 内部 "./_v2compat" 同一 URL，避免 _v2compat 出现两个实例
    // （它有模块级 Map/Set/db 句柄，劈成两半会让 token 统计与 db 缓存各算各的）。
    const { v2Bridge } = (await import(`${live}/_v2compat.ts`)) as { v2Bridge: (...a: any[]) => any }
    for (const [idx, bot] of bots.entries()) {
      try {
        const mod: any = await import(`${live}/tg-bridge.ts?bot=${bot.id}&v=${version}`)
        const configure = mod?.configureBot ?? mod?.default?.configureBot
        const factory = mod?.TgBridgePlugin ?? mod?.default?.TgBridgePlugin
        if (typeof factory !== "function" || typeof configure !== "function") {
          diag(`[tg-bridge:${bot.id}] module missing TgBridgePlugin/configureBot (keys=${Object.keys(mod ?? {}).join(",").slice(0, 200)})`)
          continue
        }
        const cfg: any = botConfig(bot, idx)
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

// reload probe 1790358718

// reload 1790360218

// reload 1790360322

// reload 1790360563

// reload 1790360747

// reload 1790360819

// reload 1790361047

// reload 1790361385

// reload 1790361547

// reload 1790361681

// reload 1790361850

// reload 1790361985

// reload 1790362067

// reload 1790362222

// reload 1790363036

// reload 1790363311

// reload 1790363701

// reload 1790363768

// reload(content) 1790411999 R1484 revert shell tool override (kills builtin shell; do not modify requests to provider)

// reload(content) 1790412205 R1485 remove stale shell override from plugin tool registry

// reload(content) 1790412600 R1487 FULL REVERT: no ctx.tool add/remove/transform, no Hooks.tool.shell (restore builtin shell + provider request untouched)

// reload(content) 1790388715

// reload(content) 1790388902

// reload(content) 1790389071

// reload(content) 1790389283

// reload(content) 1790389407

// reload(content) 1790389542

// reload(content) 1790389720

// reload(content) 1790389841

// reload(content) 1790389986

// reload(content) 1790390378

// reload(content) 1790390653

// reload(content) 1790390748

// reload(content) 1790390937

// reload(content) 1790391040

// reload(content) 1790391147

// reload(content) 1790391274

// reload(content) 1790391656

// reload(content) 1790391749

// reload(content) 1790392014

// reload(content) 1790392119

// reload(content) 1790394283

// reload(content) 1790394383

// reload(content) 1790394560

// reload(content) 1790394769

// reload(content) 1790401359

// reload(content) 1790401486

// reload(content) 1790401610

// reload(content) 1790401848

// reload(content) 1790402009

// reload(content) 1790402814

// reload(content) 1790403181

// reload(content) 1790403347

// reload(content) 1790403820

// reload(content) 1790404032

// reload(content) 1790404317

// reload(content) 1790405048

// reload(content) 1790405380

// reload(content) 1790405756

// reload(content) 1790405901

// reload(content) 1790407186

// reload(content) 1790407304

// reload(content) 1790407448

// reload(content) 1790407929

// reload(content) 1790408029

// reload(content) 1790408651

// reload(content) 1790409060

// reload(content) 1790409836

// reload(content) 1790410263

// reload(content) 1790410451

// reload(content) 1790410743

// reload(content) 1790410852

// reload(content) 1790411278

// reload(content) 1790411955

// reload(content) 1790412526

// reload(content) 1790413230

// reload(content) 1790413349

// reload(content) 1790413902

// reload(content) 1790414108

// reload(content) 1790415113

// reload(content) 1790415265

// reload(content) 1790415462

// reload(content) 1790415696

// reload(content) 1790415932

// reload(content) 1790416267

// reload(content) 1790416533

// reload(content) 1790416909

// reload(content) 1790417105

// reload(content) 1790417282

// reload(content) 1790417484

// reload(content) 1790417909

// reload(content) 1790418280

// reload(content) 1790418450

// reload(content) 1790419015

// reload(content) 1790419397

// reload(content) 1790419930

// reload(content) 1790420077

// reload(content) 1790420358

// reload(content) 1790421346

// reload(content) 1790421587

// reload(content) 1790422196

// reload(content) 1790422519

// reload(content) verify1

// reload(content) verify2

// reload(content) 1790426631

// reload(content) 1790426934

// reload(content) 1790427313

// reload(content) 1790427579

// reload(content) 1790427823

// reload(content) 1790428284

// reload(content) 1790428639

// reload(content) 1790428913

// reload(content) 1790429363

// reload(content) 1790429539

// reload(content) 1790429945

// reload(content) 1790430754

// reload(content) 1790431189

// reload(content) 20260926T140944Z [tg-bridge-v2.ts]

// reload(content) 20260926T144426Z [tg-bridge-v2.ts]

// reload(content) 20260926T144932Z [tg-bridge-v2.ts]

// reload(content) 20260926T145350Z [tg-bridge-v2.ts]

// reload(content) 20260926T145929Z [tg-bridge-v2.ts]

// reload(content) 20260926T150425Z [tg-bridge-v2.ts]

// reload(content) 20260926T150658Z [tg-bridge-v2.ts]

// reload(content) 20260926T152555Z [tg-bridge-v2.ts]

// reload(content) 20260926T152638Z [tg-bridge-v2.ts]

// reload(content) 20260926T153624Z [tg-bridge-v2.ts]

// reload(content) 20260926T153857Z [tg-bridge-v2.ts]

// reload(content) 20260926T154040Z [tg-bridge-v2.ts]

// reload(content) 20260926T154533Z [tg-bridge-v2.ts]

// reload(content) 20260926T155326Z [tg-bridge-v2.ts]

// reload(content) 20260926T155915Z [tg-bridge-v2.ts]

// reload(content) 20260926T160736Z [tg-bridge-v2.ts]

// reload(content) 20260926T161050Z [tg-bridge-v2.ts]

// reload(content) 20260926T161421Z [tg-bridge-v2.ts]

// reload(content) 20260926T161756Z [tg-bridge-v2.ts]

// reload(content) 20260926T162443Z [tg-bridge-v2.ts]

// reload(content) 20260926T162844Z [tg-bridge-v2.ts]

// reload(content) 20260926T163453Z [tg-bridge-v2.ts]

// reload(content) 20260926T164117Z [tg-bridge-v2.ts]

// reload(content) 20260926T164729Z [tg-bridge-v2.ts]

// reload(content) 20260926T165941Z [tg-bridge-v2.ts]

// reload(content) 20260926T170341Z [tg-bridge-v2.ts]

// reload(content) 20260926T170528Z [tg-bridge-v2.ts]

// reload(content) 20260926T170703Z [tg-bridge-v2.ts]

// reload(content) 20260926T171254Z [tg-bridge-v2.ts]

// reload(content) 20260926T171415Z [tg-bridge-v2.ts]

// reload(content) 20260926T172129Z [tg-bridge-v2.ts]

// reload(content) 20260926T172837Z [tg-bridge-v2.ts]

// reload(content) 20260926T172958Z [tg-bridge-v2.ts]

// reload(content) 20260926T173801Z [tg-bridge-v2.ts]

// reload(content) 20260926T174100Z [tg-bridge-v2.ts]

// reload(content) 20260926T174620Z [tg-bridge-v2.ts]

// reload(content) 20260926T181036Z [tg-bridge-v2.ts]

// reload(content) 20260926T182106Z [tg-bridge-v2.ts]

// reload(content) 20260926T182839Z [tg-bridge-v2.ts]

// reload(content) 20260926T183458Z [tg-bridge-v2.ts]

// reload(content) 20260926T185553Z [tg-bridge-v2.ts]

// reload(content) 20260927T014319Z [tg-bridge-v2.ts]

// addbot reload 2026-09-27T01:48:23.459Z

// reload(content) 20260927T020020Z [tg-bridge-v2.ts]

// reload(content) 20260927T020129Z [tg-bridge-v2.ts]

// reload(content) 20260927T021852Z [tg-bridge-v2.ts]

// reload(content) 20260927T023037Z [tg-bridge-v2.ts]

// reload(content) 20260927T024323Z [tg-bridge-v2.ts]

// reload(content) 20260927T032111Z [tg-bridge-v2.ts]

// reload(content) 20260927T032718Z [tg-bridge-v2.ts]

// reload(content) 20260927T033250Z [tg-bridge-v2.ts]

// reload(content) 20260927T033619Z [tg-bridge-v2.ts]

// reload(content) 20260927T034158Z [tg-bridge-v2.ts]

// reload(content) 20260927T034726Z [tg-bridge-v2.ts]

// reload(content) 20260927T040320Z [tg-bridge-v2.ts]

// reload(content) 20260927T045722Z [tg-bridge-v2.ts]

// reload(content) 20260927T051841Z [tg-bridge-v2.ts]

// reload(content) 20260927T054815Z [tg-bridge-v2.ts]

// reload(content) 20260927T060922Z [tg-bridge-v2.ts]

// reload(content) 20260928T015159Z [tg-bridge-v2.ts]

// reload(content) 20260928T015315Z [tg-bridge-v2.ts]

// reload(content) 20260928T015534Z [tg-bridge-v2.ts]

// reload(content) 20260928T023343Z [tg-bridge-v2.ts]

// reload(content) 20260928T024546Z [tg-bridge-v2.ts]

// reload(content) 20260928T030022Z [tg-bridge-v2.ts]

// reload(content) 20260928T031244Z [tg-bridge-v2.ts]

// reload(content) 20260928T041439Z [tg-bridge-v2.ts]

// reload(content) 20260928T042259Z [tg-bridge-v2.ts]

// reload(content) 20260928T052142Z [tg-bridge-v2.ts]

// reload(content) 20260928T072128Z [tg-bridge-v2.ts]
// 2026-09-28T18:04:43Z addbot reload R1445 sentHash-key-bound (R1444 手写漏了 // 前缀 → 语法错误 → 整个插件加载失败；已修复)

// reload(content) 20260928T100742Z [tg-bridge-v2.ts]

// reload(content) 20260928T110948Z [tg-bridge-v2.ts]

// reload(content) 20260928T114015Z [tg-bridge-v2.ts]

// reload(content) 20260928T114424Z [tg-bridge-v2.ts]

// reload(content) 20260928T114525Z [tg-bridge-v2.ts]

// reload(content) 20260928T114623Z [tg-bridge-v2.ts]

// reload(content) 20260928T114959Z [tg-bridge-v2.ts]

// reload(content) 20260928T120637Z [tg-bridge-v2.ts]

// reload(content) 20260928T123646Z [tg-bridge-v2.ts]

// reload(content) 20260928T124415Z [tg-bridge-v2.ts]

// reload(content) 20260928T131633Z [tg-bridge-v2.ts]

// reload(content) 20260928T131854Z [tg-bridge-v2.ts]
