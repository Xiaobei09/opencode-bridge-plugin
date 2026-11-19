/**
 * R2688（运营者：「分模块化设计…不改表现」）：跨 Bot 429 限流标记（bot-flood.json）。
 *
 * 为什么必须由**别的** Bot 来说：硬限流期间本 Bot 一条消息都发不出去（Telegram 限的是
 * 整个 Bot，不只是某个方法），本地闸门一开就把全部出站请求挡下 —— 让被限流者自己提示
 * 用户是结构性做不到的，硬发也只是进队列一起等。可行形态只有：谁被限流 → 写共享标记；
 * **其他实例**读到后各自替它发一条（一条/Bot/每次限流，去重）。
 *
 * 为什么单独一个文件而不是塞进 loop-ctl.json：那是**自动循环总闸**（auto-continue 也在
 * 读写），把 15s 一拍的瞬时限流状态混进去等于让热路径污染总闸；且标记写失败只应损失
 * “提醒”这个增值功能，绝不能连累总闸。独立文件 + 原子写，失败即忽略（best-effort）。
 *
 * 本模块只做**共享标记**的读写与纯合并；实例内的 flood gate / 429 streak 仍归桥的
 * 组合根（它们是进程内运行态，跨进程事实源永远是这份文件）。
 */
import { atomicWriteJson, readJson, STATE_DIR } from "./state-io"

export const FLOOD_FLAG_PATH = `${STATE_DIR}/bot-flood.json`

export type FloodFlagEntry = { since: number; until: number }
export type FloodFlagDisk = Record<string, FloodFlagEntry | undefined>

// 纯函数：把「本 Bot 进入/续期限流」合并进磁盘快照。
//   · until 取 max —— 与 rename429 的合并同一并发口径：read-modify-write 的两个进程
//     不会互相把冷却改短；
//   · 已过期条目（until <= now）就地丢弃 —— 否则“上次限流的残留”会让 since 永远续不上
//     新一轮的起点，提醒文案里的“已持续多久”就错了；
//   · 同一次限流续期**保留原 since** —— 用户要看到的是“从几点起被限流”，续期不能重置起点。
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

// 不存在 / 损坏：按空快照处理（下次写盘即重建）。只返回 floods 字段，与旧格式兼容。
export const readFloodFlagDisk = (): FloodFlagDisk => {
  const j = readJson(FLOOD_FLAG_PATH) as { floods?: unknown } | null
  if (j && typeof j === "object" && j.floods && typeof j.floods === "object") return j.floods as FloodFlagDisk
  return {}
}

const writeFloodFlagDisk = (floods: FloodFlagDisk): void => {
  atomicWriteJson(FLOOD_FLAG_PATH, { floods })
}

// 进入（或续期）限流时调用。任何异常都吞掉：提醒功能绝不能影响发送路径。
export const markSelfFlooded = (bot: string, until: number, now = Date.now()): void => {
  try {
    writeFloodFlagDisk(mergeFloodFlag(readFloodFlagDisk(), bot, now, until))
  } catch {
    /* best-effort */
  }
}

// 恢复后调用：清掉自己的条目（其他实例不再把它算作“限流中”）。
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
