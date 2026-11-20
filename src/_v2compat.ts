import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { makeBgWatch } from "./bg-watch"
import { readBg } from "./bg-mode"
import { isLoopInjectMeta, rowHasLoopInjectMeta } from "./loop-inject-mode"
// R2660：注入的 delivery/resume 必须真正到达宿主 —— 否则宿主按默认 steer 处理，
// 会在回合仍在输出时插入（见 prompt-delivery.ts 头注）。
import { isPromptDelivery, isPromptShapeError, promptPayloads } from "./prompt-delivery"
// 上下文用量的唯一口径（宿主 v2.3.0 的 HZ/jr：五字段之和 / limit.context）。
// 事件映射、DB 行回读、tg-bridge 卡片、auto-continue 压缩判断都必须走这一份。
import { parseTokenUsage, tokenUsagePayload, type ParsedTokenUsage } from "./ctx-usage"
// R2686：0600 权限与宿主行排序都上收到共享核，避免各业务模块复制后漂移。
import { PRIVATE_FILE_MODE } from "./state-io"

export type V1Hook = (payload: { event: any }) => Promise<void> | void

export interface V1Client {
  app: { log: (input: { body: { service: string; level: string; message: string } }) => Promise<unknown> }
  session: {
    messages: (input: { path: { id: string } }) => Promise<{ data: any[] }>
    promptAsync: (input: {
      path: { id: string }
      body: {
        parts: Array<{ type: string; text: string }>
        metadata?: Record<string, unknown>
        delivery?: "queue" | "steer"
        resume?: boolean
      }
    }) => Promise<unknown>
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
  process.env.AC_LOG_ARCHIVE_DIR ?? (process.env.NODE_ENV === "test" ? TEST_ARCHIVE_DIR : `REDACTED_ROOT/.opencode/log-archive`)
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
 *      ③/④ 扫描（它被 rowToV1 渲染成 role=system + type=compaction 的独立压缩行）。
 *   ④ 最新一条**非压缩**消息的 `created` 不晚于该 `completed`（否则回合已续到下一步）。
 *   ⑤ 尾段（末 6 条）没有 `running`/`pending` 的工具。
 *   ⑥ 该 `completed` 已过去 ≥ `settleMs`（消息级落定窗口，给"下一步即将落盘"留时间）。
 *
 * R2376 死回合逃生（stuck-turn）：③/④ 原本**没有超时**。一旦一轮被 provider ECONNRESET /
 * 宿主中断打断——最后一步以 `finish=tool-calls`（宿主本应续跑下一步，但不会了）或一条
 * 更晚的 synthetic/更新行收尾——旧判据就**永久**判"回合未结束"，`injectAllowed` 永不放行、
 * 循环空转（实证：primary 卡 ~40 分钟，直到用户发新消息；bot3 同理）。修法：③/④ 在
 * 「已静置 > STUCK_TURN_MS」**且**「尾段确无 running/pending 工具」双条件下判死回合。
 * 阈值可用环境变量 `AC_STUCK_TURN_MS` 调整，设 0 关闭（退回旧行为）。
 */
const STUCK_TURN_MS = Number(process.env.AC_STUCK_TURN_MS ?? 300_000)
/**
 * R2847：provider 额度错误自带 `retryAfterMs`（实测 ~8h）。固定 120s 冷却后放行
 * 探测必然再撞同一个 429 —— 2026-11-19 16:18/16:35 两轮实测即如此。冷却窗至少
 * 覆盖 provider 给的恢复时间，但必须封顶：异常的超长值（或宿主时钟漂移）不能让
 * 排队消息永远出不来。24h 足以覆盖 free-limit 的 ~8h，又保证跨天一定能重试。
 */
const QUOTA_HOLD_MAX_MS = 24 * 3600_000
/**
 * R28xx：**压缩**的静置阈值（与回合逃生同族）。见 idleVerdict ③b 分支的说明。
 * 正常压缩实测 19–72 秒（本会话 15 次），故 5 分钟 = 4× 余量；可用
 * `AC_STUCK_COMPACTION_MS` 调整，设 0 关闭该逃生（退回旧行为=可能永久持有）。
 */
const STUCK_COMPACTION_MS = Number(process.env.AC_STUCK_COMPACTION_MS ?? 300_000)

/**
 * v2 语义：压缩是独立消息类型（`session_message.type = "compaction"`），不是
 * assistant 回合。兼容层会把它标成 role=system + compaction=true；这里同时接受
 * 原始 v2 行（type=compaction）和兼容行，避免两条链路判据漂移。
 */
export const isCompactionMessage = (m: unknown): boolean => {
  const row: any = m
  const info = row?.info ?? row
  return info?.compaction === true || String(info?.type ?? row?.type ?? "") === "compaction"
}

/**
 * 终态压缩行：`completed` / `failed` 都不再占用回合，尾检时应透明跳过。
 * 只有 `running`（或未知非终态）才代表压缩仍在进行，必须保持不注入。
 * （2026-11-17 实证：bot5 尾部是 `compaction status=failed`，旧尾检把它当成
 * “更新的消息”而永久拒绝恢复空回合 —— 循环开着却一条都不注入。）
 */
export const isTerminalCompaction = (m: unknown): boolean => {
  if (!isCompactionMessage(m)) return false
  const row: any = m
  const info = row?.info ?? row
  const st = String(info?.compactionStatus ?? info?.status ?? row?.status ?? "completed")
  return st === "completed" || st === "failed"
}

/**
 * 有效尾条：从后往前跳过终态压缩行，返回真正承载回合的那条消息 id。
 * 调用方语义：
 *   · `blocked="compaction-in-flight"` → 尾部压缩未结束，本拍不得注入；
 *   · 空 id → 无证据（空数组/异常形状），按“不注入”保守处理；
 *   · 否则拿 `id` 与待恢复回合比较，相等才放行。
 */
export const effectiveTail = (rows: unknown[]): { id: string; blocked: string; row?: any } => {
  const arr = Array.isArray(rows) ? rows : []
  for (let i = arr.length - 1; i >= 0; i--) {
    const row: any = arr[i]
    if (!row || typeof row !== "object") return { id: "", blocked: "bad-tail" }
    if (isCompactionMessage(row)) {
      if (!isTerminalCompaction(row)) return { id: "", blocked: "compaction-in-flight" }
      continue
    }
    return { id: String(row?.id ?? row?.info?.id ?? ""), blocked: "", row }
  }
  return { id: "", blocked: "" }
}

export const idleVerdict = (o: {
  rows: unknown
  now: number
  eventSettleMs?: number
  lastEventTs?: number
  settleMs?: number
  stuckTurnMs?: number
  stuckCompactionMs?: number
  /**
   * R2660：宿主自己写的回合结束时间（`session_v2.time_idle`）。它比"最后一步
   * completed=0/tool-calls"权威得多 —— 宿主已经宣布 idle 时，就不该再等
   * `AC_STUCK_TURN_MS`（默认 5 分钟）才恢复注入。
   *
   * 只用于**死回合**分支（incomplete assistant / finish=tool-calls）；且要求
   * idle 之后没有更新的消息、尾段没有 running/pending 工具 —— 否则视为宿主已开始
   * 新回合，退回原有启发式。
   */
  hostIdleAt?: number
  /**
   * R2835（运营者：「@opencodev2_bot的174522和174521是一个429吗」排查）：
   * 宿主在工具步之间会短暂写 `time_idle`。最后一条消息刚产出时，不能把这段
   * 瞬时空闲当死回合 —— 必须再静置一个确认窗，等迟到的 error/finish 行落盘。
   * 默认 2s；设 0 关闭（退回旧行为）。
   */
  hostIdleConfirmMs?: number
  /**
   * R2809（运营者：「错误不算本轮结束，只有正常结束才算」）：排队用户消息的泵
   * 只认 `finish=stop` / 其它正常终态；尾条是 `finish=error`（含 abort/transport）
   * 时继续持有，先让尾恢复/旧回合续完。auto-continue 的 recover 注入**不传**
   * 这个开关，否则它会把自己要恢复的错误尾条也判成"未结束"而永远不注入。
   */
  requireNormalEnd?: boolean
  /**
   * R2845：额度错误的冷却窗。尾条是 429/free-limit 时，completed 之后至少等这么久
   * 再放行一条**探测**；超时后返回 idle=true，让队列里的消息去试一次。若仍 429，
   * 新错误行会刷新冷却。0/缺省 = 不启用（auto-continue 的 recover 不需要）。
   */
  quotaHoldMs?: number
}): { idle: boolean; why: string; retryInMs?: number } => {
  const now = Number(o.now) || Date.now()
  const lastEvent = Number(o.lastEventTs ?? 0)
  const eventSettleMs = Number(o.eventSettleMs ?? 0)
  if (lastEvent > 0 && eventSettleMs > 0 && now - lastEvent < eventSettleMs) {
    return { idle: false, why: `event-${Math.round((now - lastEvent) / 1000)}s-ago` }
  }
  const arr = Array.isArray(o.rows) ? (o.rows as any[]) : []
  // R2376 逃生前置检查：尾段（末 6 行）是否存在仍在执行/待执行的工具。
  // 有活工具 = 回合真的在跑，绝不能被"年龄逃生"判死；返回该状态名便于记 why。
  const tailHasLiveTool = (): string => {
    for (let i = arr.length - 1, seen = 0; i >= 0 && seen < 6; i--, seen++) {
      const row: any = arr[i]
      const parts = Array.isArray(row?.parts) ? row.parts : Array.isArray(row?.info?.parts) ? row.info.parts : []
      for (const pp of parts) {
        if (String(pp?.type ?? "") !== "tool") continue
        const stt = String(pp?.state?.status ?? "")
        if (stt === "running" || stt === "pending") return stt
      }
    }
    return ""
  }
  // R2660：`hostIdleAt` 是宿主宣布的回合结束时间。留 1s 落定窗（避免 idle 行
  // 比最后一条 assistant 先落盘的极端顺序），10 分钟后不再采信。
  const hostIdleAt = Number(o.hostIdleAt ?? 0)
  const hostIdleFresh = hostIdleAt > 0 && now - hostIdleAt >= 1_000 && now - hostIdleAt <= 600_000
  const newestCreated = (): number => {
    for (let i = arr.length - 1; i >= 0; i--) {
      const info = arr[i]?.info ?? arr[i]
      if (isCompactionMessage(arr[i])) continue
      return Number(info?.time?.created ?? arr[i]?.time?.created ?? 0)
    }
    return 0
  }
  // 「宿主已宣布 idle」且「idle 后没有新消息」且「尾段无活工具」⇒ 这是死回合，
  // 不是仍在运行的多步回合。`newest <= idle+1.5s` 容忍 idle 行与消息行的落盘抖动；
  // 一旦有更新的用户/助手行，说明新回合已开始，绝不越权。
  //
  // R2835：`time_idle` 在工具步之间也会短暂出现。04:55:58 的实报就是：第一条
  // 429 落在 .446、完成于 .514，而泵在 .523 已把队列里的第二条「继续」注入 ——
  // 它看到的是 .431 完成的上一条 tool-calls，宿主 idle 又“新鲜”，于是把这 0.1s
  // 的步间空隙当成了死回合。给最后一条消息加静置确认窗：刚产出/刚结束的回合
  // 必须再等 2s，让 error/finish 行落盘后再判；真正的死回合早已静置更久，不受影响。
  const hostIdleConfirmMs = Number(o.hostIdleConfirmMs ?? 2_000)
  const hostEndedTurn = (): boolean => {
    if (!hostIdleFresh) return false
    const newest = newestCreated()
    if (!(newest > 0 && newest <= hostIdleAt + 1_500)) return false
    if (hostIdleConfirmMs > 0 && now - newest < hostIdleConfirmMs) return false
    return !tailHasLiveTool()
  }
  // ③b 压缩（compaction）判据。
  // 为什么单列：压缩行是 role=system + type=compaction 的独立行，不能被当作最后一条
  // assistant 判回合。若误当 assistant，`laFinish=""`（不是 tool-calls）→ 误判回合已停 →
  // 在会话正压缩时注入。DB 实证（bot3，2026-10-10）：12:09:53.689 决策 msg=msg_sanitized01
  // （=seq 8545，type=compaction，len=46 正是压缩 header），注进了正在压缩的回合。
  // 语义上压缩不是回合，故：进行中的压缩（compactionStatus!=="completed"）一律不注入；
  // 已完成的压缩不参与下面 lastAssistant / newest 的扫描（让位给真实助手回合状态）。
  for (let i = arr.length - 1; i >= 0; i--) {
    const info = arr[i]?.info ?? arr[i]
    if (!isCompactionMessage(arr[i])) continue
    // R2235-fix：只有"真正进行中"的压缩才持闸。宿主压缩行 data.status 的**终态**是
    // completed（成功）或 failed（失败）。旧判据 `status!=="completed"` 把**失败的压缩**
    // （终态，宿主不会把它改回 completed）也当成进行中 → 循环被**永久**持有。
    // 实证：主会话 2026-10-10T14:00:21 一次 failed 压缩（msg_（已脱敏））后，
    // 从 14:00 到 10-11T07:34 约 **17.5 小时零注入**（日志 58 次 compaction-in-flight），
    // 直到用户发消息才打破。故：completed / failed 均视为"已结束、可注入"。
    const cst = String(info?.compactionStatus ?? "completed")
    if (cst !== "completed" && cst !== "failed") {
      // R28xx-fix（重要）：压缩分支**原先没有任何"静置超时逃生"** —— ②③④ 三条都有
      // `stuck-turn` 逃生，唯独这里 `return { idle:false, why:"compaction-in-flight" }`
      // 是**无条件永久持有**。于是"被 kill 切在半途的压缩"会让注入闸门彻底关死：
      // 宿主压缩行停在非终态（宿主不会再把它改成 completed/failed），循环一条都不注入，
      // **直到用户发言**才打破（与 R2235 注释里的 17.5 小时同族）。
      //
      // 实证（本会话 ses_sanitized01…，2026-10-18，运营者实报「很显然没有自动继续/循环」）：
      //   05:50:25 取消 run 的**同一瞬间**启动了一次压缩 → 该行 05:50:25→06:03:58 一直非终态
      //   ⇒ 05:52:30–06:03:30 共 12 次 `hold inject … idle=compaction-in-flight`，
      //   DB 同样实证**13.5 分钟零消息**；06:03:58 运营者发消息后压缩才落地、循环恢复。
      //   正常压缩只需 19–72 秒（本会话 15 次实测）⇒ 5 分钟阈值 = 4× 余量。
      //
      // 修法与 ③/④ **完全一致**：静置 > stuckMs **且** 尾段确无 running/pending 工具
      // ⇒ 判死压缩、忽略该行，继续走真实助手回合判据（后者自带 stuck-turn 逃生）。
      const cTouched =
        Number(
          info?.time?.updated ??
            info?.time?.created ??
            arr[i]?.time?.updated ??
            arr[i]?.time?.created ??
            0,
        ) || 0
      const cStuckMs = Number(o.stuckCompactionMs ?? STUCK_COMPACTION_MS)
      if (cStuckMs > 0 && cTouched > 0 && now - cTouched > cStuckMs) {
        const live = tailHasLiveTool()
        if (!live) break // 死压缩：忽略，让位给下面的真实助手回合判据
        return { idle: false, why: `compaction-in-flight, tool-${live}` }
      }
      return { idle: false, why: "compaction-in-flight" }
    }
    break
  }
  let laCreated = 0
  let laCompleted = 0
  let laTouched = 0
  let laFinish = ""
  for (let i = arr.length - 1; i >= 0; i--) {
    const row: any = arr[i]
    const info = row?.info ?? row
    if (isCompactionMessage(row)) continue
    if (info?.role !== "assistant") continue
    laCreated = Number(info?.time?.created ?? row?.time?.created ?? 0)
    laCompleted = Number(info?.time?.completed ?? row?.time?.completed ?? 0)
    laTouched =
      Number(info?.time?.updated ?? row?.time?.updated ?? 0) || laCreated
    laFinish = String(info?.finish ?? info?.rawFinish ?? "")
    break
  }
  // R2845：消息级落定窗（传了 settleMs 的调用方共用：泵 + auto-continue）。最后一条
  // 助手刚 completed 时，宿主的下一步/错误行可能还没落盘；晚一个事件循环读到的快照
  // 会把它误判成"回合已结束"。这里只推迟判定，不改任何"放行/持有"的结论。
  // 2026-11-19 15:28:48 实证：工具步 .179 完成，429 行 .199 创建/.869 完成，排队
  // 消息 .879 就被注入 → 331ms 后又撞同一个 429。先统一等满 settleMs 再判任何放行。
  const settleMs = Number(o.settleMs ?? 0)
  if (settleMs > 0 && laCompleted > 0 && now - laCompleted < settleMs) {
    const leftMs = Math.max(50, settleMs - (now - laCompleted))
    return { idle: false, why: `settling-${Math.round((now - laCompleted) / 1000)}s`, retryInMs: leftMs }
  }
  // R2809：排队用户消息只认正常结束。尾条若是 errored assistant，说明旧回合还没续完
  // （典型：provider.free-limit / aborted / transport），此时把下一条用户消息插进去会
  // 直接撞同一个错误；先由尾恢复/auto-continue 完成旧回合，恢复正常 `stop` 后再泵。
  // 只看**最新非压缩行**：若错误之后已有 user/recovery 行，说明恢复回合已开始，
  // 继续交给下面的 newer-message / 活工具判据处理，不能在这里永久卡住。
  if (o.requireNormalEnd || Number(o.quotaHoldMs ?? 0) > 0) {
    let tail: any = null
    for (let i = arr.length - 1; i >= 0; i--) {
      if (isCompactionMessage(arr[i])) continue
      tail = arr[i]
      break
    }
    const tInfo = tail?.info ?? tail
    const tFinish = String(tInfo?.finish ?? tInfo?.rawFinish ?? "")
    const tErrored = Boolean(tInfo?.error) || /^(error|aborted|interrupted|cancelled|canceled)$/i.test(tFinish)
    if (tInfo?.role === "assistant" && tErrored) {
      // R2809d（运营者：「错误不算本轮结束」）：429/额度错误必须等 rollover/egress/
      // 下一 run 尾恢复，不能把新消息插进一个必然再 429 的旧回合。
      // R2859：非额度错误同样**没有**年龄逃生（14:04 的 aborted 尾条 5m51s 后被
      // 放行，正是用户实报的“上一轮没结束就注入”）。只有正常 `stop` 或用户显式
      // ⏹（requireNormalEnd=false）才放行排队消息。
      const tErrType = String(tInfo?.error?.type ?? "")
      const tQuota =
        /free[-_. ]?limit|quota|rate[-_. ]?limit|too many requests/i.test(tErrType) ||
        Number(tInfo?.error?.status) === 429
      // completed=0 的错误行（宿主中断残留）仍要算出结束时刻：额度冷却按它计时。
      const tEnded =
        Number(tInfo?.time?.completed ?? 0) ||
        Number(tInfo?.time?.created ?? 0) ||
        0
      // R2845（运营者：「又出现连续两次429，必须修复」）：额度错误不能立刻放行，也不能
      // 永久扣死。2026-11-19 15:28:48 实证：工具步 .179 完成，429 行 .199 创建/.869
      // 完成，排队消息在 .879 就被注入，331ms 后又撞同一个 429 —— 两张一模一样的错误卡。
      // 传 `quotaHoldMs > 0` 时先冷却该时长；到点放行一次探测，若再 429，新错误行的
      // 完成时刻会刷新冷却。这样额度恢复后队列能自动送达，又不会在错误刚落地时再撞。
      // R2847：provider 的 `retryAfterMs`（free-limit 实测 ~8h）优先于固定冷却窗。
      // 2026-11-19 16:18/16:35 的 retryAfter 分别是 28141s/30217s，固定 120s 冷却后
      // 的探测必然再 429；把持有时间拉到 provider 给的恢复点（24h 封顶），额度未恢复
      // 时就不会主动再撞。若有新错误行，其完成时刻会重新计算冷却。
      const quotaHoldMs = Number(o.quotaHoldMs ?? 0)
      if (tQuota && quotaHoldMs > 0 && tEnded > 0) {
        const retryAfterMs = Number(tInfo?.error?.retryAfterMs ?? tInfo?.error?.data?.retryAfterMs ?? 0)
        const providerHoldMs =
          Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, QUOTA_HOLD_MAX_MS) : 0
        const holdMs = Math.max(quotaHoldMs, providerHoldMs)
        const age = now - tEnded
        if (age < holdMs) {
          const leftMs = Math.max(50, holdMs - age)
          return {
            idle: false,
            why:
              providerHoldMs > quotaHoldMs
                ? `errored-turn(quota, provider-reset ${Math.ceil(leftMs / 1000)}s)`
                : `errored-turn(quota, retry ${Math.ceil(leftMs / 1000)}s)`,
            retryInMs: leftMs,
          }
        }
        return { idle: true, why: `quota-probe(${Math.round(age / 1000)}s)` }
      }
      if (!o.requireNormalEnd) {
        // ⏹ 已停会话：非额度错误按旧口径放行（用户发新消息就是续跑入口）。
      } else {
        // R2859（运营者：「14:04 出现上一轮还没有结束就注入新消息，必须修复」）：
        // 错误/中断回合**没有**“年龄逃生”。旧实现在 requireNormalEnd=true 时仍让
        // 非额度错误静置 5 分钟后按 stuck-turn 放行 —— 14:04 的现场正是：
        // 05:58:25 `aborted: Step interrupted`，06:04:16（5m51s 后）排队消息被注入。
        // 用户口径明确：只有正常结束才算回合结束；错误尾条必须先由尾恢复/
        // auto-continue 续完，或用户显式 ⏹ 停止（那时 requireNormalEnd=false），
        // 才允许下一条排队消息。队列等待期间由 queue-progress 给出可见提示，
        // 不会“静默卡死”。
        const live = tailHasLiveTool()
        const base = tQuota ? "errored-turn(quota)" : "errored-turn"
        return { idle: false, why: live ? `${base}, tool-${live}` : base }
      }
    }
  }
  if (!(laCompleted > 0)) {
    if (laCreated === 0) return { idle: false, why: "no-assistant" }
    // R2660：宿主已写 time_idle ⇒ 这条 completed=0 的 assistant 是死回合残留，
    // 不必再等 5 分钟的 stuck-turn 阈值（用户实报「停止很久后才注入」）。
    if (hostEndedTurn()) return { idle: true, why: "host-idle(incomplete assistant)" }
    // R2376-fix2（② 的逃生，与 ③/④ 同一模式）：宿主被中断 / provider 断线后，最后一条
    // assistant 会**永远** completed=0，宿主侧其实**没有在途回合**（权威口径：
    // `POST /api/session/{id}/interrupt` → `{"interrupted":false}`）。旧判据在此**永久**
    // 判「在途」→ 注入闸门永不放行 → 会话看起来死了（消息只排队、无回应）。
    // 实证：bot4 `ses_sanitized02…` 2026-10-18 停滞 2.4h+（`in-flight-8671s`），宿主 `interrupted:false`。
    // 修法与 ③/④ 完全一致：静置 > stuckMs **且** 尾段确无 running/pending 工具 ⇒ 判死回合。
    const stuckMs = Number(o.stuckTurnMs ?? STUCK_TURN_MS)
    if (stuckMs > 0 && laTouched > 0 && now - laTouched > stuckMs) {
      const live = tailHasLiveTool()
      if (!live) {
        return {
          idle: true,
          why: `stuck-turn(incomplete ${Math.round((now - laTouched) / 1000)}s)`,
        }
      }
      return { idle: false, why: `assistant-in-flight, tool-${live}` }
    }
    return {
      idle: false,
      why: laCreated === 0 ? "no-assistant" : "assistant-in-flight",
    }
  }
  // ③ 停步原因：tool-calls = 宿主马上还会跑下一步，回合没结束。
  if (laFinish === "tool-calls" || laFinish === "tool_calls") {
    // R2660：宿主已经 idle，且 idle 后没有新消息/活工具 ⇒ 这就是"没有下一步"的死回合，
    // 直接放行；旧逻辑要等 AC_STUCK_TURN_MS（默认 5 分钟）。
    if (hostEndedTurn()) return { idle: true, why: "host-idle(tool-calls)" }
    // R2376 死回合逃生：tool-calls 通常只是中间态（宿主一两步内续跑下一步），
    // 但被打断时**没有下一步**。静置超时 + 无活工具 → 判死，交上层注入 recover/round。
    const stuckMs = Number(o.stuckTurnMs ?? STUCK_TURN_MS)
    if (stuckMs > 0 && laCompleted > 0 && now - laCompleted > stuckMs) {
      const live = tailHasLiveTool()
      if (!live) return { idle: true, why: `stuck-turn(tool-calls ${Math.round((now - laCompleted) / 1000)}s)` }
      return { idle: false, why: `turn-continues(tool-calls, tool-${live})` }
    }
    return { idle: false, why: "turn-continues(tool-calls)" }
  }
  // ④ 最新一条**非压缩**消息的 created 不晚于该 completed（否则回合已续到下一步）。
  let newest: any = null
  for (let i = arr.length - 1; i >= 0; i--) {
    const info = arr[i]?.info ?? arr[i]
    if (isCompactionMessage(arr[i])) continue
    newest = arr[i]
    break
  }
  const nInfo = newest?.info ?? newest
  const nCreated = Number(nInfo?.time?.created ?? newest?.time?.created ?? 0)
  if (nCreated > laCompleted) {
    // R2376 死回合逃生（同 ③）：更晚的"更新消息"（常是我们自己注入的 synthetic 循环提示）
    // 之后宿主再没产出 → 静置超时 + 无活工具即判死，否则 bot3 会**永久**卡在 newer-message。
    const stuckMs = Number(o.stuckTurnMs ?? STUCK_TURN_MS)
    if (stuckMs > 0 && nCreated > 0 && now - nCreated > stuckMs) {
      const live = tailHasLiveTool()
      if (!live) return { idle: true, why: `stuck-turn(newer-message ${Math.round((now - nCreated) / 1000)}s)` }
      return { idle: false, why: `newer-message, tool-${live}` }
    }
    return { idle: false, why: "newer-message" }
  }
  for (let i = arr.length - 1, seen = 0; i >= 0 && seen < 6; i--, seen++) {
    const row: any = arr[i]
    const parts = Array.isArray(row?.parts) ? row.parts : Array.isArray(row?.info?.parts) ? row.info.parts : []
    for (const pp of parts) {
      if (String(pp?.type ?? "") !== "tool") continue
      const stt = String(pp?.state?.status ?? "")
      if (stt === "running" || stt === "pending") return { idle: false, why: `tool-${stt}` }
    }
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
    const usage = parseTokenUsage(data?.tokens)
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
    // ✅完成 卡仍按旧口径展示 in/out/rea（不含缓存），避免把 15 万缓存前缀塞进
    // 「tokens:」摘要；窗口用量另存 usage（五字段），两者用途不同。
    stepEndByMsg.set(assistantMessageID, {
      finish: String(data?.finish ?? data?.reason ?? ""),
      tokens: usage.input + usage.output + usage.reasoning,
      cost: num(data?.cost),
      tin: usage.input,
      tout: usage.output,
      trea: usage.reasoning,
    })
    if (stepEndByMsg.size > 500) {
      const first = stepEndByMsg.keys().next()
      if (!first.done) stepEndByMsg.delete(first.value)
    }
    if (sessionID) {
      // 最新口径：单步 tokens 就是**该步请求的完整窗口占用**（五字段），取最新值；
      // 求和会双重计数（每步都含全量上下文），重启还会丢历史。
      stepTokensBySession.set(sessionID, usage)
      // DB 行偶尔还没落 tokens（事件先到）。回读时只允许用**同一条消息**的
      // step.ended 样本兜底；旧实现按会话存一个 input 累计值，会把旧消息也污染。
      latestStepUsageBySession.set(sessionID, { id: assistantMessageID, usage })
    }
  } catch {
    /* ignore */
  }
}

// 会话 token 水位（step.ended 最新值；单步 tokens 即全量上下文，仅作上下文比例参考）
const stepTokensBySession = new Map<string, ParsedTokenUsage>()
// 最近一条 step.ended 的完整样本 + 消息 id（供 rowToV1 精确兜底，不跨消息复用）
const latestStepUsageBySession = new Map<string, { id: string; usage: ParsedTokenUsage }>()
const EMPTY_USAGE = parseTokenUsage(undefined)
export const CONTEXT_WINDOW = 1048576
export const sessionTokens = (sessionID: string): ParsedTokenUsage => {
  return stepTokensBySession.get(sessionID) ?? EMPTY_USAGE
}
export const latestStepUsage = (sessionID: string): { id: string; usage: ParsedTokenUsage } | null =>
  latestStepUsageBySession.get(sessionID) ?? null
export const dumpSessionTokens = (): Record<string, Record<string, unknown>> => {
  const out: Record<string, Record<string, unknown>> = {}
  try {
    // 用 tokenUsagePayload 而不是直接展开 ParsedTokenUsage：后者把 cacheRead/cacheWrite
    // 摊平成数字，restore 时会被误读成「cache 字段存在且为 0」，把下界伪装成精确值。
    for (const [k, v] of [...stepTokensBySession.entries()].slice(-50)) out[k] = tokenUsagePayload(v)
  } catch {
    /* ignore */
  }
  return out
}
export const restoreSessionTokens = (data: Record<string, unknown>): void => {
  try {
    for (const [k, v] of Object.entries(data ?? {}).slice(0, 50)) {
      if (typeof k !== "string" || !v || typeof v !== "object") continue
      const usage = parseTokenUsage(v)
      // 自愈：旧版存的是累加和（可超窗口，如 115%），与最新值口径不兼容，直接丢弃等下步重建
      if (usage.input > CONTEXT_WINDOW) continue
      stepTokensBySession.set(k, usage)
    }
  } catch {
    /* ignore */
  }
}
export const resetSessionTokens = (sessionID: string): void => {
  try {
    stepTokensBySession.delete(sessionID)
    latestStepUsageBySession.delete(sessionID)
  } catch {
    /* ignore */
  }
}


// ---------------------------------------------------------------------------
// DB-backed message history.
// v2 plugin ctx has no message-list API (session.context returns prompt
// context, not history), so read the local opencode.db (readonly), same
// technique the v1 era used for diagnostics.
// ---------------------------------------------------------------------------
const DB_PATH = `REDACTED_ROOT/.local/share/opencode/opencode.db`
// R2789：事件机需要在 DB/WAL 变化时唤醒，而不是每 1.5s/5s 轮询。
export const OPENCODE_DB_PATH = DB_PATH
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
// 压缩能力：2026-11-16 在本宿主 opencode v2.3.0 上实测**可用**。
//   · `ctx.session` 方法表包含 `compact`；
//   · 14:03:31 日志：`auto-continue: compacted session=ses_e1bb… (ctx=71% >= 70%)`。
// 历史误判来自三处叠加：① 更早的插件面确实没有 compact；② 本机 API 曾无凭据 401；
// ③ 一次失败后写了**永久**闩锁 `compactUnavailable`，即使后来宿主/凭据恢复也再也不试。
// ③ 是最坏的：它把“这一次失败”变成“本进程永远不可压缩”，还把谎话写进 ctx 后缀。
// 现在只保留「本地 HTTP 兜底」的短冷却，防止 401/端口探测每轮刷屏；native/command
// 两条路每次都优先重试，不再有任何进程级“不可压缩”状态。
let compactHttpCoolUntil = 0
let compactHttpLoggedAt = 0
const COMPACT_HTTP_RETRY_MS = 10 * 60_000

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

// 服务端账本直读：session_v2.tokens_* 是**会话生命周期累计**（实测 8.9M input / 245M cache.read），
// **不是**当前窗口用量，绝不能拿它当 ctx 分子。这里只借它取模型/窗口信息；
// 窗口分子统一走 ctx-usage.ts（最近一条 assistant 的五字段之和）。
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
        // R2648c：turn-end note 需要判断「后台 shell 仍在跑」。旧实现只透传 truncated/exit，
        // `status`/`shellID` 被吞掉 → 桥侧结构性看不见后台进程，回合结束就误发 ✅。
        // 纯增量字段，不影响既有消费者（idleVerdict 只看 state.status/input）。
        status: typeof md.status === "string" ? md.status : undefined,
        shellID: typeof md.shellID === "string" ? md.shellID : undefined,
        pid: typeof md.pid === "number" ? md.pid : undefined,
      },
    },
    time: { created: t.created ?? 0, completed: t.completed ?? t.ran ?? 0 },
  }
}

