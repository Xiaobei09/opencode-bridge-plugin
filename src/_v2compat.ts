import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { makeBgWatch } from "./bg-watch"
import { readBg } from "./bg-mode"

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

// R1917：测试隔离 —— `bun test` 会把 NODE_ENV 置为 "test"，而 menu-root /
// proto-silent-baseline 两个测试会 import tg-bridge → 本模块。此前 TAP_PATH 写死生产
// 路径，于是**跑一次测试就往生产日志里塞一行 `[v2compat] error: bundb unavailable`**
// （测试进程打不开 DB 属正常），事后扫描会把这条测试噪声误判成线上故障
// （R127/R133 已实际发生过这种误读）。故：显式 env 覆盖优先，其次测试环境改走独立
// 测试路径，生产（NODE_ENV 未设置）保持原路径不变。
const TEST_TAP_PATH = "/tmp/opencode/v2plugin.test.log"
const TEST_ARCHIVE_DIR = "/tmp/opencode/log-archive-test"
export const TAP_PATH = process.env.AC_TAP_PATH ?? (process.env.NODE_ENV === "test" ? TEST_TAP_PATH : "/tmp/opencode/v2plugin.log")
const TAP_MAX = 2000000
/** R1736：轮转时把被丢弃的部分 gzip 存这里（不丢证据）。R1735 已手工验证过这条路可行。 */
export const LOG_ARCHIVE_DIR =
  process.env.AC_LOG_ARCHIVE_DIR ?? (process.env.NODE_ENV === "test" ? TEST_ARCHIVE_DIR : "REDACTED_ROOT/.opencode/log-archive")
const PRIVATE_FILE_MODE = 0o600
// 插件日志含会话 ID、chat ID 与工具摘要；启动时修复旧文件权限，重建时沿用 0600。
try {
  chmodSync(TAP_PATH, PRIVATE_FILE_MODE)
} catch {
  /* file may not exist yet; creation below uses mode 0600 */
}
/**
 * R1736：日志轮转 —— **保留的部分照旧，但被丢弃的部分改为 gzip 归档**。
 *
 * 为什么改（不是降噪，而是归档）：
 *   原实现超限后 `data.slice(0.75)` → **前 75% 直接蒸发**。实测增速 ~10.5 KB/min、
 *   上限 2 MB → 每 1–2.4 小时丢一次历史。于是 2026-10-01 02:37 那次"静默 30 分钟"
 *   的证据，会被**我自己的日志策略**在约 1 小时后销毁 —— 而事后复盘恰恰依赖它。
 *   R1735 已经手工归档过一次并验证可回溯（1.25 MB → 145 KB gzip），证明这条路可行。
 *   与"把日志调少"相比，归档**不丢任何信息**：诊断能力完整保留，代价只是每 1–2 小时
 *   一次几十 KB 的写入。降噪（bg-watch 948 行、心跳类 ~990 行）另作打算 —— 那些行
 *   每条当初都有存在理由（例如 `fired=false` 正是"该弹窗没弹"的唯一依据），不能粗暴关掉。
 *
 * 拆成独立函数是为了**能真测**：原来这段逻辑内嵌在 tapLine 里、路径写死，
 * 只能靠"等它自然发生"来观察 —— 而那意味着又一次"没验证过"。
 */
export type RotateResult = { rotated: boolean; archive?: string; keptBytes: number; archivedBytes: number; contended?: boolean }

/**
 * R1789：进程重启前的日志保全。
 *
 * 为什么要它：`/tmp/opencode` 会被清空（R1786 实测 08:07 重启时该目录三个日志**全部**归零，
 * `systemd-tmpfiles-clean.timer` = active），而未到 2MB 阈值时 `rotateIfNeeded` 根本不会触发
 * —— 于是重启前那 1.25MB 历史**既没归档也不轮转，直接消失**，且不留任何指针。
 * R1786 实际损失了 04:00–08:07 的全部诊断证据。
 *
 * 做法：启动时若既有日志 ≥ minBytes，先强制归档到 archiveDir（R1786 已证 /root 不随 /tmp 消失），
 * 只留 keepRatio 的尾巴（默认 5%）便于看重启前最后状态，并在日志里写 `[log] rotated` 指针。
 *
 * ⚠️ 刻意**不放在模块顶层**：tests/tap-isolation.test.ts 直接 import 本模块，
 * 另有多份测试经 tg-bridge 间接 import（R1917 已再加 NODE_ENV=test 路径改写兜底）。
 * 顶层执行会顺带轮转**生产日志**。故只导出函数，由启动路径显式调用（R1790 接线）。
 */
export function archiveOnStartup(o: {
  path: string
  archiveDir: string
  minBytes?: number
  keepRatio?: number
  now?: number
}): RotateResult {
  const minBytes = o.minBytes ?? 65536
  let size = 0
  try {
    size = statSync(o.path).size
  } catch {
    size = 0 // 文件不存在 = 新进程首启，无可保全
  }
  if (size < minBytes) return { rotated: false, keptBytes: size, archivedBytes: 0 }
  // max: 0 → size(>0) > 0 恒成立，强制走归档分支；keepRatio 0.95 = 归档前 95%、留尾 5%
  return rotateIfNeeded({ path: o.path, max: 0, archiveDir: o.archiveDir, keepRatio: o.keepRatio ?? 0.95, now: o.now })
}

/**
 * R1814：轮转失败后，「归档到底有没有被回滚掉」的**唯一合法措辞**。
 *
 * 提成纯函数不是为了好看，是因为这条措辞**是** R1813 缺陷本体：
 * R1813 在失败路径上先 append 一行写死的「…archive rolled back」，**然后**才去
 * `unlinkSync(archive)`，而那个 unlink 失败会被 `catch{}` 吞掉 —— 于是
 * **痕迹行在日志删不掉时仍然宣称「已回滚」**。R1813 修的病叫"谎报"，
 * 它自己的失败路径又长出一个谎报。fs 动作没法在单测里造出「已建成却删不掉」
 * （`chattr +i` 会让 `writeFileSync` 先失败，`archive` 直接是 undefined），
 * 所以把**措辞**从 fs 副作用里剥出来穷举。
 *
 * 三个分支必须互斥且都不含歧义：
 *  - 没建成归档（写档就失败了）：**不能说"已回滚"**，那是在声称做过一件没做的事
 *  - 建成且删掉了：唯一的"成功"措辞
 *  - 建成但没删掉：**必须带路径**，否则复盘者无从去 log-archive/ 手工处理
 */
