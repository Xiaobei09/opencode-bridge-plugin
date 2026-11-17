// R2729：运营者澄清「不是全局，是 bot 单独设置，设置本 bot 推不推」。
// 每个 Bot 有自己的开关，控制**这个 Bot**是否：
//   ON  = 注入卡每 60s 校验真实置顶，丢失时重钉/必要时重建；并可作为配额 429
//         通知的发送方。
//   OFF = 不再自动重钉/重建；429 通知也不选它作为发送方。
// 在哪个 Bot 的聊天里切换，就只改哪个 Bot，其它 Bot 的设置不受影响。
// 设置落盘到 $HOME/.config/opencode/card-ops.json（跨 CI 随环境快照保存），
// CI 的 tg-notify.sh 读同一份文件，按候选 Bot 各自的开关决定能不能推。
import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs"

export type CardOpsState = {
  /** 本 Bot 的开关：true=自愈+可作为 429 发送方；false=两项都不做。 */
  enabled: boolean
  /** 429 通知在无法判断“最近使用的 Bot”时的固定回退（内部 id，默认 bot6）。 */
  notifyBot: string
  updatedAt: number
  /** 最近一次切换来自哪个 Bot（诊断用，不参与判断）。 */
  by: string
}

type CardOpsEntry = {
  enabled?: boolean
  updatedAt?: number
  by?: string
}

type CardOpsFile = {
  /** R2729：每个 Bot 独立设置；缺失的 Bot 使用 legacy enabled 或默认开。 */
  bots?: Record<string, CardOpsEntry>
  /** R2728 旧格式的全局开关；仅作为没有 per-bot 条目时的兼容默认。 */
  enabled?: boolean
  notifyBot?: string
  updatedAt?: number
  by?: string
}

export const CARD_OPS_DEFAULT_ENABLED = true
export const CARD_OPS_DEFAULT_NOTIFY_BOT = "bot6"
export const CARD_OPS_PATH_BASENAME = "card-ops.json"

/** 运行期配置目录；测试可通过 HOME / OPENCODE_CONFIG_DIR 隔离。 */
export const cardOpsDir = (): string =>
  process.env.OPENCODE_CONFIG_DIR?.trim() ||
  `${process.env.HOME?.trim() || "/root"}/.config/opencode`

export const cardOpsPath = (): string => `${cardOpsDir()}/${CARD_OPS_PATH_BASENAME}`

const normalizeBot = (v: unknown): string => {
  const s = String(v ?? "").trim()
  return /^[A-Za-z0-9_-]{1,32}$/.test(s) ? s : CARD_OPS_DEFAULT_NOTIFY_BOT
}

/** Bot id 只接受安全字符；非法 id 不匹配任何 per-bot 条目，回落到默认开。 */
const botKey = (v: unknown): string => {
  const s = String(v ?? "").trim()
  return /^[A-Za-z0-9_-]{1,32}$/.test(s) ? s : ""
}

const readFileState = (): CardOpsFile => {
  try {
    const j = JSON.parse(readFileSync(cardOpsPath(), "utf8")) as any
    return j && typeof j === "object" ? (j as CardOpsFile) : {}
  } catch {
    return {}
  }
}

/**
 * 读**指定 Bot** 的开关。文件缺失/损坏/没有该 Bot 条目时一律按默认 ON：
 * 默认关会让刚部署的自愈静默失效，运营者只会再次遇到“卡面说已置顶、实际没置顶”。
 * R2728 旧文件只有全局 `enabled`，此时把它当作所有未单独设置 Bot 的兼容默认。
 */
export const readCardOps = (bot: string): CardOpsState => {
  const j = readFileState()
  const key = botKey(bot)
  const per = key && j.bots && typeof j.bots === "object" ? j.bots[key] : undefined
  const fallback = j.enabled === false ? false : CARD_OPS_DEFAULT_ENABLED
  return {
    enabled: typeof per?.enabled === "boolean" ? per.enabled : fallback,
    notifyBot: normalizeBot(j.notifyBot),
    updatedAt: Number(per?.updatedAt) > 0 ? Number(per.updatedAt) : Number(j.updatedAt) > 0 ? Number(j.updatedAt) : 0,
    by: typeof per?.by === "string" ? per.by.slice(0, 32) : typeof j.by === "string" ? j.by.slice(0, 32) : "",
  }
}

/**
 * 写**指定 Bot** 的开关（原子替换）：CI 的 tg-notify.sh 可能在同一秒读文件，
 * 不能让它看到一个被截断的 JSON。保留其它 Bot 的条目和 notifyBot 字段。
 * 旧格式的全局 `enabled` 保留原值，作为其它未单独设置 Bot 的兼容默认。
 */
export const writeCardOps = (bot: string, enabled: boolean, by: string): CardOpsState => {
  const prev = readFileState()
  const key = botKey(bot)
  const now = Date.now()
  const st: CardOpsState = {
    enabled: Boolean(enabled),
    notifyBot: normalizeBot(prev.notifyBot),
    updatedAt: now,
    by: String(by ?? "").slice(0, 32),
  }
  if (!key) return st
  try {
    const path = cardOpsPath()
    const out: CardOpsFile = { ...(prev as any) }
    out.bots = { ...(prev.bots && typeof prev.bots === "object" ? prev.bots : {}) }
    out.bots[key] = { enabled: st.enabled, updatedAt: now, by: st.by }
    out.notifyBot = st.notifyBot
    out.updatedAt = now
    out.by = st.by
    mkdirSync(cardOpsDir(), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 })
    try {
      chmodSync(tmp, 0o600)
    } catch {
      /* best-effort：文件系统不支持权限位时仍要写成功 */
    }
    renameSync(tmp, path)
  } catch {
    /* 菜单切换失败时下一次仍读到旧值；调用方用 reply 告诉运营者 */
  }
  return st
}

export const cardOpsLabel = (enabled: boolean): string => (enabled ? "开" : "关")

/**
 * R2730：`/cardops` 回复里的「各 Bot」一览。运营者改的是本 Bot，需要一眼确认
 * 其它 Bot 没被连带改掉；因此并排显示每个已注册 Bot 的开关，并标出当前聊天
 * 所属的 Bot。id 由调用方负责 HTML 转义（注册表内容不可信）。
 */
export const formatCardOpsOverview = (
  entries: Array<{ id: string; enabled: boolean }>,
  current: string,
): string =>
  entries
    .map(({ id, enabled }) => `${id === current ? `<b>${id}（本 Bot）</b>` : id}：${enabled ? "开" : "关"}`)
    .join(" · ")

/** 菜单/命令共用的说明文案，避免两处各写一份口径。 */
export const CARD_OPS_HELP = [
  "开启（本 Bot）：注入卡每 60s 校验真实置顶，丢失时重钉；旧卡超过 24h 仍钉不上会重建一张。",
  "开启（本 Bot）：可被选为配额 429 通知的发送方；路由优先最近使用的 Bot（无记录用 bot6，失败回退主 Bot）。",
  "关闭（本 Bot）：不再自动重钉/重建，也不会被选为 429 通知发送方；其它 Bot 的设置不变。",
  "每个 Bot 单独设置：在哪个 Bot 的聊天里切换，就只改哪个 Bot。",
].join("\n")