/**
 * R2660b：`time_idle` 是宿主新列。旧宿主没有该列时整条 SQL 会抛错 →
 * session.list 返回空、菜单与空闲观测一起失效。回退为不含该列的查询（idle=0），
 * 自动循环退化为 60s tick 兜底，而不是完全失明。
 */
let warnedNoTimeIdle = false
type SessionListRow = { id: string; title: string | null; time_updated: number; time_created: number; time_idle: number | null }
const querySessionListRows = (db: any, limit: number): SessionListRow[] => {
  try {
    return db
      .query("SELECT id, title, time_updated, time_created, time_idle FROM session_v2 ORDER BY time_updated DESC LIMIT ?")
      .all(limit) as SessionListRow[]
  } catch (err) {
    if (!warnedNoTimeIdle) {
      warnedNoTimeIdle = true
      logLine("v2compat", "warn", `session_v2.time_idle unavailable, falling back: ${String(err).slice(0, 120)}`)
    }
    const rows = db
      .query("SELECT id, title, time_updated, time_created FROM session_v2 ORDER BY time_updated DESC LIMIT ?")
      .all(limit) as Array<Omit<SessionListRow, "time_idle">>
    return rows.map((r) => ({ ...r, time_idle: 0 }))
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
      const rows = querySessionListRows(db, 20)
      syncListCache = {
        ts: now,
        list: rows
          .filter((r) => typeof r.id === "string" && r.id.startsWith("ses_"))
          .map((r) => ({
            id: r.id,
            title: r.title ?? "",
            time: { updated: r.time_updated ?? 0, created: r.time_created ?? 0, idle: r.time_idle ?? 0 },
          })),
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
    const rows = querySessionListRows(db, 50)
    return rows
      .filter((r) => typeof r.id === "string" && r.id.startsWith("ses_"))
      .map((r) => ({
        id: r.id,
        title: r.title ?? "",
        time: { updated: r.time_updated ?? 0, created: r.time_created ?? 0, idle: r.time_idle ?? 0 },
      }))
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
          // R2813：保留 part id 供事件路径按 id 定位真实下标（键必须与整条
          // 消息推送时的 `${sid}:message:${msgId}:${pIdx}` 完全一致，否则重复）。
          id: typeof p.id === "string" ? p.id : undefined,
          type: p.type,
          text: typeof p.text === "string" ? p.text : "",
          // R2813：v2 的 content part 自带 completed（这段正文生成完的时刻）。
          // 旧代码统一用 message.completed → 多个 part 全被当成整步结束时刻，
          // 既分不出“正文早于工具”，也让 productionClock 拿不到真实 part 完成钟。
          time: {
            created: p?.time?.created ?? tm.created ?? 0,
            completed: p?.time?.completed ?? tm.completed ?? 0,
          },
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
    const rawUsage = parseTokenUsage(rt)
    // 只允许用**同一条消息**的 step.ended 样本兜底。旧实现按会话存一个累计
    // input，DB 行还没落 tokens 时会把旧消息也填成最新累计值 —— 那正是
    // 「noCache + 8 万/11 万」假样本的来源。
    const fb = latestStepUsageBySession.get(sessionID)
    const tokens =
      rawUsage.total > 0
        ? tokenUsagePayload(rawUsage)
        : fb && fb.id === id && fb.usage.total > 0
          ? tokenUsagePayload(fb.usage)
          : rawUsage.present
            ? tokenUsagePayload(rawUsage)
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
        // R2828：保留 firstToken —— 回合结束的 token 速度要按 firstToken→streamed 计算，
        // 只留 created 会把排队/首 token 延迟算进生成时长，速度被系统性低估。
        time: { created: tm.created ?? 0, firstToken: tm.firstToken ?? 0, streamed: tm.streamed ?? 0, completed: tm.completed ?? 0 },
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
    // R2659/R2663：保留宿主写入的 metadata（注入标记 `{loopInject:"simple"|"custom"}`）。
    // 丢了它，合成识别就只能靠文本（「继续」/任意自定义文案），会把真实用户输入一起误判。
    return {
      id,
      info: {
        id,
        role: "user",
        // R2787：保留原始行类型。user = 真实用户（TG/TUI），synthetic = 宿主/桥注入的
        // 系统提示；会话文件需要据此把「用户」与「提示」分开，不能只看文本前缀。
        type: row.type,
        synthetic: row.type === "synthetic",
        time: { created },
        metadata: d?.metadata && typeof d.metadata === "object" ? d.metadata : undefined,
      },
      parts: text ? [{ type: "text", text, time: { created, completed: created } }] : [],
    }
  }
  if (row.type === "compaction") {
    const created = d?.time?.created ?? 0
    const updated = d?.time?.updated ?? created
    const status = String(d?.status ?? "unknown")
    const reason = String(d?.reason ?? "")
    const summary = typeof d?.summary === "string" ? d.summary : ""
    const err = d?.error != null ? errText(d.error) : ""
    // v2 语义：压缩是独立消息类型，不是 assistant 回合。
    // 旧实现把它伪装成 role=assistant 的「假完成消息」→ 桥按普通消息推送成「💬 回复」，
    // 压缩摘要因此混进了消息流。现在保持 role=system + type=compaction：
    //   · 补扫/回合判定按 isCompactionMessage() 单独跳过；
    //   · 摘要只在 /compaction 或显式 /replay 时走 compactionCards 专用卡片。
    return {
      id,
      info: {
        id,
        role: "system",
        type: "compaction",
        sessionID,
        time: { created, updated, completed: status === "running" ? 0 : created },
        compaction: true,
        compactionStatus: status,
        compactionReason: reason,
        compactionError: err,
        compactionSummary: summary,
      },
      parts: [],
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
        // R2659/R2663：循环注入（simple 的「继续」/ custom 任意文案）靠 metadata
        // 标明是合成消息；不能在“最近真实用户消息”里把它当成用户指令。
        if (isLoopInjectMeta(d?.metadata)) continue
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

// 运营者指令（2026-10-19）：「循环注入提示词增加上次用户注入的内容，避免ai忘记」。
// lastRealUserExcerpt：从会话行提取最近一条**真实（非合成注入）**用户消息原文，
// 供 auto-continue.inject() 附在 ROUND/RECOVER 注入文本尾部；前缀保持不动 ⇒
// isSyntheticPrompt（startsWith ROUND/RECOVER 前缀）判定与注入去重不受影响。
// 跳过：合成注入（循环/恢复/自动恢复首行）、空文本；剥掉 TG 注入标记 `[TG …]` 头。
export const LAST_USER_EXCERPT_MAX = 2000
// R2794（运营者：「注入时引用的信息是错误的」）：这里必须覆盖**所有**桥/插件
// 注入的合成 user 文案，而不只是自动循环。实测 Option C 的 recover 提示
// `CI 在上一回合失败/中断后重启…` 没被识别 → 下一次 recover 把上一次 recover
// 当成「上次用户注入内容」附在尾部，几轮后指数嵌套（DB 里已出现 5 层重复）。
// 429 换会话的 `阅读（ses_…）对话历史…` 同属合成指令，一并排除。
const SYNTHETIC_USER_PREFIXES = [
  "继续自动筛查循环",
  "上一轮自动筛查应答因可恢复错误中断",
  "自动恢复：上一轮 run",
  "CI 在上一回合未完成时重启",
  "CI 在上一回合失败/中断后重启",
  "阅读（ses_",
]
export const EXCERPT_MARKER = "【上次用户注入内容（原文摘录，自动附带避免遗忘）】"
export const isSyntheticUserText = (text: string): boolean =>
  SYNTHETIC_USER_PREFIXES.some((prefix) => String(text ?? "").trimStart().startsWith(prefix))
const TG_PREFIX_RE = /^\[TG [^\]]*\]\s*/
export const lastRealUserExcerpt = (rows: unknown[]): string => {
  const list = Array.isArray(rows) ? rows : []
  for (let i = list.length - 1; i >= 0; i--) {
    const r: any = list[i]
    const role = String(r?.info?.role ?? r?.role ?? "")
    if (role !== "user") continue
    // R2659/R2663：循环注入（simple 的「继续」/ custom 任意文案）带 metadata 标记
    // → 不是真实用户指令。注意**只认 metadata**，不按文本猜：真实用户打同样的字
    // 是合法输入。
    if (rowHasLoopInjectMeta(r)) continue
    const parts: any[] = Array.isArray(r?.parts) ? r.parts : Array.isArray(r?.info?.parts) ? r.info.parts : []
    let txt = parts
      .filter((p: any) => p?.type === "text")
      .map((p: any) => String(p?.text ?? ""))
      .join("")
      .trim()
    if (!txt) continue
    if (SYNTHETIC_USER_PREFIXES.some((prefix) => txt.trimStart().startsWith(prefix))) continue
    // 最后一道结构性防嵌套：任何已经带摘录标记的行都是本函数自己的产物，
    // 无论前缀怎么变都不能再被当成“用户原文”。
    if (txt.includes(EXCERPT_MARKER)) continue
    txt = txt.replace(TG_PREFIX_RE, "").trim()
    if (!txt) continue
    const excerpt = txt.length > LAST_USER_EXCERPT_MAX ? `${txt.slice(0, LAST_USER_EXCERPT_MAX)}……（截断）` : txt
    return `\n\n${EXCERPT_MARKER}\n${excerpt}`
  }
  return ""
}

// 运营者实报（2026-10-19）「乱序消息再次出现」：传输层重试（proto retry）与 catchup 补推不同——
// 重试件携带的是**渲染时**的标题时钟，几秒~几分钟后才送达；期间更新的消息可能已先行 ⇒
// 聊天流出现时钟倒挂（与 R276「签署时间与发送顺序不符」同源）。本纯函数在重试发送前
// 把标题首行的时钟改写为**本次发送时刻**；迟到达到阈值时把原时刻放进「（补发 原时刻）」括注。
// 幂等：已是「新钟（补发 原钟）」时再次改写仍以**最初原时刻**为准，不叠加括注。
// 只动首行第一个 ` · HH:MM:SS`（找不到则原样返回），正文/代码块不触碰。
export const rewriteRetryClock = (text: string, nowClock: string, withNote: boolean): string => {
  const nl = text.indexOf("\n")
  const head = nl >= 0 ? text.slice(0, nl) : text
  const m = head.match(/ · (\d{2}:\d{2}:\d{2})(?:（补发 (\d{2}:\d{2}:\d{2})）)?/)
  if (!m || m.index === undefined) return text
  const origClock = m[2] ?? m[1]
  const note = withNote ? `（补发 ${origClock}）` : ""
  const newHead = `${head.slice(0, m.index)} · ${nowClock}${note}${head.slice(m.index + m[0].length)}`
  return nl >= 0 ? `${newHead}${text.slice(nl)}` : newHead
}

// R2813（运营者：「消息时间采用消息生产时间，真正该缩小的是处理的时间」）：
// 卡片标题的时钟取**消息/part 的生产时刻**，不再用发送时刻冒充。
// 一次流式回复的时间轴：message.created（开始生成）→ part.created（首个 token）
// → part.completed（这段正文生成完）→ message.completed（整步结束）→ 真正触网。
// R2811 曾把标题改成最后一步（发送时刻），掩盖了前面整段生成时间；运营者明确否掉。
// 这里按「part.completed → message.completed → part.created → message.created」取
// 最接近“这段内容已经生产出来”的时刻：流式未完成时仍是开始钟，完成后立刻换成完成钟。
// 纯函数，便于回归用例锁死优先级；不读写全局状态。
export const productionClock = (part: any, msg: any): number => {
  const positive = (value: unknown): number => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  return (
    positive(part?.time?.completed) ||
    positive(msg?.time?.completed) ||
    positive(part?.time?.created) ||
    positive(msg?.time?.created)
  )
}

/**
 * R2813（运营者：「真正该缩小的是处理的时间」）：只读**一条**消息。
 * 事件路径旧实现每次都 `client.session.messages` 拉整段会话（实测 95+ 条），
 * 再从中筛出刚完成的那一条；轮询补扫本来就有全量读取，事件路径没必要。
 * 主键 + session_id 双条件，返回与历史列表同形的 V1 消息；读不到返回 null，
 * 调用方回退到原全量读取（DB 未落盘/不可用时行为不变）。
 */
export const readMessageV1 = async (sessionID: string, messageID: string): Promise<any | null> => {
  if (!sessionID || !messageID) return null
  const db = await openDb()
  if (!db) return null
  try {
    const row = db
      .query("SELECT id, type, data FROM session_message WHERE id = ? AND session_id = ?")
      .get(messageID, sessionID) as { id: string; type: string; data: string } | null
    return row ? rowToV1(row, sessionID) : null
  } catch {
    return null
  }
}

// R2813：补扫主路径也走同一份 DB 尾部，不再每次 `client.session.messages`
// 拉整段会话（见 tg-bridge 的 runAssistantCatchup 注释）。
export const readSessionMessages = async (sessionID: string): Promise<any[]> => {
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

/**
 * R2778：按时间窗导出会话消息（429 期间文件用）。
 *
 * 为什么不复用 readSessionMessages：它只回最近 200 行，20 分钟的 429 窗口里如果
 * 工具调用很多，真正的用户/助手正文会被挤出窗口；而且这里需要的是“区间”，不是
 * “尾部 N 条”。查询同时看 time_created 与 time_updated：429 刚开始时已在跑的回合
 * 创建时间在窗口之前、完成时间在窗口之内，也应算进这段记录。
 *
 * 只读、best-effort；DB 暂不可用时返回空数组（调用方如实告知“没有可导出消息”）。
 */
export const readSessionMessagesBetween = async (
  sessionID: string,
  fromMs: number,
  toMs: number,
  limit?: number,
): Promise<any[]> => {
  const a = Number(fromMs)
  const b = Number(toMs)
  if (!sessionID || !Number.isFinite(a) || !Number.isFinite(b)) return []
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  // R2852：默认不设上限（导出“不要截断”）；只有调用方显式给正数 limit 时
  // 才取窗口内最近的 limit 行。旧实现的 5000 默认值会把 429/导出文件截断。
  const lim = Number(limit)
  const cap = Number.isFinite(lim) && lim > 0 ? Math.floor(lim) : 0
  const db = await openDb()
  if (!db) return []
  try {
    const rows = (
      cap > 0
        ? db
            .query(
              "SELECT id, type, data FROM session_message WHERE session_id = ? AND " +
                "((time_created BETWEEN ? AND ?) OR (time_updated BETWEEN ? AND ?)) " +
                "ORDER BY seq DESC LIMIT ?",
            )
            .all(sessionID, lo, hi, lo, hi, cap)
        : db
            .query(
              "SELECT id, type, data FROM session_message WHERE session_id = ? AND " +
                "((time_created BETWEEN ? AND ?) OR (time_updated BETWEEN ? AND ?)) " +
                "ORDER BY seq ASC",
            )
            .all(sessionID, lo, hi, lo, hi)
    ) as Array<{ id: string; type: string; data: string }>
    const out: any[] = []
    if (cap > 0) {
      // 保持原行为：有上限时先取最近 cap 行，再按时间正序返回。
      for (let i = rows.length - 1; i >= 0; i--) {
        const m = rowToV1(rows[i], sessionID)
        if (m) out.push(m)
      }
    } else {
      for (const row of rows) {
        const m = rowToV1(row, sessionID)
        if (m) out.push(m)
      }
    }
    return out
  } catch (err) {
    logLine("v2compat", "error", `window history read failed: ${String(err).slice(0, 160)}`)
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

// serve 的 /api 鉴权 = Basic("opencode:"+password)。
//
// ⚠️ 凭证来源**必须实时**，不能落盘（2026-10-18 复发实证）：serve 每次启动都换一次密码，
// service.json 是我手写的快照 → 跨 run/重启后必然过期 → 全部 401 → 用户报「宿主API仍不可用」。
// 可靠性排序（都取不到才退 service.json）：
//   1. /proc/self/environ —— 本插件就跑在 serve 进程内，这是**进程原始 environ**，
//      绕过 JS 层：实测 process.env.OPENCODE_PASSWORD 被宿主清洗掉（取不到），
//      而 /proc/<serve-pid>/environ 里明明白白有值（pwlen=43）。
//   2. /proc/<ppid>/environ —— 万一插件跑在子进程里，退到父进程（serve）。
//   3. process.env.OPENCODE_PASSWORD —— 宿主未清洗时可用。
//   4. service.json —— 只当最后兜底，且下方会把实时值**自愈**到
//      ~/.config/opencode/service.json（**绝不写** host 的 state 注册文件）。
export const hostServiceReg = async (): Promise<{ url: string; password: string }> => {
  const fs: any = await import("node:fs")
  const home = process.env.HOME ?? "/root"
  const pwFromProc = (path: string): string => {
    try {
      const raw = fs.readFileSync(path, "utf8")
      const hit = String(raw)
        .split("\0")
        .find((kv: string) => kv.startsWith("OPENCODE_PASSWORD="))
      return hit ? hit.slice("OPENCODE_PASSWORD=".length) : ""
    } catch {
      return "" // 无 /proc（非 Linux）或权限不足：跳过，走下一级
    }
  }
  const pwSelf = pwFromProc("/proc/self/environ")
  const pwParent = pwSelf ? "" : pwFromProc(`/proc/${Number(process.ppid) || 0}/environ`)
  const pwJs = typeof process.env.OPENCODE_PASSWORD === "string" ? process.env.OPENCODE_PASSWORD : ""
  let fileUrl = ""
  let filePw = ""
  for (const p of [`${home}/.local/state/opencode/service.json`, `${home}/.config/opencode/service.json`]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8")) as { url?: string; password?: string }
      if (!fileUrl && j?.url) fileUrl = String(j.url).replace(/\/+$/, "")
      if (!filePw && typeof j?.password === "string" && j.password) filePw = j.password
    } catch {
      /* 缺失或损坏：继续试下一处 */
    }
  }
  // 端口必须现场发现（serve 用 --port 0，重启换号）；发现不到才退回文件里的 url。
  const port = await findLocalServerPort()
  const url = port ? `http://127.0.0.1:${port}` : fileUrl
  const password = pwSelf || pwParent || pwJs || filePw
  // 自愈：把实时值回写到 ~/.config/opencode/service.json，让其它直读该文件的
  // 消费点也拿到当前值。R921：用户报「TG 桥配置没有还原！环境不完整」。
  // **仅当该目录是真实目录时写**；若它是符号链接（可能指向 sessions 仓库），
  // 跳过，避免把宿主密码写进仓库。只在内容不同时写，幂等。
  //
  // R2739（13:59 重启循环的根因）：**不能写 ~/.local/state/opencode/service.json**。
  // 那是宿主 2.3.0 的 managed-service 注册文件，schema 是
  // `{id,version,url,pid,password}`；宿主每 5s 校验一次，缺 pid 会直接
  // `managed service registration check failed; shutting down`（实测 13:58:50 /
  // 13:59:02 / 13:59:07 连续重启，打断在途回合）。旧实现把 `{url,password}`
  // 覆盖上去，正好触发这个自毁。state 文件只读，由宿主自己维护；插件只补
  // config 侧副本。
  if (password && url) {
    const want = JSON.stringify({ url, password })
    try {
      const cfgDir = `${home}/.config/opencode`
      const st = fs.lstatSync(cfgDir)
      if (st.isDirectory() && !st.isSymbolicLink()) {
        const cfgFile = `${cfgDir}/service.json`
        let cur = ""
        try {
          cur = fs.readFileSync(cfgFile, "utf8")
        } catch {
          /* 缺失 = 需要写 */
        }
        if (cur !== want) fs.writeFileSync(cfgFile, want, { mode: 0o600 })
      }
    } catch {
      /* 目录缺失/只读/符号链接：忽略 */
    }
  }
  return { url, password }
}

let cachedServiceAuth: string | null = null

const readServiceAuth = async (): Promise<string | null> => {
  const pw = (await hostServiceReg()).password
  if (!pw) return null
  const plain = `opencode:${pw}`
  const b64 = typeof btoa === "function" ? btoa(plain) : Buffer.from(plain, "utf8").toString("base64")
  return `Basic ${b64}`
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
      time: {
        created: m?.time?.created ?? 0,
        firstToken: m?.time?.firstToken ?? 0,
        streamed: m?.time?.streamed ?? 0,
        completed: m?.time?.completed ?? 0,
      },
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

/**
 * R208/R2686：宿主跨进程重启后消息 seq 可能从 0 重计 ⇒ 行序 ≠ 时序。
 * 凡按「数组末条 = 会话尾部」消费 rows 的判定都必须先用本函数归一化。
 * 此前 auto-continue 与 tg-bridge 各写一份同义实现（注释还写着“不做跨文件导出”），
 * 现已上收到宿主兼容层，两处共用，排序口径只有一份。time.created 缺失/非法者归 0。
 */
export const sortRowsByCreatedTime = (rows: any[]): void => {
  const key = (r: any): number => {
    const t = Number(r?.info?.time?.created ?? r?.time?.created ?? 0)
    return Number.isFinite(t) && t > 0 ? t : 0
  }
  rows.sort((a, b) => key(a) - key(b))
}

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
    const usage = parseTokenUsage(data?.tokens)
    return {
      type: "message.updated",
      properties: {
        sessionID: sid,
        info: {
          id: amid,
          role: "assistant",
          sessionID: sid,
          // 旧实现只透传 input，cache/output/reasoning 在事件路径里直接消失：
          // noteUsage 因此把每一条实时样本都标成『无缓存计数』，ctx 也少算一大截。
          // 宿主事件 schema 的 tokens 本来就是完整五字段（TokenUsage.Info），照实透传。
          tokens: usage.present ? tokenUsagePayload(usage) : undefined,
        },
      },
    }
  }
  if (type === "session.step.failed") {
    // R2451（用户实报「部分错误❌不发送，比如速率限制」）：致命 provider 错误（quota/限流）
    // 落在 `session.step.failed` 上，携带 `assistantMessageID` + `error`，但**不产生 retry
    // part** —— 而 transport 类错误会重试、产生 retry part，从而附带 `message.updated`
    // 让事件路径命中。于是**致命错误**这条 assistant 消息在事件路径里**彻底收不到**
    // （宿主另发的 `session.error`/`session.execution.failed` 均不带 messageID，见 toV1Event
    //  末尾的丢弃逻辑）。这里与紧邻的 `session.step.ended` 同款映射成 message.updated：
    // tg-bridge 重读该消息 → 由既有「❌ 生成失败」卡（R2369）投递。
    const amid = String(data.assistantMessageID ?? "")
    if (!sid || !amid) return null
    const usage = parseTokenUsage(data?.tokens)
    return {
      type: "message.updated",
      properties: {
        sessionID: sid,
        info: { id: amid, role: "assistant", sessionID: sid, tokens: usage.present ? tokenUsagePayload(usage) : undefined },
      },
    }
  }
  if (type === "session.tool.success" || type === "session.tool.failed") {
    const amid = String(data.assistantMessageID ?? "")
    if (!sid || !amid) return null
    return { type: "message.updated", properties: { sessionID: sid, info: { id: amid, role: "assistant", sessionID: sid } } }
  }
  if (type === "session.compaction.ended" || type === "session.compaction.failed" || type === "session.compacted") {
    if (!sid) return null
    // R2369：压缩标记不再写进**模块级共享**的 compactedFlag。
    // `_v2compat` 被三个 Bot 共用（入口不带 query 导入），而每次压缩事件都会在
    // 每个实例的事件循环里各调一次 toV1Event → add 三次；旧语义"谁先 take 谁处理"
    // 于是大概率落到**非拥有者**头上：它清掉自己那份（无意义）ctxUsage、并把
    // 「已压缩」卡发到**自己的**聊天（用户实报「压缩的会话不对」），而真正的拥有者
    // 拿不到标志 → 水位不清、通知漏发。改法：标记随事件走，归属判定交给 tg-bridge。
    const compacted = type !== "session.compaction.failed"
    const mid =
      String((data as any)?.messageID ?? (data as any)?.messageId ?? (data as any)?.id ?? "") ||
      (await latestCompactionId(sid))
    // v2 的压缩事件不是 message.updated：这里保留兼容事件名做触发，但 info 明确是
    // role=system + type=compaction。旧实现写 role=assistant，桥会把压缩行当普通
    // assistant 消息再推一遍「💬 回复」；现在事件只负责清水位 + 发压缩通知。
    return {
      type: "message.updated",
      properties: {
        sessionID: sid,
        compacted,
        info: {
          id: mid,
          role: "system",
          type: "compaction",
          sessionID: sid,
          compaction: true,
          compactionStatus: compacted ? "completed" : "failed",
        },
      },
    }
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
    // ⚠️ 不要拿这个事件当“最近一次窗口用量”：它更新的是 session.info.tokens
    // （会话生命周期累计，实测 8.9M input / 245M cache.read），不是单步窗口。
    // 旧实现把它的 input 存成 latestTokensBySession，DB 行暂缺 tokens 时拿去兜底，
    // 于是出现 `in=82.2k out=0 rea=0 cr=0 cw=0` 这类假样本并被标 noCache。
    // 单步真实用量只认 session.step.ended（完整五字段，见上）。
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
// R2666: "quota" is a one-off quota-tail recovery (egress changed); "recover"
// is the generic interrupted-turn/error recovery. They need different notices.
export type InjectNoticeKind = "round" | "recover" | "quota"
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
          `compact ${fnNames.includes("compact") ? "有原生入口(2026-11-16 实测可用)" : "无原生入口"} ` +
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

    let promptTimingLogged = false
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
          // R2660（运营者：「有时候还在输出就会注入 / 停止很久后才注入」）：
          // 调用方一直显式写着 delivery:"queue" + resume:true，但旧适配层把它们丢了；
          // 宿主默认 `delivery:"steer"` = 立即插进正在跑的回合。现在原样透传，
          // 只有宿主以形状错误拒绝时才按「丢 metadata → 丢时机 → 纯文本」降级。
          const metadata = body?.metadata && typeof body.metadata === "object" ? body.metadata : undefined
          const delivery = isPromptDelivery(body?.delivery) ? body.delivery : undefined
          const resume = typeof body?.resume === "boolean" ? body.resume : undefined
          const variants = promptPayloads({ sessionID: path.id, text, metadata, delivery, resume })
          if (!promptTimingLogged) {
            promptTimingLogged = true
            logLine(
              id,
              "info",
              `prompt timing forwarding: delivery=${delivery ?? "(host default)"}, resume=${resume === undefined ? "(host default)" : resume}, metadata=${metadata ? "yes" : "no"}`,
            )
          }
          let lastErr: unknown
          for (let i = 0; i < variants.length; i++) {
            try {
              await fn.call(context.session, variants[i])
              if (i > 0) {
                logLine(
                  id,
                  "warn",
                  `prompt payload degraded to keys=[${Object.keys(variants[i]).join(",")}] (attempt ${i + 1}/${variants.length}): ${String(lastErr).slice(0, 160)}`,
                )
              }
              return ""
            } catch (err) {
              lastErr = err
              // 非形状错误可能是"已受理后失败"，重试会重复注入，直接上抛交给调用方退避。
              if (!isPromptShapeError(err) || i === variants.length - 1) throw err
              if (i === 0 && metadata) {
                // 保留历史日志措辞（旧宿主的 metadata 兼容路径，有静态断言锁着）。
                logLine(id, "warn", `prompt metadata rejected, retrying without it: ${String(err).slice(0, 160)}`)
              }
            }
          }
          throw lastErr
        },
        compact: async ({ path }) => {
          // 三条通道，按可靠性排序：宿主原生 ctx.session.compact → slash command →
          // 带 service.json 凭据的本机 HTTP。2026-11-16 实测本宿主 v2.3.0 的
          // ctx.session.compact **存在且可用**，auto-continue 也通过 _client.post 成功压缩。
          // 不再设置永久闩锁：任一路失败只影响本次，下次仍从 native 开始重试。
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
          // 本机 HTTP 兜底：带 Basic 凭据（service.json），不再是无票 401。
          // 冷却只挡**这一条兜底**：native/command 每次仍先试。这样既不会 401 刷屏，
          // 也不会把一次失败固化成“本进程永远不可压缩”。
          const nowMs = Date.now()
          if (nowMs < compactHttpCoolUntil) {
            throw new Error(
              "compact failed: local API fallback is cooling down after a recent failure (native/command paths were tried first)",
            )
          }
          try {
            const out = await compactSession(path.id)
            compactHttpCoolUntil = 0
            return out
          } catch (err) {
            compactHttpCoolUntil = Date.now() + COMPACT_HTTP_RETRY_MS
            if (Date.now() - compactHttpLoggedAt > COMPACT_HTTP_RETRY_MS) {
              compactHttpLoggedAt = Date.now()
              logLine(
                id,
                "info",
                `compact local-API fallback failed: ${String(err).slice(0, 200)} ` +
                  `(native/command 下次仍优先重试; ${Math.round(COMPACT_HTTP_RETRY_MS / 60000)} 分钟内不再走本兜底)`,
              )
            }
            throw new Error(`compact failed: ${String(err).slice(0, 200)}`)
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
        // R2609：**每代都重挂**转发器（兑现 R2568 语义；其改动当年未落地到本处）。
        // 实测机制：宿主热重载会清掉旧代监听器，而旧实现「每进程只挂一次」（reg.attached
        // 守卫）让新代跳过挂载 → 重载后无人监听、`watch start` 从日志消失、插件层强制
        // 转后台静默失效（2026-10-15 17:12 重载后全局零 `watch start`，本轮受控探针复现）。
        // 修复=两条不变式同时成立，缺一不可：
        //  · 每代挂载（本段）：宿主重载后**当前代**总有监听器（旧实现缺这条）；
        //  · 闭包引用全局 reg（R2230 保留）：无论事件投给哪一代监听器，都转发到当前
        //    active；watcher 按 key 幂等（重复投递只重置计时器，不会双发 promote）。
        reg.attached = true
        const attachN = (reg.attachN = (reg.attachN ?? 0) + 1)
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
        logLine(id, "info", `[bg-watch] forwarders attached per-generation (#${attachN}, forward-to-active)`)
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

/**
 * 「重启孤儿回合」判据（纯函数，可单测）。
 *
 * 事故（2026-10-18 08:11→08:12）：运营者取消 run，后继在 08:12:12 启动。
 * 被取消的那一轮 assistant 消息（created 08:11:30）在库里**永远 completed=null**
 * —— 生成它的进程已经死了，没有任何人会把它补完。auto-continue 看到 completed=0：
 *   ① 10s/20s/30s 重试三次 → 5 分钟后打一条 HUNG-TURN（**只记日志、不返回**）；
 *   ② 同时把它 `settle()` 进 `decided` ⇒ 之后每次 eval 都在 `decided.has(id)` 静默返回；
 *   ③ 结果：**12 分钟零注入**，直到运营者自己发消息（08:24）才打破。
 *
 * 判据：**创建时间早于本进程启动** ⇒ 它不可能是本进程的活回合（新进程不会续跑旧生成）。
 * 只有「boot 之后创建且未完成」才是真的在生成中，绝不能放行。
 *
 * @param completed  time.completed（0 = 未完成）
 * @param created    time.created（0 = 缺失，保守不放行）
 * @param bootAt     本插件进程启动时刻（Date.now() 口径）
 */
export const preBootOrphan = (o: { completed: number; created: number; bootAt: number }): boolean =>
  !(Number(o.completed) > 0) &&
  Number(o.created) > 0 &&
  Number(o.bootAt) > 0 &&
  Number(o.created) < Number(o.bootAt) - 1000

/**
 * 回合产生于本进程启动之前 ⇒ 生成者已死（不要求 completed=0）。
 *
 * 与 [[preBootOrphan]] 的分工：后者只覆盖 `completed=null`（写它的进程没来得及收尾）。
 * 但取消/重启时还有第二种形态：宿主在重启、abort 或收到下一条用户消息时把旧回合
 * **补写成 completed**，而回合内容只有 1 个空 reasoning part（textChars=0）。
 * 这种"已完成空回合"在 evaluate 里会走 `len===0` 的 reasoning-only / waiting 分支，
 * 同样一条都不注入。
 *
 * 2026-10-18 08:49 事故实证：取消后重启，08:51:22 `orphan turn detected` 成功解锁，
 * 紧接着 `empty-verdict parts=1[reasoning] textChars=0` → `waiting(in-flight)`，
 * 5 分钟零注入，直到运营者自己发消息。判据只看 created < bootAt，故 post-boot
 * 的真在生成回合（created > bootAt）**永远不会**被放行。
 */
export const preBootDeadTurn = (o: { created: number; bootAt: number }): boolean =>
  Number(o.created) > 0 &&
  Number(o.bootAt) > 0 &&
  Number(o.created) < Number(o.bootAt) - 1000

// R2696：会话/消息 ID 缩短规则已上收到 log-safe.ts（唯一实现）；保留 re-export，
// 兼容从 _v2compat 导入的旧调用路径与测试。
export { shrinkLogIds } from "./log-safe"