export const rollbackVerdict = (hadArchive: boolean, orphanPath: string): string => {
  if (!hadArchive) return "no archive was created"
  if (orphanPath === "") return "archive rolled back"
  return `archive NOT rolled back: ${orphanPath}`
}

/**
 * R2232：「回合是否**真的**空闲」——纯函数，两个注入器共用同一份判据，杜绝两侧漂移：
 *   · tg-bridge 的泵 `turnActuallyIdle`（注入置顶队列里的用户消息）
 *   · auto-continue 的循环 `injectAllowed`（注入下一轮 ROUND_PROMPT）
 *
 * ## 为什么单看 `time.completed > 0` 不够（用户实报「循环提示词在没有输出完成时注入」）
 * `time.completed` 只代表**某一步（step）**完成，**不代表回合结束**。宿主在一次用户
 * 输入触发的多步工具循环里，会在一 step completed 后 ~20ms 就落盘下一步继续跑。
 * 只看 completed 会把「两轮输出之间」的空档判成空闲 → 注入插进正在跑的回合。
 * DB 实证（bot3，2026-10-10）：日志 `injected round prompt` 10:48:09.218，可它参照的
 * 那步早已 completed（10:48:08.751），而**下一步 10:48:08.773 正在运行**（到 10:48:14.412
 * 才完成）；注入的 prompt 也因此直到 10:48:14.417 才落盘。10:51:58 那次同样（参照步
 * 10:51:58.011 completed，下一步 10:51:58.029 已在跑，prompt 拖到 10:52:29.319）。
 *
 * ## 判据（全部通过才算空闲）
 *   ① `lastEventTs` 距今 < `eventSettleMs` → 不算（事件静默期，覆盖"正在流式/思考"）。
 *      **可选**：泵用自己的事件表传入；auto-continue 由 `message.updated` 事件驱动，
 *      传入同一事件时间会恒判否，故它只用 ④ 的消息级落定窗口。
 *   ② 存在最后一条 assistant 且其 `time.completed > 0`（否则无助手或仍在跑）。
 *   ③ 最后一条 assistant 的 `finish` 是 `tool-calls` → 回合未结束（**最可靠的一票**：
 *      宿主一步完成落盘后若带 tool-calls，紧接着还会跑下一步；opencode 里"回合收尾"的
 *      最后一步 finish 必为 `stop`）。
 *   ③b 压缩（compaction）行不当作助手回合：进行中的压缩一律不注入；已完成的压缩不参与
 *      ③/④ 扫描（它被 rowToV1 渲染成 role=assistant、无 finish 的"假完成消息"，会骗过 ③）。
 *   ④ 最新一条**非压缩**消息的 `created` 不晚于该 `completed`（否则回合已续到下一步）。
 *   ⑤ 尾段（末 6 条）没有 `running`/`pending` 的工具。
 *   ⑥ 该 `completed` 已过去 ≥ `settleMs`（消息级落定窗口，给"下一步即将落盘"留时间）。
 */
export const idleVerdict = (o: {
  rows: unknown
  now: number
  eventSettleMs?: number
  lastEventTs?: number
  settleMs?: number
}): { idle: boolean; why: string } => {
  const now = Number(o.now) || Date.now()
  const lastEvent = Number(o.lastEventTs ?? 0)
  const eventSettleMs = Number(o.eventSettleMs ?? 0)
  if (lastEvent > 0 && eventSettleMs > 0 && now - lastEvent < eventSettleMs) {
    return { idle: false, why: `event-${Math.round((now - lastEvent) / 1000)}s-ago` }
  }
  const arr = Array.isArray(o.rows) ? (o.rows as any[]) : []
  // ③b 压缩（compaction）判据。
  // 为什么单列：rowToV1 把压缩行渲染成 role=assistant、completed=created、**无 finish** 的
  // "假完成消息"。若当作最后一条 assistant，`laFinish=""`（不是 tool-calls）→ 误判回合已停 →
  // 在会话正压缩时注入。DB 实证（bot3，2026-10-10）：12:09:53.689 决策 msg=msg_125b7fda7001
  // （=seq 8545，type=compaction，len=46 正是压缩 header），注进了正在压缩的回合。
  // 语义上压缩不是回合，故：进行中的压缩（compactionStatus!=="completed"）一律不注入；
  // 已完成的压缩不参与下面 lastAssistant / newest 的扫描（让位给真实助手回合状态）。
  for (let i = arr.length - 1; i >= 0; i--) {
    const info = arr[i]?.info ?? arr[i]
    if (!info?.compaction) continue
    if (String(info?.compactionStatus ?? "completed") !== "completed") {
      return { idle: false, why: "compaction-in-flight" }
    }
    break
  }
  let laCreated = 0
  let laCompleted = 0
  let laFinish = ""
  for (let i = arr.length - 1; i >= 0; i--) {
    const row: any = arr[i]
    const info = row?.info ?? row
    if (info?.compaction) continue
    if (info?.role !== "assistant") continue
    laCreated = Number(info?.time?.created ?? row?.time?.created ?? 0)
    laCompleted = Number(info?.time?.completed ?? row?.time?.completed ?? 0)
    laFinish = String(info?.finish ?? info?.rawFinish ?? "")
    break
  }
  if (!(laCompleted > 0)) {
    return { idle: false, why: laCreated === 0 ? "no-assistant" : "assistant-in-flight" }
  }
  // ③ 停步原因：tool-calls = 宿主马上还会跑下一步，回合没结束。
  if (laFinish === "tool-calls" || laFinish === "tool_calls") {
    return { idle: false, why: "turn-continues(tool-calls)" }
  }
  // ④ 最新一条**非压缩**消息的 created 不晚于该 completed（否则回合已续到下一步）。
  let newest: any = null
  for (let i = arr.length - 1; i >= 0; i--) {
    const info = arr[i]?.info ?? arr[i]
    if (info?.compaction) continue
    newest = arr[i]
    break
  }
  const nInfo = newest?.info ?? newest
  const nCreated = Number(nInfo?.time?.created ?? newest?.time?.created ?? 0)
  if (nCreated > laCompleted) return { idle: false, why: "newer-message" }
  for (let i = arr.length - 1, seen = 0; i >= 0 && seen < 6; i--, seen++) {
    const row: any = arr[i]
    const parts = Array.isArray(row?.parts) ? row.parts : Array.isArray(row?.info?.parts) ? row.info.parts : []
    for (const pp of parts) {
      if (String(pp?.type ?? "") !== "tool") continue
      const stt = String(pp?.state?.status ?? "")
      if (stt === "running" || stt === "pending") return { idle: false, why: `tool-${stt}` }
    }
  }
  const settleMs = Number(o.settleMs ?? 0)
  if (settleMs > 0 && now - laCompleted < settleMs) {
    return { idle: false, why: `settling-${Math.round((now - laCompleted) / 1000)}s` }
  }
  return { idle: true, why: "settled" }
}

