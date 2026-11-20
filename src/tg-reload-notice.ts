// R2708（运营者：「能不能做自动热重载提示」）：热重载检测与提示文案的纯状态机。
//
// 目标：插件热重载完成后，自动在对应 chat 发一条短提示（版本 + 本次重载的 Bot），
// 不再需要人工去 grep `/tmp/opencode/v2plugin.log` 里的 `plugin loaded`。
//
// 为什么需要模块级检测：热重载会**重新求值**本模块（快照目录每次不同），普通模块变量
// 全部重置；只有 `globalThis` 跨重载存活。桥在每个 Bot 的初始化处登记
// `{pid, ver, at}`：
//   · 首次登记（globalThis 无记录 / 换了进程）→ 冷启动，不提示；
//   · 同进程再次登记 → 热重载，标记为 hot。
// 多个 Bot 通常在几百毫秒内一起重载，且可能共用一个 chat —— 按 **chat** 去重，
// 每个 chat 只发一条，文案里列出本次重载的全部 Bot，避免三连刷屏。
// R2865：Telegram 私聊的 chat.id 是用户 id，所有 Bot 的私聊共用同一个正数 id，
// 但它们是不同的聊天窗口；私聊改为按 **chat+Bot** 去重（每个 Bot 各发一条），
// 只有群/频道仍按 chat 去重。
//
// 边界：不碰 I/O、不记日志、不发送；只读写调用方传入的 store（globalThis），
// 文案时间由调用方注入 fmtTime（与其它模块一致，TG_TZ 单一真源）。

export type ReloadStore = Record<string, unknown>
export type LoadMark = { pid: number; ver: string; at: number }

const markKey = (botId: string): string => `__tgBridgeLoadMark:${botId}`
const HOT_KEY = "__tgBridgeReloadHot"
const CLAIM_KEY = "__tgBridgeReloadNoticeClaim"

/** 同一次重载里，多个 Bot 的加载时间差容忍窗口（也用于裁剪 hot 记录）。 */
export const RELOAD_HOT_WINDOW_MS = 30_000
/** 同一 chat 的提示最小间隔：覆盖多 Bot 串行加载 + 一次编辑里的多次重载。
 *  R2831（运营者：「桥大量快速重复的热重载」）：从 15s 提高到 120s，
 *  避免连续保存代码时同一条「桥已热重载」在几分钟内刷屏。 */
export const RELOAD_NOTICE_GAP_MS = 120_000

/**
 * R2865（运营者：「桥的重启消息也很久没有发了」）：Telegram **私聊**的 chat.id
 * 就是用户 id，所有 Bot 与同一个用户的私聊都拿到同一个正数 id，但它们是**不同
 * 的聊天窗口**。R2708/R2834 按 chat 去重时把 primary/bot5/bot6 当成同一个 chat，
 * 只有最先加载的 Bot 发提示，运营者正在用的 Bot6 窗口永远收不到。
 *
 * 判据：正数纯数字 = 私聊（每个 Bot 各自发送）；负数 = 群/频道（共用同一窗口，
 * 仍按 chat 去重）；用户名/未知形式按共享 chat 处理，宁可少一条也不刷屏。
 */
export const isPrivateChatID = (chat: string): boolean => /^[1-9]\d*$/.test(chat)

/**
 * 热重载提示的认领键。私聊把 Bot 纳入键，让每个 Bot 在自己的窗口各发一条；
 * 群聊仍只用 chat，避免三个 Bot 在同一群里刷三条相同提示。
 */
export const reloadNoticeClaimKey = (chat: string, botId: string): string =>
  isPrivateChatID(chat) ? `${chat}:${botId}` : chat

/**
 * 登记一次插件加载。返回 `hot=true` 表示同一进程里该 Bot 之前已加载过（热重载）。
 * `previousVer` 用于日志对照（本次改动前后版本是否真的变了）。
 */
export const registerBridgeLoad = (
  store: ReloadStore,
  botId: string,
  ver: string,
  now: number,
  pid: number,
): { hot: boolean; previousVer?: string } => {
  const key = markKey(botId)
  const prev = store[key] as LoadMark | undefined
  const hot = Boolean(prev && prev.pid === pid)
  store[key] = { pid, ver, at: now } satisfies LoadMark
  if (hot) {
    const hotMap = { ...((store[HOT_KEY] as Record<string, number> | undefined) ?? {}) }
    for (const k of Object.keys(hotMap)) if (now - hotMap[k] > RELOAD_HOT_WINDOW_MS) delete hotMap[k]
    hotMap[botId] = now
    store[HOT_KEY] = hotMap
  }
  return { hot, previousVer: prev?.ver }
}

/** 本次重载窗口内已登记的 Bot（按名字排序，文案稳定可断言）。 */
export const reloadBots = (store: ReloadStore, now: number): string[] => {
  const hotMap = (store[HOT_KEY] as Record<string, number> | undefined) ?? {}
  return Object.keys(hotMap)
    .filter((k) => now - (hotMap[k] ?? 0) <= RELOAD_HOT_WINDOW_MS)
    .sort()
}

/**
 * 按 chat 认领提示发送权：同一 chat 在 `gapMs` 内只有第一个调用者返回 true。
 * 用 chat 而不是全局，是因为不同 Bot 可能服务不同 chat；共用 chat 时自动去重。
 */
export const claimReloadNotice = (
  store: ReloadStore,
  chat: string,
  now: number,
  gapMs: number = RELOAD_NOTICE_GAP_MS,
): boolean => {
  const claim = { ...((store[CLAIM_KEY] as Record<string, number> | undefined) ?? {}) }
  for (const k of Object.keys(claim)) if (now - claim[k] > gapMs * 4) delete claim[k]
  const last = claim[chat] ?? 0
  if (last > 0 && now - last < gapMs) return false
  claim[chat] = now
  store[CLAIM_KEY] = claim
  return true
}

/**
 * 热重载提示文案（纯渲染；时间格式由桥注入）。
 * R2740：四行字段式卡片收成一行——版本、Bot、时间本来就是同一次事件的三元组。
 */
export const reloadNoticeText = (args: {
  ver: string
  bots: string[]
  at: number
  fmtTime: (ms: number) => string
}): string =>
  `🔄 桥已热重载 · ${args.ver} · ${args.bots.length > 0 ? args.bots.join("、") : "?"} · ${args.fmtTime(args.at) || "?"}`
