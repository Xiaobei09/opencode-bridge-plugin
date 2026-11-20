/**
 * R2686：跨模块共享的**状态路径 + JSON IO + 会话 ID 原语**。
 *
 * 背景（运营者：「代码的复用情况如何，精简，整理，优化，模块融合，分模块化设计」）：
 * 这些定义此前在 auto-continue / resume-once / quota-recover / quota-tail-marker /
 * tg-bridge / _v2compat / bg-mode / loop-guard 各写一份：
 *   · `PRIVATE_FILE_MODE = 0o600` —— 5 份；
 *   · `readJson()` 容错读取 —— 2 份完全同义；
 *   · `readCtl()`（loop-ctl 主路径 + /tmp 旧路径回落）—— 2 份；
 *   · `SID_RE` / `isSessionID()` —— 3 份；
 *   · `loop-ctl.json` / `tg-chats.json` 路径 —— 3 份。
 * 复制本身不会立刻出错，但一旦权限、路径或容错口径需要调整，就会漂移成
 * “一边读得到、另一边读不到”的静默故障（R1849 的原子写问题就是同一族）。
 *
 * 本模块只依赖 Node 内置模块，是 v2lib 的**最底层共享核**：
 *   time-format.ts（纯格式化）与 state-io.ts（纯状态 IO）都不 import 任何业务模块，
 *   业务模块只向下依赖它们，形成无环分层。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** 状态/配置文件统一权限：public CI 环境里避免同机其它用户读取 token 或会话状态。 */
export const PRIVATE_FILE_MODE = 0o600

export const HOME = process.env.HOME ?? "/root"
export const STATE_DIR = `${HOME}/.config/opencode`
/** 自动循环总闸：跨 Bot 共享（全局闸 + 每 Bot 的 sids 都在同一个文件里）。 */
export const LOOP_CTL_PATH = `${STATE_DIR}/loop-ctl.json`
/** 旧版临时路径：只读回落，兼容热重载/旧进程尚未迁移的窗口。 */
export const LOOP_CTL_LEGACY = "/tmp/opencode/loop-ctl.json"
/** 主 Bot 状态文件；备用 Bot 由 AC_TG_STATE_PATH 指到各自文件。 */
export const TG_STATE_PATH = process.env.AC_TG_STATE_PATH ?? `${STATE_DIR}/tg-chats.json`

/** 宿主会话 ID 的唯一合法形状。 */
export const SID_RE = /^ses_[A-Za-z0-9_-]+$/
export const isSessionID = (v: unknown): v is string => typeof v === "string" && SID_RE.test(v)

/**
 * R2777：会话名单落盘时的截断原语（去重 + 可选保留最近 N 条）。
 *
 * **正向粘性名单可以截断，`/loop off` 的否定名单绝不能截断。**
 * 2026-11-18 实报：bot6 前台会话在否定名单第 1 条（数组头部）；另一个会话 429 fork
 * 把旧 ID 追加成第 17 条，旧实现共用 `.slice(-16)` 把第 1 条挤掉。下一轮
 * auto-continue 按「front/pinned 默认入循环」重新拉起该会话 —— 用户从未点过
 * `/loop start`，却自己开始了自动循环。否定是安全边界，只能由显式
 * `/loop on` /「继续循环」删除，不能因容量策略静默失效。
 *
 * cap <= 0 表示不截断（用于否定名单）。
 */
export const capIdList = (ids: Iterable<string>, cap: number): string[] => {
  const all = [...new Set(ids)]
  return cap > 0 ? all.slice(-cap) : all
}

/** 容错读 JSON：文件缺失、半截写、权限错误都按“没有该状态”处理（绝不抛）。 */
export const readJson = <T = any>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

/**
 * 原子写 JSON：tmp（pid 后缀）+ rename。
 *
 * 这些状态文件被多个 Bot 的 tg-bridge / auto-continue / resume-once 同时读写。
 * 裸 `writeFileSync` 先 O_TRUNC 再写，读者落在窗口内会 parse 失败 → 被容错读
 * 当成“没有登记/没有停止” → fail-open（该停的循环没停、该保留的标记丢了）。
 * rename 让读者只见旧版或新版。
 *
 * R2686：从 auto-continue 上移为共享实现；顺带补 mkdir，调用方不必各自准备目录。
 */
export const atomicWriteJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify(value), { encoding: "utf8", mode: PRIVATE_FILE_MODE })
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* best-effort */
    }
    throw err
  }
}

/** 读自动循环总闸：主路径损坏/缺失时回落旧路径；都读不到返回空对象。 */
export const readLoopCtl = (): any => {
  for (const p of [LOOP_CTL_PATH, LOOP_CTL_LEGACY]) {
    const j = readJson(p)
    if (j && typeof j === "object") return j
  }
  return {}
}

/**
 * R2776：把一次「单 Bot 停止」合并进 loop-ctl 快照（原地改 `ctl` 并返回）。
 *
 * 只动 `bots[botId]`，**绝不触碰顶层 `stopped`**：顶层是 `/loop stop all` 与守卫的
 * 全局硬闸。2026-11-17 审计发现两处 per-Bot 停止路径都顺手写了 `stopped=false`
 *（注释还写着「全局闸不动」）→ 用户停一个 Bot 就会静默解除全局停闸，其它 Bot 在
 * 下一拍复活。这正是「循环掉锁」的一类。
 *
 * 条目里已有的 `sids` 原样保留（由桥的 syncLoopCtlSids 绑定当前 front）；
 * 其它 Bot 的条目也不动。
 */
export const mergeBotStop = (ctl: any, botId: string, by: string, reason: string, ts: number): any => {
  const j = ctl && typeof ctl === "object" ? ctl : {}
  const bots = j.bots && typeof j.bots === "object" ? { ...j.bots } : {}
  const prev = bots[botId] && typeof bots[botId] === "object" ? bots[botId] : {}
  bots[botId] = { ...prev, stopped: true, by, reason: String(reason ?? "").slice(0, 200), ts }
  j.bots = bots
  return j
}