/**
 * R1818：offset 自愈的**目标值**判定（纯函数，分支互斥且穷举）。
 *
 * ## 这里原来错在哪（生产已触发过一次）
 * offset 的约定是 `offset = 本 Bot 最后处理成功的 update_id + 1`。
 * `real` 是服务端**当前最新** update_id（`getUpdates?offset=-1&limit=1` 的返回值，
 * **不 +1**）。于是只要服务端队列非空，就有 `stored = real + 1`，即 `ahead = 1`。
 * 旧判据只有 `if (stored <= real) return`，**没有 ahead 下限** → 把这个**常态**
 * 当成「offset 越界」，回退到 `real`，也就是**那条已经处理过的 update**；
 * 紧接着又 `seenUpdates.clear()` 清空去重环 → 它会被重新投递并**重复回复用户**。
 * 实证：2026-10-01T02:06:44.950Z primary 触发过一次，日志原文
 * `offset ahead of server (…): stored=530870734 server=530870733 ahead=1; rewinding`。
 * 当时没造成重复，纯粹是因为 40 秒后有新入站把落盘值又推了回去 —— **侥幸，不是设计**。
 *
 * ## 目标值为什么不是 `real`
 * `real` 回答的是「服务端**有什么**」，不是「我们**消费到哪**」。拿它当 offset 会把
 * 已处理的 update 重新纳入投递范围。真正的恢复点是 `lastReal + 1`：它只在
 * `handleUpdateInner` 收到**真实** update 时推进（合成事件不推进），因此永远落在
 * 本 Bot 自己的计数空间里，**即使 persistedOffset 已被污染也可靠**。
 * 没有本地记录（lastReal<=0，刚启动）时才退回旧行为 `real`。
 *
 * ## 分支穷举（互斥）
 *   - `sibling-space`：拿不到服务端真值，且 stored 高出兄弟基线 100 万以上 → 目标=兄弟
 *   - `server-real`  ：stored 真的超前于本地消费位置 → 目标=lastReal+1（无记录则 real）
 *   - `ok`           ：**常态**（含 ahead=1、stored<=real、stored 非法）→ 不动
 */
export type OffsetRewind = { target: number | null; why: "ok" | "sibling-space" | "server-real" }
export const offsetRewindTarget = (o: {
  stored: number
  real: number | null
  lastReal: number
  sibling: number | null
}): OffsetRewind => {
  if (o.real === null) {
    // 兄弟基线**只在拿不到服务端真值时**才用 —— 刻意保持原实现的这个可达性。
    // 若放宽成「总是查兄弟」，一条 sibling=1 的坏状态文件就会让 stored>1000001 的
    // 正常实例被判成「落在别人的计数空间」，凭空造出一条新的误报通道。
    if (o.sibling !== null && Number.isFinite(o.stored) && o.stored > o.sibling + 1_000_000) {
      return { target: o.sibling, why: "sibling-space" }
    }
    return { target: null, why: "ok" }
  }
  if (!Number.isFinite(o.stored) || o.stored <= 0) return { target: null, why: "ok" }
  if (o.stored <= o.real) return { target: null, why: "ok" }
  const target = Number.isFinite(o.lastReal) && o.lastReal > 0 ? o.lastReal + 1 : o.real
  // ★ R1818 的核心修复：目标不比现值小就**什么都不做**。
  // 常态 stored = lastReal+1 = real+1 → target === stored → 返回 ok，误触发归零。
  // 这条守卫同时覆盖 ahead=1 与「target 恰好等于 stored」两种边界。
  if (target >= o.stored) return { target: null, why: "ok" }
  return { target, why: "server-real" }
}

export function rotateIfNeeded(o: { path: string; max: number; archiveDir: string; incoming?: string; keepRatio?: number; now?: number }): RotateResult {
  const keepRatio = o.keepRatio ?? 0.75
  let size = 0
  try {
    size = statSync(o.path).size
  } catch {
    size = 0
  }
  if (size <= o.max) return { rotated: false, keptBytes: size, archivedBytes: 0 }

  // ── R1812：跨进程互斥（R1811 判"代价高于收益"，本轮**改判**）──────────────
  // R1811 只找到通道 ①（归档重叠，R1810 实测 7706 行），当时判"锁会引入留锁风险，
  // 代价高于收益"→ 不做。R1812 查出**同一个缺失的互斥**还有第二个通道：
  //
  //   ② **整行静默丢失**（本轮新发现，且日志里永远查不到）：
  //      本函数 readFileSync(o.path) 之后、[writeFileSync(o.path, keep+…)]
  //      （**截断重写**）之前，另一个实例的 tapLine 会 appendFileSync 进来一行。
  //      那一行既不在 `drop`（归档用的是**更早那次读**算出来的），也不在 `keep`
  //      （同样是更早那次读的后 25%）→ **整行蒸发，无任何痕迹**。
  //      这正是 R1786 吃过的同型亏（04:00–08:07 的日志被自己的策略销毁），
  //      区别是那次是"没归档"，这次是"归档了但中间那几行没了"。
  //
  // 一个缺失的互斥造成**两个**独立的真实丢数据通道 → 收益翻倍，锁必须做。
  //
  // 三条设计约束（每条都对应一个具体的坏想法）：
  //  ① 锁必须覆盖 read→archive→truncate **全程**。只锁归档那一步等于没锁——
  //     通道 ② 的窗口在归档**之后**。
  //  ② 拿不到锁就**本轮不轮转、直接返回**，绝不等待/重试：`tapLine` 是每一行日志
  //     都会走的热路径，等锁会把日志写入阻塞在文件 IO 上（更糟：日志一停，
  //     watchdog 的判据就跟着瞎）。持锁者会替我们轮转。
  //  ③ 必须防"进程猝死留下锁 → 日志无限增长"：锁 mtime 超过 LOCK_STALE_MS 即可 steal。
  const ROTATE_LOCK_STALE_MS = 30_000
  const lockPath = `${o.path}.rotlock`
  const acquireRotateLock = (): number | undefined => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return openSync(lockPath, "wx", PRIVATE_FILE_MODE)
      } catch {
        let stale = true
        try {
          stale = Date.now() - statSync(lockPath).mtimeMs > ROTATE_LOCK_STALE_MS
        } catch {
          stale = true // 锁 vanished → 当作可抢
        }
        if (!stale) return undefined
        try {
          unlinkSync(lockPath)
        } catch {
          /* ignore */
        }
      }
    }
    return undefined
  }
  const lockFd = acquireRotateLock()
  // R1815：拿不到锁 → `contended`。这不是"报个状态"，而是**唯一一处能让通道②变得可测**的地方：
  // tapLine 的 appendFileSync 发生在**锁之外**（结构决定的，见 tapLine 注释），所以另一个
  // 进程被挡在这里之后**照样会写**，而那一行正好可能落进持锁者的 read→rename 窗口。
  // 不置这个标志，那个窗口就永远是隐形的——R1812 加锁时误以为已经关掉了通道②。
  if (lockFd === undefined) return { rotated: false, keptBytes: size, archivedBytes: 0, contended: true }
  try {
    // 拿锁后必须**重新量一次**：抢锁期间持锁者可能刚截断过，size 也许已回落到阈值下。
    // 不重量就会在"文件其实已经不大"的情况下白建一个空归档（比原 bug 更隐蔽）。
    let size2 = 0
    try {
      size2 = statSync(o.path).size
    } catch {
      size2 = 0
    }
    if (size2 <= o.max) return { rotated: false, keptBytes: size2, archivedBytes: 0 }

    let data = ""
    try {
      data = readFileSync(o.path, "utf8")
    } catch {
      // 读不出来就退化成"只留新行"（与原行为一致），不让日志写入整体失败
      try {
        writeFileSync(o.path, `${o.incoming ?? ""}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
      } catch {
        /* ignore */
      }
      return { rotated: true, keptBytes: 0, archivedBytes: 0 }
    }

    // R1791：切点必须落在**行边界**。
    // 原来 `cut` 是字节偏移，于是跨切点那一行前半截进归档（成为半行）、
    // 后半截被下面那句 `keep.indexOf("\n")` 整段丢弃 → **每次轮转净丢一整行**。
    // 证据：R1790 首个生产归档 v2plugin-20261001T083322Z.log.gz 的末行就是半行
    //   `…T08:31:14.524Z [tg-bridge/alt] info`（缺 `: message`），活动日志首行已是下一条 `.528`。
    // 代价虽小（约 2100 行丢 1 行），但丢的可能是"崩溃前最后一条出站"这种关键行。
    const cut = Math.floor(data.length * keepRatio)
    const cutLine = data.lastIndexOf("\n", cut - 1) + 1 // 最后一个完整行的行尾之后
    // 一个完整行都凑不齐（cut 之前没有任何换行）→ 无从干净切分。
    // 此时**不轮转**：宁可让文件超限，也不能丢日志。正常路径不会走到
    // （minBytes=64KB、TAP_MAX=2MB 都远大于单行长度），但必须有断言钉住这条退化路径。
    if (cutLine <= 0) return { rotated: false, keptBytes: size, archivedBytes: 0 }
    const drop = data.slice(0, cutLine) // 末尾必为换行 → 归档末行是完整行
    const keep = data.slice(cutLine) // 已从行首开始，**不能再 skip**（skip 会整行丢掉一条完整行）

    // ── R1811：防「归档重叠」─────────────────────────────────────────────────
    // `rotateIfNeeded` 是「先写归档、再 writeFileSync 截断」**两步、非原子**。
    // 若归档写成而截断没生效（进程死在两步之间；或两个轮转者——三 bot 实例 / 多进程
    // 共用同一份 tap 文件，`poll lease` 机制本身就说明会争用——读到同一份未截断的文件），
    // 下一次轮转会把**同一前缀再归档一遍**。
    // 生产实证（R1810）：v2plugin-20261001T033605Z 与 T045928Z 两档**重叠 7706 行**
    // （后一档 9143 行里 7706 行逐字相同，且首行时间与前一档完全一样 00:42:55）。
    //
    // 修法：**把指针行当账本**。指针行本来就必须写进日志（R1735 的运维坑：否则日后复盘
    // 看到日志少一大段，却完全不知道去哪找），于是顺手在末尾追加
    // `through T<ISO>` = 本次归档**最后一行**的时间戳。下次轮转若 `drop` 里已含这样的
    // 指针行，说明这段前缀**已经归档过** → 只归档 T 之后的新行；截断照旧照做。
    //
    // 为什么不用独立状态文件：指针行与被归档内容在**同一个文件、同一次 writeFileSync** 里，
    // 不存在"状态写了但没截断"的中间态——而独立状态文件必须额外处理这个窗口，
    // 恰好就是它要修的那个窗口。
    // ★ R1811 撤回记录（保留这段注释是有意的，别当垃圾删）：
    // 我第一版修法是"指针行当账本"——指针行末尾写 `through T<ISO>`，下次轮转若 `drop`
    // 里已含该时间点，就把 `drop` 裁成那行之后的新行（增量归档）。
    // **写完自己推演，发现它在真实失败模式下是死代码**：
    //   ① 正常流程：`through T` 那一行**已随截断离开文件**（T 就是 drop 的最后一行，
    //      keep 从它的下一行开始）→ 下次在 `drop` 里**找不到**那行 → 裁剪永不触发；
    //   ② 跨进程竞态：B 读的是**截断前**的内容，里面**根本没有 A 的指针行**
    //      （A 的指针行是随截断一起写进新文件的）→ 裁剪同样永不触发。
    // 两条路都落空，还平白多出"读到指针行就裁、裁错就丢日志"的新风险 → 本轮撤回。
    //
    // 正确修法是**跨进程互斥**：read→archive→truncate 全程持 `openSync(lock,"wx")`
    // 排他锁（配过期超时防猝死留锁），拿不到锁就本轮不轮转。
    // 本轮**不实施**：该竞态 8 档里只出现 1 次、此后 6 轮全 0 重叠；而排他锁会引入
    // "留锁 → 日志无限增长"这个**新的**失效模式，代价高于当前收益 → 登记为"复发即实施"。
    //
    // 本轮只做**零行为变更**的一件事：指针行末尾追加 ` through T<ISO>`，
    // 让每档归档自带边界 —— 将来一旦复发，一眼就能看出"重叠从哪一行开始"。
    const ISO_HEAD = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) /
    const dLines = drop.split("\n")

    // 先归档再截断：归档失败也要照常轮转（不能因为归档不上就无限增长）
    let archive: string | undefined
    const ts = new Date(o.now ?? Date.now()).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z")
    try {
      mkdirSync(o.archiveDir, { recursive: true })
      archive = `${o.archiveDir}/v2plugin-${ts}.log.gz`
      writeFileSync(archive, gzipSync(Buffer.from(drop, "utf8")), { mode: PRIVATE_FILE_MODE })
    } catch {
      archive = undefined
    }

    // 指针行：轮转后必须**在日志里留下"历史被挪到哪了"**，否则未来复盘时看到日志突然
    // 少了一大段，却完全不知道去哪找 —— 这正是 R1735 发现的那个运维坑本身。
    // 写成 ASCII：日志可能被 grep/awk 按字节处理，且这份指针是要给人看的最短路径。
    // R1811：末尾追加 ` through T<ISO>`（本次归档**最后一行**的时间戳）——
    // 这行同时就是下一轮"已归档到哪"的账本，见上面 R1811 注释。
    // 取 ISO 要**从末尾往前找**：`drop` 的最后一行有可能本身就是上一轮的指针行（无时间戳）。
    let lastIso = ""
    for (let i = dLines.length - 2; i >= 0; i--) {
      const m = ISO_HEAD.exec(dLines[i] ?? "")
      if (m) {
        lastIso = m[1] ?? ""
        break
      }
    }
    const marker = archive
      ? `[log] rotated: older lines archived to ${archive} (read: zcat <file>)${lastIso ? ` through T${lastIso}` : ""}\n`
      : ""
    // ── R1813：截断写必须是「**原子替换 + 可失败可见**」────────────────────
    // 旧写法 `writeFileSync(o.path, keep+marker+…)` 有**两个**独立缺陷，R1812 的锁都盖不住
    // （锁防的是"两个轮转者"，而 03:36:05 那次**只有一个**写入者 pid=671）：
    //
    //   ① **静默失败**：writeFileSync 抛错（ENOSPC/EACCES/EMFILE…）会一路冒到 tapLine 的
    //      `catch {}` 被吞掉 → 归档**已经落盘**却谎称"这些行已归档"，而日志**根本没被截断**、
    //      指针行也没写进去。后果不是丢数据，而是**下一次轮转把同一批行再归档一遍**
    //      （R1810 实测的 7707 行重叠，失败点已用指针行计数法定位到 03:36:05 那一次：
    //      T045928Z 跨度 00:42:55→04:00:35 完整包含 T033605Z 的 7707 行，且两档指针行都是 0）。
    //      零痕迹 —— 这就是为什么它躲过了 3 轮筛查。
    //   ② **失败即毁日志**：writeFileSync 是**截断写**，中途失败会在 o.path 留下一个
    //      **残缺文件**。那比"不轮转"糟得多：keep 区（已归档的那 75% 的最新部分）当场蒸发。
    //
    // 修法：写临时文件 → `renameSync` 原子替换（同目录内 rename 是原子的）。
    //   - 成功：与旧行为**逐字一致**（content 完全相同，inode 换了但路径语义不变）。
    //   - 失败：**原日志一个字节都没动过**（rename 从未发生），删掉临时文件即可；
    //     再把 `rotated` 报 false，让 tapLine 继续 appendFileSync（那行日志不会因此丢）。
    //   - 留痕：写一条 `[log] rotate FAILED`（**不能走 tapLine/logLine**：那会重入本函数
    //     拿锁 → 自死锁），直接 appendFileSync 到 o.path。此时文件必然完好（写失败了才到这），
    //     所以这条痕迹**一定留得住**——这正是旧实现最缺的东西。
    const tmpPath = `${o.path}.rot-tmp`
    let truncated = false
    try {
      writeFileSync(tmpPath, keep + marker + `${o.incoming ?? ""}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
      renameSync(tmpPath, o.path)
      truncated = true
    } catch {
      // 只清临时文件。**绝不碰 o.path**：它现在仍是那份完整未截断的日志，是唯一的数据副本。
      try {
        unlinkSync(tmpPath)
      } catch {
        /* ignore */
      }
    }
    if (!truncated) {
      // 归档已经落盘却没截断 → 它是一份**重复副本**（R1810 的重叠就是它）。
      // 留着它只会让下次轮转再重叠一次；但删之前必须先留下"发生过什么"的痕迹。
      //
      // R1814：痕迹行与回滚**换序**，并让它**只说实话**。R1813 写的是「先 append 一行
      // 『…archive rolled back』，再去 unlink」——两个毛病叠在一起：
      //   ① unlink 可能**失败**，而失败被 `catch{}` 吞掉 → 痕迹行仍然宣称"已回滚"，
      //      **说谎**。R1813 修的就是"谎报"，结果自己在失败路径上又造了一个。
      //   ② 删不掉的归档会**永久留在** log-archive/ 里，且文件名与真归档**一模一样**。
      //      这比重叠更坏：重叠的归档**内容至少是对的**；冒充的归档会让
      //      "这些行已经安全归档了"这个判断彻底失效（复盘者按名字读它，读到的却是
      //      一份**会与后续档无限重叠**的副本）。
      // → 所以：**先回滚、拿到真实结果、再写痕迹**，痕迹里带上真实结果；
      //   删不掉就改名成 `.orphan`，让"这不能当归档用"**写在文件名里**，
      //   这样即使痕迹行也丢了，看名字的人也不会上当。
      let orphanPath = ""
      if (archive) {
        try {
          unlinkSync(archive)
        } catch {
          const orphan = `${archive}.orphan`
          try {
            renameSync(archive, orphan)
            orphanPath = orphan
          } catch {
            // 连改名都不行（目录不可写等）：如实记下**原路径**并明说"删不掉"，
            // 绝不粉饰。复盘时按这个名字去 log-archive/ 手工处理。
            orphanPath = `${archive} (rename to .orphan also failed)`
          }
        }
      }
      const verdict = rollbackVerdict(archive !== undefined, orphanPath)
      const stamp = new Date(o.now ?? Date.now()).toISOString()
      try {
        appendFileSync(o.path, `${stamp} [log] rotate FAILED (truncate aborted; log left intact; ${verdict})\n`, {
          encoding: "utf8",
          mode: PRIVATE_FILE_MODE,
        })
      } catch {
        /* ignore */
      }
      try {
        // stderr 是最后一道留痕：万一 o.path 连 append 都失败（磁盘满），这里仍在。
        console.error(`[log] rotate FAILED (truncate aborted): log left intact; ${verdict}`)
      } catch {
        /* ignore */
      }
      // keptBytes 用 size2（拿锁后重量的那个），不是外层 size —— 外层是**抢锁前**的陈旧值，
      // 报它会让"日志还剩多大"这个数字在故障现场直接说谎。
      return { rotated: false, archive: undefined, keptBytes: size2, archivedBytes: 0 }
    }
    return { rotated: true, archive, keptBytes: keep.length, archivedBytes: archive ? drop.length : 0 }
  } finally {
    // 释放锁**必须**在 finally：上面任何一条 return（含"重新量后已达标"那条）
    // 都会跳过它。漏掉一次就是 30 秒内日志不轮转 —— 按约束 ② 那不阻塞写入，
    // 但会白白让文件超限 30 秒，所以不能省。
    try {
      closeSync(lockFd)
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(lockPath)
    } catch {
      /* ignore */
    }
  }
}

// 轮转争用计数：tapLine 在锁**之外** append，所以被挡在锁外的另一个写入者仍会落一行，
// 而那一行可能正好落在持锁者的 read→rename 窗口里 → 整行蒸发（R1812 通道②）。
// R1812 加锁时**误以为已经关掉了它** —— 锁只关掉了通道①（两个轮转者）。
// 这里不做修复，只让它**可数**：争用才计数（不是"真的丢了"才计），计数为 0 就等于
// 证明这个宿主上从来没有第二个写入者，那个窗口也就不存在。措辞必须说"可能"。
let rotateContended = 0
let rotateContendedTraceAt = 0
const ROTATE_CONTENDED_TRACE_MS = 60_000

const tapLine = (line: string): void => {
  try {
    const r = rotateIfNeeded({ path: TAP_PATH, max: TAP_MAX, archiveDir: LOG_ARCHIVE_DIR, incoming: line })
    if (r.rotated) return
    appendFileSync(TAP_PATH, `${line}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE })
    if (r.contended) {
      rotateContended += 1
      // 节流留痕。**不能走 logLine**：它会 tapLine 回来 → 再次进 rotateIfNeeded → 争用时
      // 计数再增 → 自己把自己的节流窗口吃掉，且这条痕迹是被争用的写入**推**出来的，
      // 用它计数会把"观测"变成"观测的一部分"。
      if (Date.now() - rotateContendedTraceAt >= ROTATE_CONTENDED_TRACE_MS) {
        rotateContendedTraceAt = Date.now()
        try {
          appendFileSync(
            TAP_PATH,
            `${new Date().toISOString()} [log] rotate CONTENDED (n=${rotateContended}; another writer holds the lock, lines appended in its read-rename window MAY be lost)\n`,
            { encoding: "utf8", mode: PRIVATE_FILE_MODE },
          )
        } catch {
          /* best-effort */
        }
      }
    }
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
// R1911：此前是永久闩锁（`dbFailed` 变量一旦置位就再也不清）—— 启动瞬间 DB 打开失败一次，本实例生命周期内
// openDb 永远返回 null，history/usage **永久降级**且日志只报一次（无从察觉）。改为「失败进入
// 冷却、冷却过后自动重试」：宿主启动瞬间的瞬态失败（DB 被占用/WAL 未就绪）会自愈。
// 冷却期内不重复尝试（避免每次读历史都撞一遍），日志节流 60s（避免刷屏）。
let dbFailAt = 0
let dbFailLogAt = 0
const DB_RETRY_MS = 30_000
const DB_FAIL_LOG_MS = 60_000
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
  if (dbHandle) return dbHandle
  const now = Date.now()
  // 冷却期内直接返回（不重试、不刷日志）；冷却过后允许重新尝试。
  if (dbFailAt > 0 && now - dbFailAt < DB_RETRY_MS) return null
  try {
    const mod: any = await import("bun:sqlite")
    dbHandle = new mod.Database(DB_PATH, { readonly: true })
    dbFailAt = 0 // 打开成功：清掉失败态
    return dbHandle
  } catch (err) {
    dbFailAt = now
    if (now - dbFailLogAt > DB_FAIL_LOG_MS) {
      dbFailLogAt = now
      logLine(
        "v2compat",
        "error",
        `bundb unavailable, history empty: ${String(err).slice(0, 160)} (R1911: ${DB_RETRY_MS / 1000}s 后自动重试)`
      )
    }
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
    // R2232：把宿主的**停步原因**（`finish` / `rawFinish`）透传给 V1 形态。
    // 这是判定"回合是否真的结束"的唯一可靠信号：opencode 的助手行**只在一步完成时落盘**，
    // 所以"看得见的最后一步 completed"常只是**中间步**（它带 `finish=tool-calls`，宿主紧接着
    // 还会跑下一步）；真正的回合收尾，最后一步的 `finish` 是 `stop`。注入前据此判定，
    // 就不再依赖"看不见的在飞步"是否已落盘（DB 读不到在飞步，settle 窗口也挡不住长步）。
    // 实测 bot3：坏注入 11:02:51.498 前那步 finish=tool-calls（回合续到 11:02:55）；
    // 正常收尾 11:02:55.223 finish=stop（随后 11:03:08 idle outcome=succeeded）。
    const rFinish = (d as any)?.finish
    const rRawFinish = (d as any)?.rawFinish
    return {
      id,
      info: {
        id,
        role: "assistant",
        time: { created: tm.created ?? 0, streamed: tm.streamed ?? 0, completed: tm.completed ?? 0 },
        error: (msgErr ?? null) as any,
        tokens,
        model: rModel && typeof rModel === "object" ? { id: String(rModel.id ?? ""), providerID: String(rModel.providerID ?? "") } : undefined,
        finish: rFinish === undefined || rFinish === null ? undefined : String(rFinish),
        rawFinish: rRawFinish === undefined || rRawFinish === null ? undefined : String(rRawFinish),
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
    // R2232-fix：压缩行被渲染成 role=assistant 的"假完成消息"（completed=created、无 finish）。
    // idleVerdict 若不识别它，会把它当"回合已 stop 的最后一步"→ 在会话正压缩时注入。
    // 打标记让 idleVerdict 能把它与真实助手区分（详见 idleVerdict ③b）。
    return {
      id,
      info: { id, role: "assistant", time: { created, completed: created }, compaction: true, compactionStatus: status },
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

// service.json 里有 serve 的 password；serve 的 /api 鉴权 = Basic("opencode:"+password)。
// 本插件跑在 serve 同机，能读到该文件 → HTTP 兜底通道从 401 变为可用（R1488 promote 的关键补全）。
let cachedServiceAuth: string | null = null

const readServiceAuth = async (): Promise<string | null> => {
  try {
    const fs: any = await import("node:fs")
    const home = process.env.HOME ?? "/root"
    const raw = fs.readFileSync(`${home}/.config/opencode/service.json`, "utf8")
    const pw = JSON.parse(raw)?.password
    if (typeof pw !== "string" || !pw) return null
    const plain = `opencode:${pw}`
    const b64 =
      typeof btoa === "function" ? btoa(plain) : Buffer.from(plain, "utf8").toString("base64")
    return `Basic ${b64}`
  } catch {
    return null
  }
}

const buildAuthHeaders = async (): Promise<Record<string, string>> => {
  if (cachedServiceAuth === null) cachedServiceAuth = await readServiceAuth()
  return cachedServiceAuth ? { authorization: cachedServiceAuth } : {}
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
        headers: { "content-type": "application/json", ...(await buildAuthHeaders()) },
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
        headers: { "content-type": "application/json", ...(await buildAuthHeaders()) },
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

// ---- 循环注入提醒（用户需求：循环消息注入时发消息提醒我）─────────────────
// 各 Bot 的 tg-bridge 实例在启动时通过 registerInjectNotifier 注册自己的发送器；
// auto-continue 每次循环注入成功后 fireInjectNotices。容器必须挂在 **globalThis**
// 而不是模块级 Map：tg-bridge 各 Bot 实例从 `.v2lib-live/` 快照加载、auto-continue
// 从 v2lib 活文件加载，两者 import 到的 _v2compat 是**两个模块实例**——模块级 Map
// 会被劈成两半（一边注册、一边 fire 无人应答）。globalThis 与 __oc_bg_promoted_hooks__
// / BG_WATCH_KEY 同套路：进程内共享，跨模块实例可见。
// 「发往哪个聊天 / 会话归属过滤 / 节流」由各 Bot 发送器内部决定；通知失败一律
// best-effort，绝不阻塞循环主链路。
export type InjectNoticeKind = "round" | "recover"
export type InjectNoticeFn = (sessionID: string, kind: InjectNoticeKind) => void | Promise<void>
type InjectNotifierEntry = { bot: string; fn: InjectNoticeFn }
const INJECT_NOTIFIER_KEY = "__oc_inject_notices__"
const injectNotifierList = (): InjectNotifierEntry[] => {
  const g = globalThis as { [INJECT_NOTIFIER_KEY]?: InjectNotifierEntry[] }
  if (!Array.isArray(g[INJECT_NOTIFIER_KEY])) g[INJECT_NOTIFIER_KEY] = []
  return g[INJECT_NOTIFIER_KEY] as InjectNotifierEntry[]
}
export const registerInjectNotifier = (bot: string, fn: InjectNoticeFn): void => {
  const arr = injectNotifierList()
  const idx = arr.findIndex((e) => e.bot === bot)
  if (idx >= 0) arr[idx] = { bot, fn }
  else arr.push({ bot, fn })
}
export const unregisterInjectNotifier = (bot: string): void => {
  const arr = injectNotifierList()
  const idx = arr.findIndex((e) => e.bot === bot)
  if (idx >= 0) arr.splice(idx, 1)
}
export const fireInjectNotices = (sessionID: string, kind: InjectNoticeKind): void => {
  const fns = [...injectNotifierList()]
  for (const { fn } of fns) {
    try {
      void Promise.resolve(fn(sessionID, kind)).catch(() => {
        /* best-effort：通知失败不影响循环 */
      })
    } catch {
      /* best-effort */
    }
  }
}
export const injectNotifierCount = (): number => injectNotifierList().length

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
    // ── R1488 插件层「shell 跑超 60s 强制转后台」合规实现 ────────────────────
    // 机制：执行期钩子 ctx.tool.hook（execute.before / execute.after）**只读**事件计时；
    // 到点调宿主原生「当前步转后台」（TUI ctrl+b 语义的 /background 端点，用户指定路线）。
    // 满足用户两条红线：插件判断（不靠模型自觉）+ 不改请求（不增删改工具定义、
    // 不改发往 provider 的 tools 负载，也不碰事件 input/result）。
    // R1482 同名工具覆盖已全量回滚（上方事故链注释），本路径不再触碰工具注册表。
    // 单实例守卫（globalThis）：桥多实例 / 两个插件入口同进程共享一个 watcher；
    // 新世代注册前先 dispose 旧世代 → 即使宿主重载时未注销旧钩子，旧钩子也保持失活，
    // 不会双发 promote、不会累积计时器。
    try {
      const G = globalThis as any
      const BG_WATCH_KEY = "__oc_bgwatch_v1__"
      // R2230 重写：持久转发式注册。
      // 实测教训：execute.before/after 不是每代必达——宿主重载后仍可能把事件投给
      // **旧代**监听器；旧代码的监听器闭包绑定「本代 watcher」，一旦该 watcher 被下一
      // 代 dispose（set dead=true），事件到达却静默丢弃 → 症状即用户所报「自动后台不工作」
      // （watch start 从不出现在日志里，bot3 的 >120s shell 照样被宿主 120s 超时杀掉）。
      // 修法：每进程只挂一批**转发器**（reg.attached 守卫），闭包引用全局 reg 而非本代
      // watcher；每次重载只把 reg.active 换成新 watcher。无论宿主把事件投给哪一代哪个
      // 实例的监听器，最终都转发到当前 active；同 watcher 内部按 key 幂等，不会双发。
      if (!G[BG_WATCH_KEY]) G[BG_WATCH_KEY] = { active: undefined as any, attached: false }
      const reg = G[BG_WATCH_KEY]
      const tctx = (context as any)?.tool
      if (typeof tctx?.hook === "function") {
        const watcher = makeBgWatch({
          // 熔断：background-mode.json 的 shellPromo（默认 true = 插件层强制开启）
          enabled: () => {
            try {
              return readBg().shellPromo !== false
            } catch {
              return true
            }
          },
          promoteMs: () => {
            // R1505：阈值可调（background-mode.json 的 promoteMs，默认 60s）。
            // 每次起计时现读 → 用户 `/background th 90` 改完立即生效，无需重载插件。
            try {
              const ms = readBg().promoteMs
              return Number.isFinite(ms) && ms >= 1_000 ? ms : 60_000
            } catch {
              return 60_000
            }
          },
          log: (line) => logLine(id, "info", `[bg-watch] ${line}`),
          promote: async (sid: string, evId?: string) => {
            // 优先进程内 client RPC（免票）；不行再走本机 HTTP 兜底。
            const c: any = (context as any)?.client
            // R1607：转后台成功后通知桥侧（各 bot 实例注册的全局钩子）在
            // 「原来消息」（shell 执行卡片）末尾追加一行提示 —— 用户指令
            // 「在shell提升到后台时，在原来消息末尾增加一行提示」。
            const firePromotedHooks = async (sid: string, evId?: string): Promise<void> => {
              const G = globalThis as any
              const arr = Array.isArray(G.__oc_bg_promoted_hooks__) ? [...G.__oc_bg_promoted_hooks__] : []
              for (const h of arr) {
                try {
                  await h?.fn?.(sid, evId)
                } catch (err) {
                  logLine(id, "warn", `[bg-watch] promoted hook err: ${String(err).slice(0, 120)}`)
                }
              }
            }
            try {
              if (c && typeof c.background === "function") {
                const out = await c.background({ sessionID: sid })
                logLine(id, "info", `[bg-watch] promote via client.background sid=${sid.slice(0, 12)} ok`)
                await firePromotedHooks(sid, evId)
                return out
              }
              if (c?.session && typeof c.session.background === "function") {
                const out = await c.session.background({ sessionID: sid })
                logLine(id, "info", `[bg-watch] promote via client.session.background sid=${sid.slice(0, 12)} ok`)
                await firePromotedHooks(sid, evId)
                return out
              }
            } catch (err) {
              logLine(id, "warn", `[bg-watch] client.background 尝试失败，回退 HTTP: ${String(err).slice(0, 160)}`)
            }
            try {
              const out = await postLocalAPI(sid, "background")
              logLine(id, "info", `[bg-watch] promote via HTTP /background sid=${sid.slice(0, 12)} ok`)
              await firePromotedHooks(sid, evId)
              return out
            } catch (err) {
              logLine(id, "error", `[bg-watch] promote 全部路径失败: ${String(err).slice(0, 200)}`)
              throw err
            }
          },
        })
        if (reg.active && typeof reg.active.dispose === "function") reg.active.dispose()
        reg.active = watcher
        // 转发器只挂一次（同一进程内多实例/多代共享；闭包引用 reg，永不失效）。
        if (!reg.attached) {
          reg.attached = true
          tctx.hook("execute.before", (ev: any) => {
            try {
              reg.active?.onBefore?.(ev ?? {})
            } catch (err) {
              logLine(id, "error", `[bg-watch] before err: ${String(err).slice(0, 140)}`)
            }
          })
          tctx.hook("execute.after", (ev: any) => {
            try {
              reg.active?.onAfter?.(ev ?? {})
            } catch (err) {
              logLine(id, "error", `[bg-watch] after err: ${String(err).slice(0, 140)}`)
            }
          })
          logLine(id, "info", "[bg-watch] persistent forwarders attached (forward-to-active)")
        } else {
          logLine(id, "info", "[bg-watch] active watcher replaced (forwarders already attached)")
        }
      } else {
        if (!reg.attached) logLine(id, "error", "[bg-watch] ctx.tool.hook 不可用，插件层转后台未注册（不影响其他功能）")
      }
    } catch (err) {
      logLine(id, "error", `[bg-watch] register err: ${String(err).slice(0, 140)}`)
    }
    return () => {
      stop = true
    }
  },
})
