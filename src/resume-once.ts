/**
 * Option C（用户指令）：CI 重启后的「一次性续跑」。
 *
 * 与 auto-continue 完全分开：
 *   · auto-continue 是**持续循环**：front/pinned 默认入循环，直到 /loop stop；
 *   · 本插件只在 workflow 显式给出 `RESUME_ONCE_SIDS` 时运行，每个会话每次 CI
 *     run 最多注入一次，用来接回「上一进程被杀时正在跑/刚失败」的回合。
 *   · R2624：workflow 现在会 arm 每个 Bot 的 front/pinned（不再只 arm 本轮
 *     `--session` 打开的那一个），各会话仍独立过下面全部闸门。
 *
 * 判定顺序（纯函数 decideBootResume，可单测）：
 *   1. 用户按过 ⏹（halted）→ 永不续跑（force / 换出口都不能越过）；
 *   1.5 R2805（运营者：「停止只是循环，尾恢复是为了完成输出，不一样」）：
 *      单 Bot `/loop stop` **只停自动循环**，不再拦尾恢复。旧 R2785 把 stop
 *      当硬闸，进程重启后上一段被 429/transport 打断的输出就永远丢下；真正的
 *      硬闸是 halted（⏹）；provider 额度闸门只拦 rollover seed successor。
 *      stop 只影响自动循环的 autoLoopActive 判定；尾恢复仍受每 run 一次认领
 *      约束，恢复成功后不会重新开启循环。
 *   2. pre-boot assistant 的 quota/429 尾条 + 本轮出口已变化
 *      （RESUME_ONCE_QUOTA_RECOVER=1）→ **不受 `/loop off` / 自动循环活跃限制**，
 *      用 recover 文案续一次。额度尾恢复是跨 CI 的一次性恢复，不是循环的一部分；
 *      仍受 halted / 每 run 一次认领 / boot 后已有活动约束。
 *      R2681：宿主在**自动压缩阶段**撞 429 时不会产生 assistant 错误行，尾条是
 *      `compaction(failed)` + `idle(outcome=failed)`；这类宿主合成尾条也按额度
 *      尾条处理，否则 `/loop off` 的会话会永远接不住压缩阶段的 429。
 *   3. `/loop off`（loop-sessions-off）→ 不再续跑（quota 尾条已在第 2 步放行；
 *      R2771：pre-boot assistant 的 **error 尾条**也放行 —— 重启打断的回合
 *      不是循环，不能因 /loop off 就永远停在半路；halted 仍是硬闸）；
 *   4. 自动循环仍活着（loop-ctl 没关、会话没被 off/halted）→ 默认跳过，避免和
 *      auto-continue 双重注入；只有 RESUME_ONCE_FORCE=1 才越过这一道；
 *   5. 尾条是 boot 之后的新消息 → 本 run 已经有活动，跳过；
 *   6. 尾条是 pre-boot 用户消息（未得到回复）→ 续一次；
 *   7. 尾条 assistant 的 error 是 quota/429/rate-limit（出口没变）→ 跳过；
 *      abort/transport/其它错误 → 续一次（recover 文案）；
 *   8. pre-boot 孤儿回合（completed 缺失）、死回合（completed 但无正文/工具）、
 *      未完成工具、finish=tool-calls/length → 续一次（continue 文案）；
 *   9. 正常完成的回合 → 不续（重启本身不是继续干活的理由）。
 *
 * 「每次 run 一次」用 `$RUNNER_TEMP/resume-once-<sid>.json` 的 `wx` 独占创建
 * 做跨实例认领：热重载 / TUI+serve 双进程同时求值时，只有一个能真正注入。
 * RUNNER_TEMP 每个 GitHub run 都不同，relay 到下一 run 后自然重新获得一次机会。
 */
import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { lastRealUserExcerpt, preBootOrphan, fireInjectNotices } from "./_v2compat"
// R2838：孤儿判据必须用宿主进程启动时刻；插件热重载会重置插件 boot，
// 重载前 1~2s 创建的活回合不能被续跑。
import { HOST_BOOT_AT } from "./host-boot"
import { readHaltRelease } from "./halt-release"
import { QUOTA_429_EVIDENCE_PATH, isRateLimitError, loopGateStopped, providerQuotaGate, resolveExtraTargetPaths } from "./auto-continue"
import { watchFile } from "./fs-events"
import { writeQuotaRecoverLast } from "./quota-recover"
import { claimQuotaTail, quotaTailOwner, releaseQuotaTail } from "./quota-tail-marker"
// R2686：路径/会话 ID/容错读/loop-ctl 读取统一走共享核。
import { HOME, STATE_DIR, TG_STATE_PATH, SID_RE, readJson, readLoopCtl } from "./state-io"
// R2833：版本号统一由 version.ts 提供；每轮与 loop-state 最新轮次一致。
import { BRIDGE_VERSION as RESUME_ONCE_VERSION } from "./version"

const LOOP_OFF_PATH = `${STATE_DIR}/loop-sessions-off.json`
const PREBOOT_MARGIN_MS = 1000
// 让运行日志能证明“本轮确实加载了 Option C”，而不是只看仓库文件。
// R2624：workflow 现在会 arm 每个 Bot 的 front/pinned（不再只 arm 本轮打开的
// 那一个会话）；每个会话仍独立走 decideBootResume 的 halted/loop-off/quota 闸门。
// R2664：quota 尾条在 loop-off/循环活跃之前单独放行；halted 仍是硬闸。
// R2665：CI 侧只把「可执行的 429 rollover」当作排斥条件；等待循环/已 halted/
// Bot 离线的 rollover 请求不再全局关闭额度尾恢复，也不再阻止该会话被 arm。
// R2666：额度尾恢复单独上报 kind=quota，桥据此发一条可见 TG 提示。
// R2676（运营者选定 fix 1）：额度尾恢复与 auto-continue 在本 run 内**互斥**，
// 用 message-id 级标记（quota-tail-marker.ts）只挡同一条 pre-boot 429 尾，
// 不设时间限制，也不挡后续新 429 / 新轮次。
// R2681：压缩阶段的 429 尾条在宿主里是 compaction/idle 行，不是 assistant 行；
// 额度旁路必须同时识别这两种宿主合成行，否则 /loop off 会直接 skip。
// R2833：版本号来源见文件顶部 `BRIDGE_VERSION`（统一维护，每轮更新）。

export const RESUME_ONCE_PROMPT = `CI 在上一回合未完成时重启，已恢复同一会话。请从中断处继续（仅此一次，不要开启自动循环）：

1. 用一两句话说明上次进行到哪一步；无法判断就说“无法判断中断点”。
2. 继续完成被中断的任务；不要重复已完成部分，不要重扫项目。
3. 完成后给出结果并停止，等待用户下一步；不要输出 [STATUS: CONTINUE]，也不要自行开始新循环。`

export const RESUME_ONCE_RECOVER_PROMPT = `CI 在上一回合失败/中断后重启，已恢复同一会话。请只做一次恢复性续跑（不要开启自动循环）：

1. 检查上一轮错误是否仍在；可恢复就从中断处继续。
2. 不要重复已完成部分。
3. 错误仍在（如 provider 不可用）就用一两句话报告并停止，不要反复重试；不要输出 [STATUS: CONTINUE]。`

export type ResumePromptKind = "continue" | "recover"

export type BootResumeVerdict = {
  resume: boolean
  reason: string
  prompt: ResumePromptKind
  messageID?: string
}

export type BootResumeInput = {
  sid: string
  rows: unknown[]
  /** 本插件实例启动时刻：用于 per-run 的 post-boot 活动 / 额度语义。 */
  bootAt: number
  /**
   * R2838：宿主进程启动时刻，仅用于 pre-boot 孤儿判定。热重载不改变它；
   * 缺省时退回 bootAt（测试/旧调用保持原行为）。
   */
  hostBootAt?: number
  halted?: boolean
  /** R2785：该会话所属 Bot 已被 `/loop stop`（loop-ctl bots[].stopped）。 */
  gateStopped?: boolean
  loopOff?: boolean
  autoLoopActive?: boolean
  force?: boolean
  /** R2626：workflow 已确认新出口与上一轮不同；只影响 quota 尾条，不越过其它闸门。 */
  quotaRecover?: boolean
  /** R2790/R2806：provider 账号级额度耗尽（与出口无关）；只拦待恢复的 rollover seed。 */
  providerQuotaBlocked?: boolean
  providerQuotaResetAt?: number
  /**
   * R2797：本会话是 429 rollover 刚创建的新会话。种子提示词的首个回合若撞 429，
   * successor 会因为「pre-run 错误 + 已停 Bot」直接变成 DOA；这里允许恰好一次
   * recover（attempts<1），但仍受 ⏹ halted / provider 额度闸门约束。
   */
  rolloverSeed?: RolloverSeed | null
  claimed?: boolean
  now?: number
}

/** R2797：tg-bridge 在 rollover 创建新会话后写入的种子标记（跨 CI run 持久）。 */
export type RolloverSeed = {
  sid: string
  oldSid?: string
  at: number
  run?: string
  bot?: string
  attempts?: number
  userInitiated?: boolean
  manual?: boolean
}

/** workflow 传入的会话列表：逗号分隔、去重、只接受 ses_ 形状。 */
export const parseResumeOnceSids = (raw: string | undefined): string[] => {
  const out: string[] = []
  for (const part of String(raw ?? "").split(",")) {
    const sid = part.trim()
    if (!SID_RE.test(sid) || out.includes(sid)) continue
    out.push(sid)
  }
  return out
}

const rowInfo = (r: any): any => (r?.info && typeof r.info === "object" ? r.info : r) ?? {}
const rowType = (r: any): string => String(rowInfo(r)?.type ?? r?.type ?? "")
// 与 auto-continue 的 rowRoleOf 同口径：宿主合成行（idle/compaction）没有 role，
// 但顶层/info 里有 type；不回落就会把 429 尾条当成 unknown。
const rowRole = (r: any): string => String(rowInfo(r)?.role ?? r?.role ?? rowType(r))
const rowCreated = (r: any): number => {
  const n = Number(rowInfo(r)?.time?.created ?? r?.time?.created ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}
const rowParts = (r: any): any[] =>
  Array.isArray(r?.parts) ? r.parts : Array.isArray(r?.info?.parts) ? r.info.parts : []
const rowText = (r: any): string =>
  rowParts(r)
    .filter((p: any) => p?.type === "text")
    .map((p: any) => String(p?.text ?? ""))
    .join("")

const errorText = (e: unknown): string => {
  if (e == null || e === "") return ""
  if (typeof e === "string") return e
  const msg = typeof (e as any)?.message === "string" ? (e as any).message : ""
  let json = ""
  try {
    json = JSON.stringify(e)
  } catch {
    /* unserializable */
  }
  return [msg, json && json !== "{}" && json !== "null" ? json : ""].filter(Boolean).join(" ")
}

const hasUnfinishedTool = (parts: any[]): boolean =>
  parts.some((p: any) => {
    if (String(p?.type ?? "") !== "tool") return false
    const status = String(p?.state?.status ?? p?.status ?? "")
    return status === "running" || status === "pending"
  })

const sortByCreated = (rows: unknown[]): any[] => {
  const list = Array.isArray(rows) ? (rows.filter((r) => r && typeof r === "object") as any[]) : []
  // 与 auto-continue 同口径：宿主跨进程重启后 seq 可能重排，必须用 created 归一时序。
  list.sort((a, b) => rowCreated(a) - rowCreated(b))
  return list
}

/**
 * R2804/R2805：找出「真正的尾条」。
 *
 * 宿主在失败回合后还会补写 idle 行，顺序可能是
 *   assistant(error) → idle(failed, error) → idle(succeeded)
 * 只取最后一行会把失败回合伪装成干净空闲，尾恢复永远不触发。这里只回溯
 * 尾部连续的 idle/compaction 边界行：
 *   · 其中任一行带 error → 用它（若紧邻的 assistant 也带 error，优先 assistant，
 *     因为错误分类、abort/transport 文案和 messageID 都在 assistant 行上）；
 *   · 全是干净边界行且紧邻的真实回合是带 error 的 assistant → 用 assistant；
 *   · 否则保持原尾部（干净 idle 仍是正常结束）。
 */
const effectiveTail = (rows: any[]): any => {
  const last = rows[rows.length - 1]
  let i = rows.length - 1
  while (i >= 0) {
    const t = rowType(rows[i])
    if (t !== "idle" && t !== "compaction") break
    const e = rowInfo(rows[i])?.error ?? rows[i]?.error
    if (e) {
      const prev = i > 0 ? rows[i - 1] : null
      if (prev && rowRole(prev) === "assistant" && (rowInfo(prev)?.error ?? prev?.error)) return prev
      return rows[i]
    }
    i--
  }
  if (i >= 0 && rowRole(rows[i]) === "assistant") {
    const e = rowInfo(rows[i])?.error ?? rows[i]?.error
    if (e) return rows[i]
  }
  return last
}

/**
 * R2797：seed 之后出现过几条 prompt 行（user/synthetic）。
 * DOA 场景只有 rollover 注入的那一条；若用户随后又发了真实消息，或 auto-continue
 * 已经续过一次，这里会 >1，种子恢复必须让位给正常路径。
 */
const countSeedPromptTurns = (rows: any[], seedAt: number): number => {
  let n = 0
  for (const r of rows) {
    if (rowCreated(r) < seedAt - PREBOOT_MARGIN_MS) continue
    const role = rowRole(r)
    if (role === "user" || role === "synthetic") n++
  }
  return n
}

/**
 * R2814（运营者：「先修429换会话问题，全面排查」）：seed 标记只在
 * **种子的第一回合确实 429** 时才有意义。2026-11-18 20:37 事故里，e104
 * 是 17:28 创建并健康运行了 3 小时的 successor，seed 文件却因为 bridge 直接
 * 注入种子提示、没有消耗 attempts 而一直 attempts=0；CI 写入器只看到这个
 * 24h 内的标记，就把正常的额度耗尽当成 synthetic seed 429，跳过换会话。
 *
 * 这里把「DOA seed」定义成可验证的三条：attempts=0（一次性恢复还没用掉）、
 * seed 之后最多只有一条 prompt（没有被用户/自动循环续过）、且没有任何
 * 已完成的无错 assistant 回合（种子回合没有成功过）。只要有一条不成立，
 * 标记就不再拥有阻止换会话/限制 provider 闸门的权力。
 */
export const rolloverSeedStillDoa = (rows: any[], seed: RolloverSeed | null): boolean => {
  if (!seed) return false
  const at = Number(seed.at ?? 0)
  const attempts = Math.max(0, Math.trunc(Number(seed.attempts ?? 0) || 0))
  if (!(at > 0) || attempts >= 1) return false
  if (countSeedPromptTurns(rows, at) > 1) return false
  for (const r of rows) {
    if (rowCreated(r) < at - PREBOOT_MARGIN_MS) continue
    if (rowRole(r) !== "assistant") continue
    const info = rowInfo(r)
    if (info?.error ?? r?.error) continue
    const completed = Number(info?.time?.completed ?? r?.time?.completed ?? 0)
    if (completed > 0) return false
  }
  return true
}

const skip = (reason: string): BootResumeVerdict => ({ resume: false, reason, prompt: "continue" })
const go = (reason: string, prompt: ResumePromptKind, messageID?: string): BootResumeVerdict => ({
  resume: true,
  reason,
  prompt,
  messageID,
})

/** R2626/R2664：把 assistant 错误归一成「是否 quota/429」+ 供 abort/transport 分类的文本。 */
const rateLimitProbe = (err: unknown): { hit: boolean; probe: string; status: number } => {
  const obj: any = typeof err === "object" ? err : null
  const name = String(obj?.name ?? obj?.type ?? "")
  const status = Number(obj?.status ?? obj?.statusCode ?? obj?.data?.status ?? obj?.data?.statusCode ?? 0) || 0
  const text = errorText(err)
  // 错误名可能是无空格的 CamelCase（FreeUsageLimitError / QuotaExceededError）。
  // isRateLimitError 的词表按空格分词；不归一化时“只有错误名、没有正文”的额度
  // 错误会被当成普通错误 → 继续注入 → 再撞一次 429（正好违反 Option C 的跳过约定）。
  const probe = `${name} ${text}`.replace(/([a-z])([A-Z])/g, "$1 $2")
  return { hit: isRateLimitError("", probe, status), probe, status }
}

/**
 * 纯判定：给定恢复后的消息行，回答「本 run 是否应该做一次 boot resume」。
 * 不做 IO、不读时钟（bootAt/now 由调用方注入）→ 所有分支都能在回归里钉死。
 */
export const decideBootResume = (o: BootResumeInput): BootResumeVerdict => {
  if (!SID_RE.test(String(o.sid ?? ""))) return skip("invalid-session")
  if (o.claimed) return skip("already-claimed")
  // 用户主动按过 ⏹：这是“不要再跑”的明确意思，force / 换出口都不越过。
  if (o.halted) return skip("user-halted")
  // R2806（运营者：「不要把 R2790 的 13.9 小时 provider 额度限制加到 boot 恢复上」）：
  // provider 闸门只拦 **rollover seed successor** —— 它只有一次重试机会，不能把
  // 这次机会浪费在仍耗尽的账号上。普通 pre-boot 尾条是上一 run 被打断的输出，
  // boot 恢复本来就是为完成它；历史 61–120s 的恢复 7/7 成功，13.9h 的 retry_after
  // 只是保守值，不能用它把输出锁死到额度重置。普通尾条仍受 quotaRecover（出口
  // 已变化）和每 run 一次认领约束；若恢复后仍 429，R2806 不再 in-run recover，
  // CI 的 3 轮无健康回合安全阀会停住，不会无限循环。
  const rows = sortByCreated(o.rows)
  const seed = o.rolloverSeed ?? null
  const seedAt = Number(seed?.at ?? 0)
  // R2814：只有仍处于 DOA 状态的 seed 才算 pending。健康跑过/已被续过/
  // 已经花掉一次恢复的标记不能继续挡住 provider 闸门或普通尾恢复。
  const seedPending = rolloverSeedStillDoa(rows, seed)
  if (o.providerQuotaBlocked && seedPending) return skip("provider-quota-exhausted")

  if (rows.length === 0) return skip("no-messages")
  // R2804/R2805：宿主补写的 idle(succeeded) 不能掩盖上一回合的失败。
  const last = effectiveTail(rows)
  const created = rowCreated(last)
  if (created <= 0) return skip("undated-tail")
  const bootAt = Number(o.bootAt) || 0
  // R2838：孤儿 = 创建它的宿主进程已死；插件热重载后仍活着的回合绝不能算孤儿。
  // postBoot 仍按插件实例/本 run 判定（额度与“本 run 已有活动”语义不变）。
  const hostBootAt = Number(o.hostBootAt ?? o.bootAt) || 0
  const postBoot = bootAt > 0 && created >= bootAt - PREBOOT_MARGIN_MS
  const role = rowRole(last)
  const id = String(rowInfo(last)?.id ?? last?.id ?? "")
  const info = rowInfo(last)

  // R2664 early quota bypass (must run before loopOff/autoLoopActive):
  // 额度尾恢复是**跨 CI 的一次性恢复**，不是自动循环的一部分。只要证据成立
  // （pre-boot assistant 的 429 尾条 + 本轮出口已变化），`/loop off` / 自动循环
  // 活跃都不能把它挡掉 —— 实测用户 `/loop off` 后，真正需要 recover 的额度尾条
  // 永远不会注入。halted / claimed / boot 后已有活动仍然优先。
  // R2681：自动压缩阶段的 429 没有 assistant 错误行，尾条是宿主合成的
  // compaction/idle 行；两者都算额度尾条（assistant 带 compaction 标记的旧
  // 分支保持原样，避免把压缩中的正常 assistant 行误判成失败尾）。
  const type = rowType(last)
  const assistantQuotaTail = role === "assistant" && !info?.compaction
  const syntheticQuotaTail = type === "compaction" || type === "idle"
  const tailErr = info?.error ?? last?.error
  const tailRl = tailErr ? rateLimitProbe(tailErr) : { hit: false, probe: "", status: 0 }
  // R2797：429 rollover 的目标会话是**新建空会话**，首条 prompt 由桥注入
  // 「阅读（旧会话）对话历史，继续任务」。若该回合立刻 429，下一个 run 会把它
  // 当成 restored pre-run error 忽略，而 Bot 若已 /loop stop，auto-continue 也
  // 不会续跑 → successor 从创建起就是 DOA。这里给 seed 会话一次 recover：
  //   · 只认 seed 之后的第一条 prompt 回合（用户又发言/已续过 => 让位）；
  //   · halted、provider 额度闸门仍然优先（不越过明确的停止/真实额度耗尽）。
  const seedQuotaTail =
    seedPending &&
    seedAt > 0 &&
    created >= seedAt - PREBOOT_MARGIN_MS &&
    Boolean(tailErr) &&
    tailRl.hit &&
    (assistantQuotaTail || syntheticQuotaTail) &&
    countSeedPromptTurns(rows, seedAt) <= 1
  // R2805（运营者：「停止只是循环，尾恢复是为了完成输出，不一样」）：
  // `/loop stop` 只停自动循环，**不是**尾恢复的拒绝理由。进程重启后，上一段
  // 被 429/transport 打断的输出必须续完一次；否则 stop 会把半截输出永久丢下。
  // 真正的硬闸仍在更前面：halted（⏹）；provider 额度闸门只拦待恢复的 seed
  // successor（R2806）。gateStopped 只保留在日志里说明“当前循环是停的”。
  // 额度尾恢复仍提前于 /loop off / autoLoopActive；普通尾条不看 13.9h 的
  // retry_after，只看 quotaRecover（本轮出口已变化）+ 每 run 一次认领。
  const preBootQuotaTail =
    !postBoot && (assistantQuotaTail || syntheticQuotaTail) && Boolean(tailErr) && tailRl.hit && Boolean(o.quotaRecover)
  if (seedQuotaTail) return go("rollover-seed-recovered", "recover", id)
  if (preBootQuotaTail) return go("quota-recovered", "recover", id)

  // R2771（运营者：「你还没有正常结束，CI 重启之后没有重新拉起你」）：
  // /loop off 只停“自动循环”，不该吞掉上一进程留下的**未正常结束**回合。
  // pre-boot assistant 尾条带 error（aborted/interrupted/transport/其他）说明
  // 回合被重启打断，和 R2664 的额度尾条一样需要一次性恢复；否则 CI 一重启，
  // 正在干活的 loop-off 会话就永远停在半路。halted（显式 ⏹）仍是硬闸，
  // boot 后产生的回合仍由下面的 post-boot-turn 跳过。
  const preBootErrorTail =
    role === "assistant" && !postBoot && !info?.compaction && Boolean(info?.error ?? last?.error)
  if (o.loopOff && !preBootErrorTail) return skip("loop-off")
  // 自动循环仍在跑：它自己会续，不需要第二套注入。
  if (o.autoLoopActive && !o.force) return skip("auto-loop-active")

  // pre-boot 用户尾条 = 上一进程没来得及回答（后台通知、用户新指令都算）。
  // 斜杠命令不在此列：它由宿主/桥的命令通道处理，注入一句“继续”并不会执行命令。
  if (role === "user") {
    if (postBoot) return skip("post-boot-user")
    if (rowText(last).trimStart().startsWith("/")) return skip("user-command-tail")
    return go("unanswered-user", "continue", id)
  }
  if (role !== "assistant") return skip(`tail-${role || "unknown"}`)
  // boot 后已经有 assistant 活动 → 本 run 已经在推进，绝不插一条恢复消息。
  if (postBoot) return skip("post-boot-turn")

  if (info?.compaction) return skip("compaction-tail")

  const err = info?.error ?? last?.error
  if (err) {
    const rl = rateLimitProbe(err)
    // quota/429/free-limit：同出口重发只会再撞一次额度 → 跳过。
    // R2626：workflow 已证明本轮换到了不同出口（quotaRecover=1）时，旧尾条的
    // 429 不再代表新出口没额度：允许一次 recover 续跑。
    // R2664：正常情况已由上面的提前判断接管；这里保留为防御，语义保持一致。
    if (rl.hit) {
      if (o.quotaRecover) return go("quota-recovered", "recover", id)
      return skip("quota-error")
    }
    if (/abort|interrupt|cancel/i.test(rl.probe)) return go("error-abort", "recover", id)
    if (
      /transport|network|fetch|connect|socket|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ECONNRESET/i.test(
        rl.probe,
      )
    )
      return go("error-transport", "recover", id)
    return go("error", "recover", id)
  }

  // 写这一条 assistant 的进程已经死了（created 早于宿主进程 boot，completed 永远为 0）。
  // R2838：只看宿主 boot；插件热重载前 1~2s 创建的活回合不是孤儿。
  if (
    preBootOrphan({
      completed: Number(info?.time?.completed ?? 0),
      created,
      bootAt: hostBootAt,
    })
  )
    return go("orphan-turn", "continue", id)

  const parts = rowParts(last)
  if (hasUnfinishedTool(parts)) return go("unfinished-tool", "continue", id)

  const completed = Number(info?.time?.completed ?? 0)
  const text = rowText(last).trim()
  const hasTool = parts.some((p: any) => String(p?.type ?? "") === "tool")

  if (completed > 0) {
    // 已完成但只有 reasoning / 空 parts：典型的重启死回合（取消时宿主补写 completed）。
    if (!text && !hasTool) return go("dead-turn", "continue", id)
    const finish = String(info?.finish ?? last?.finish ?? "")
    // 宿主一步完成不等于回合完成：tool-calls 之后还有下一步；length = 被截断。
    if (/^(tool-calls|length)$/i.test(finish)) return go("unfinished-finish", "continue", id)
    return skip("clean-turn")
  }
  return skip("active-turn")
}

export const resumeOncePromptText = (kind: ResumePromptKind): string =>
  kind === "recover" ? RESUME_ONCE_RECOVER_PROMPT : RESUME_ONCE_PROMPT

// ── R2791：boot 注入屏障 ────────────────────────────────────────────────────
// 运营者：「存在跨ci/会话用户信息注入时机不对（ci重启后上一个输出因为中断导致
// 下一个信息被注入）」。根因是 tg-bridge 的队列泵在 serve 启动后立刻把排队的
// 用户消息注入，而 resume-once 的最早一拍在 8s 后；新 user 行落盘后，
// decideBootResume 看到 post-boot user tail 就跳过恢复 → 被中断的上一回合永远
// 不续跑。屏障让桥在「本会话已 arm 且尾条是 pre-boot 中断 assistant」时先等
// resume-once 认领（skipped 立即放行，injected 等恢复行落盘），有上限不死锁。
export type BootRailInput = {
  armed: boolean
  tailInterrupted: boolean
  rowsUnknown?: boolean
  claimStatus: string
  claimAgeMs: number
  bootAgeMs: number
  recoveryLanded: boolean
}
export type BootRailVerdict = { hold: boolean; reason: string }
const BOOT_RAIL_NO_CLAIM_MS = 120_000
const BOOT_RAIL_INJECT_MS = 20_000
const railHold = (reason: string): BootRailVerdict => ({ hold: true, reason })
const railRelease = (reason: string): BootRailVerdict => ({ hold: false, reason })
export const bootResumeRail = (o: BootRailInput): BootRailVerdict => {
  if (!o.armed) return railRelease("not-armed")
  const status = String(o.claimStatus || "")
  // 终局失败/跳过：resume-once 已经决定不恢复，继续压住队列只会让用户消息迟到。
  if (status === "skipped" || status === "failed" || status === "error") return railRelease(`claim-${status}`)
  if (!o.tailInterrupted && !o.rowsUnknown) return railRelease("tail-not-interrupted")
  if (status === "injected" || status === "injecting") {
    // 恢复提示已被受理；等它的 user 行真正落盘，避免桥的消息抢在前面。
    if (o.recoveryLanded) return railRelease("recovery-landed")
    if (o.claimAgeMs < BOOT_RAIL_INJECT_MS) return railHold(`await-${status}-landed`)
    return railRelease(`claim-${status}-timeout`)
  }
  // 还没有认领：注册表里已 arm 的会话最多等 resume-once 两分钟（含 DB 未就绪补拍）。
  if (o.bootAgeMs < BOOT_RAIL_NO_CLAIM_MS) return railHold(o.rowsUnknown ? "rows-unknown" : "await-resume-once")
  return railRelease("resume-once-timeout")
}

/** boot 前被打断的 assistant 尾条（与 decideBootResume 的可恢复集合同口径）。 */
export const preBootInterruptedTail = (rows: unknown[], bootAt: number, hostBootAt = 0): boolean => {
  const list = sortByCreated(rows)
  if (list.length === 0 || !(Number(bootAt) > 0)) return false
  // R2838：post-boot 闸仍用插件实例 boot（队列屏障语义）；孤儿判定必须用宿主
  // 进程 boot，否则热重载前 1-2s 创建、仍在生成的回合会被当成中断尾条压住队列。
  const orphanBootAt = Number(hostBootAt) || Number(bootAt)
  // R2804/R2805：跳过尾部干净的 idle/compaction 边界行；否则 tg-bridge 的
  // boot 屏障会把「429 → idle(failed) → idle(succeeded)」误判成正常结束，
  // 队列里的用户消息会抢先落盘，resume-once 随后只看到 post-boot-user 而跳过。
  const last = effectiveTail(list)
  if (rowRole(last) !== "assistant") return false
  const created = rowCreated(last)
  if (created >= Number(bootAt) - PREBOOT_MARGIN_MS) return false
  const info = rowInfo(last)
  if (info?.compaction) return false
  if (info?.error ?? last?.error) return true
  if (preBootOrphan({ completed: Number(info?.time?.completed ?? 0), created, bootAt: orphanBootAt })) return true
  const completed = Number(info?.time?.completed ?? 0)
  if (completed > 0) {
    const text = rowText(last).trim()
    const hasTool = rowParts(last).some((p: any) => String(p?.type ?? "") === "tool")
    // 宿主取消时补写 completed 的死回合；tool-calls/length 也都不是完整回合。
    if (!text && !hasTool) return true
    const finish = String(info?.finish ?? last?.finish ?? "")
    if (/^(tool-calls|length)$/i.test(finish)) return true
  }
  return false
}

export const resumeOnceClaimPath = (sid: string): string =>
  `${process.env.RUNNER_TEMP ?? "/tmp/opencode"}/resume-once-${sid}.json`

// ── R2797：429 rollover seed 的持久读取/一次性消费标记 ──────────────────────
// tg-bridge 在创建 successor 后写 `~/.config/opencode/rollover-seeds/<sid>.json`
// （随环境快照跨 run 存活）。resume-once 只在本 run 尚未 inject 过时消费一次；
// attempts 在注入前写 1，即使注入进程随后被杀也不会无限重试。
export const ROLLOVER_SEED_DIR = process.env.ROLLOVER_SEED_DIR ?? `${STATE_DIR}/rollover-seeds`
export const ROLLOVER_SEED_MAX_AGE_MS = 24 * 3600_000

export const readRolloverSeed = (sid: string): RolloverSeed | null => {
  if (!SID_RE.test(String(sid ?? ""))) return null
  try {
    const j = JSON.parse(readFileSync(`${ROLLOVER_SEED_DIR}/${sid}.json`, "utf8"))
    const at = Number(j?.at ?? 0)
    // 旧 seed 不能把早已稳定的会话重新唤醒；文件名必须与内容 sid 一致，
    // 防止复制/改名后的标记作用到另一个会话。
    if (!(at > 0) || Date.now() - at > ROLLOVER_SEED_MAX_AGE_MS) return null
    if (String(j?.sid ?? "") !== sid) return null
    return {
      sid,
      oldSid: String(j?.oldSid ?? ""),
      at,
      run: String(j?.run ?? ""),
      bot: String(j?.bot ?? ""),
      attempts: Math.max(0, Math.trunc(Number(j?.attempts ?? 0) || 0)),
      userInitiated: j?.userInitiated === true,
      manual: j?.manual === true,
    }
  } catch {
    return null
  }
}

/** 写入尝试次数；注入前调用（attempts=1），注入失败时回滚为 0。 */
export const markRolloverSeedAttempt = (sid: string, attempts = 1): boolean => {
  if (!SID_RE.test(String(sid ?? ""))) return false
  try {
    const path = `${ROLLOVER_SEED_DIR}/${sid}.json`
    const cur = JSON.parse(readFileSync(path, "utf8"))
    cur.attempts = Math.max(0, Math.trunc(attempts))
    cur.attemptedAt = Date.now()
    writeFileSync(path, JSON.stringify(cur), { encoding: "utf8", mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * R2814：seed 已经不再代表「首回合 429 的 DOA successor」时，立即消费掉标记。
 * 只在内容 sid 匹配时删除，避免误删同名/复制文件；删除失败保持原样（下一次
 * 评估还会尝试），不会影响注入安全性。
 */
export const clearRolloverSeed = (sid: string): boolean => {
  if (!SID_RE.test(String(sid ?? ""))) return false
  try {
    const path = `${ROLLOVER_SEED_DIR}/${sid}.json`
    const j = JSON.parse(readFileSync(path, "utf8"))
    if (String(j?.sid ?? "") !== sid) return false
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

export type ResumeOnceClaim = { status: string; at: number; reason: string; prompt: string }
export const readResumeOnceClaim = (sid: string): ResumeOnceClaim | null => {
  try {
    const j = JSON.parse(readFileSync(resumeOnceClaimPath(sid), "utf8"))
    const status = String(j?.status ?? "")
    if (!status) return null
    return {
      status,
      at: Number(j?.at ?? 0) || 0,
      reason: String(j?.reason ?? ""),
      prompt: String(j?.prompt ?? ""),
    }
  } catch {
    return null
  }
}

export const isResumeOnceArmed = (sid: string): boolean =>
  parseResumeOnceSids(process.env.RESUME_ONCE_SIDS).includes(String(sid ?? ""))

/** 恢复提示落盘判据：只有 resume-once 会写这两句开头。 */
export const isBootResumeRow = (r: unknown): boolean =>
  rowRole(r as any) === "user" && /^CI 在上一回合(未完成时|失败\/中断后)重启/.test(rowText(r as any).trimStart())

// ── 运行态读取（都是 best-effort：读不到按“没有该状态”处理）────────────────
// R2686：readJson/readLoopCtl 已上收到 state-io.ts（与 auto-continue 共用）。

const extraStatePaths = (): string[] => {
  let registry: string | null = null
  try {
    registry = readFileSync(`${STATE_DIR}/tg-bots.json`, "utf8")
  } catch {
    /* single-bot install */
  }
  return resolveExtraTargetPaths(process.env.AC_EXTRA_TARGETS, registry, HOME)
}

const isHalted = (sid: string): boolean => {
  if (sid in readHaltRelease()) return false
  for (const p of [TG_STATE_PATH, ...extraStatePaths()]) {
    const j = readJson(p)
    if (Array.isArray(j?.halted) && j.halted.includes(sid)) return true
  }
  return false
}

// auto-continue 的 evaluate 入口先要求 `isLoopTarget(sid)`（各 Bot 当前
// front/pinned）。若本 run 恢复的是“最富会话”而不是 front，auto-continue
// 根本不会驱动它 —— 这时不能把“闸门开着”误当成“自动循环正在管这个会话”。
const isLoopTargetSid = (sid: string): boolean => {
  for (const p of [TG_STATE_PATH, ...extraStatePaths()]) {
    const j = readJson(p)
    // 与 auto-continue.currentLoopTargets 同序：front 优先，只有 front 缺失/非法
    // 时才回退 pinned，避免把“另一个 Bot 的 pinned”误当成当前驱动目标。
    const t = SID_RE.test(String(j?.front ?? "")) ? String(j.front) : SID_RE.test(String(j?.pinned ?? "")) ? String(j.pinned) : ""
    if (t === sid) return true
  }
  return false
}

const isLoopOff = (sid: string): boolean => {
  const j = readJson(LOOP_OFF_PATH)
  return Array.isArray(j) && j.includes(sid)
}

const withTimeout = async <T>(p: Promise<T>, label: string, ms = 20_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const claimPath = (sid: string): string => resumeOnceClaimPath(sid)

type ClaimResult = "ok" | "exists" | "error"
const tryClaim = (sid: string, body: Record<string, unknown>): ClaimResult => {
  try {
    mkdirSync(process.env.RUNNER_TEMP ?? "/tmp/opencode", { recursive: true })
    writeFileSync(claimPath(sid), JSON.stringify({ sid, run: process.env.GITHUB_RUN_ID ?? "", pid: process.pid, at: Date.now(), ...body }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    })
    return "ok"
  } catch (err) {
    return (err as any)?.code === "EEXIST" ? "exists" : "error"
  }
}

const claimExists = (sid: string): boolean => {
  try {
    return existsSync(claimPath(sid))
  } catch {
    return false
  }
}

const releaseClaim = (sid: string): void => {
  try {
    unlinkSync(claimPath(sid))
  } catch {
    /* best-effort */
  }
}

type SidState = { done: boolean; lastEval: number; timer?: ReturnType<typeof setTimeout>; timerIdx: number }

export const ResumeOncePlugin: Plugin = async ({ client }) => {
  const sids = parseResumeOnceSids(process.env.RESUME_ONCE_SIDS)
  if (sids.length === 0) return {}
  // 与 auto-continue 同口径：只有长驻 serve 进程负责注入；TUI 进程不抢。
  const isServe = typeof process !== "undefined" && process.argv.some((arg) => arg === "serve")
  if (!isServe && process.env.RESUME_ONCE_ALLOW_TUI !== "1") return {}

  const bootAt = Date.now()
  const force = /^(1|true|yes|on)$/i.test(process.env.RESUME_ONCE_FORCE ?? "")
  // R2626：只有 workflow 比较完「上一轮出口 vs 本轮出口」后才会置 1。
  const quotaRecover = /^(1|true|yes|on)$/i.test(process.env.RESUME_ONCE_QUOTA_RECOVER ?? "")
  const states = new Map<string, SidState>()
  for (const sid of sids) states.set(sid, { done: false, lastEval: 0, timerIdx: 0 })
  // 重启后的首拍稍晚一点：让宿主先把恢复的会话挂好；之后只补拍有限次数。
  const timerDelays = [8_000, 20_000, 45_000, 90_000]

  const log = async (level: "info" | "warn" | "error", message: string): Promise<void> => {
    try {
      await client.app.log({ body: { service: "resume-once", level, message: `[resume-once] ${message}` } })
    } catch {
      /* logging must never break resume */
    }
  }

  const schedule = (sid: string): void => {
    const st = states.get(sid)
    if (!st || st.done || st.timer || st.timerIdx >= timerDelays.length) return
    const delay = timerDelays[st.timerIdx++]
    st.timer = setTimeout(() => {
      st.timer = undefined
      void evaluate(sid, "timer")
    }, delay)
    // 不要让一次性插件计时器影响 CLI 退出。
    ;(st.timer as any)?.unref?.()
  }
  // R2798：seed successor 只被 provider 额度闸门挡住时不能落终局 claim。
  // 闸门可能被「任意会话的一次健康回合」提前解除（auto-continue 的
  // clearProviderQuotaGate），也可能在 retry_after 到期后解除；两种情况都要
  // 再给这一次 seed 恢复机会，否则 successor 会在本 run 里一直死着，直到用户
  // 手动发消息把整轮 429 撞出来（2026-11-18 09:18→09:43 的 25 分钟空窗）。
  const armProviderRetry = (sid: string, resetAt: number, fast = false): void => {
    const st = states.get(sid)
    if (!st || st.done) return
    const at = Number(resetAt) || 0
    if (st.timer) clearTimeout(st.timer)
    // 上限取 job 的硬顶：7 天的 retry_after 不值得常驻一个计时器，
    // 下一轮 restore 会重新评估。resetAt 已过/缺失（判定与清闸竞态）时
    // 用 2s 短拍再确认一次，不把这次评估丢掉。
    const untilReset = at > Date.now() ? at + 1000 - Date.now() : 2_000
    // R2798：对端 idle 触发的重评估要假设「健康回合刚清闸」。插件的 event
    // 顺序没有保证：resume-once 可能先于 auto-continue 读到尚未清掉的闸门，
    // 此时若直接睡到 resetAt（可能 15h）就永远错过这次恢复。给一个 5s 快拍，
    // 让同一事件里稍后写入的清闸结果能被看到。
    const delay = fast ? Math.min(untilReset, 5_000) : Math.min(untilReset, 6 * 3600_000)
    st.timer = setTimeout(() => {
      st.timer = undefined
      void evaluate(sid, "provider-reset")
    }, delay)
    ;(st.timer as any)?.unref?.()
  }

  const evaluate = async (sid: string, trigger: string): Promise<void> => {
    const st = states.get(sid)
    if (!st || st.done) return
    const now = Date.now()
    if (now - st.lastEval < 2_000) {
      // R2798：事件触发的评估不能被 2s 节流静默丢掉。对端健康回合可能在上一拍
      // 结束 1s 内清掉 provider 闸门；丢掉这次评估会让 seed 一直等到 resetAt
      // 长定时器。改为 2s 后重评估（已有定时器让位，评估时会按需重设）。
      if (st.timer) clearTimeout(st.timer)
      st.timer = setTimeout(() => {
        st.timer = undefined
        void evaluate(sid, `${trigger}-retry`)
      }, 2_000)
      ;(st.timer as any)?.unref?.()
      return
    }
    st.lastEval = now
    if (claimExists(sid)) {
      st.done = true
      await log("info", `session=${sid.slice(0, 14)} skip=already-claimed trigger=${trigger}`)
      return
    }

    let rows: any[] = []
    try {
      const res = await withTimeout(client.session.messages({ path: { id: sid } }), "session.messages")
      rows = Array.isArray(res?.data) ? res.data : []
    } catch (err) {
      await log("warn", `session=${sid.slice(0, 14)} messages query failed trigger=${trigger}: ${String(err).slice(0, 160)}`)
      schedule(sid)
      return
    }

    const halted = isHalted(sid)
    const loopOff = isLoopOff(sid)
    const gateStopped = loopGateStopped(readLoopCtl(), sid)
    const autoLoopActive = !halted && !loopOff && !gateStopped && isLoopTargetSid(sid)
    // R2790：provider 账号额度硬闸，独立于出口变化（quotaRecover）。
    const providerGate = providerQuotaGate(now)
    let rolloverSeed = readRolloverSeed(sid)
    // R2814：旧 seed 文件可能是在 successor 健康跑了几小时后仍残留的
    // （bridge 直接注入种子提示，不会消耗 attempts）。这类标记不再有资格
    // 挡住 provider 闸门/尾恢复；在这里消费掉，CI 写入器下一轮就不会误判。
    if (rolloverSeed && !rolloverSeedStillDoa(rows, rolloverSeed)) {
      const cleared = clearRolloverSeed(sid)
      rolloverSeed = null
      if (cleared) {
        await log(
          "info",
          `session=${sid.slice(0, 14)} rollover seed cleared: successor moved past its DOA first turn trigger=${trigger}`,
        )
      }
    }
    const d = decideBootResume({
      sid,
      rows,
      bootAt,
      hostBootAt: HOST_BOOT_AT,
      halted,
      gateStopped,
      loopOff,
      autoLoopActive,
      force,
      quotaRecover,
      providerQuotaBlocked: providerGate.blocked,
      providerQuotaResetAt: providerGate.resetAt,
      rolloverSeed,
      now,
    })

    if (!d.resume) {
      await log(
        "info",
        `session=${sid.slice(0, 14)} skip=${d.reason} trigger=${trigger} gate=${gateStopped ? "stopped" : "open"} halted=${halted} loopOff=${loopOff} force=${force} quotaRecover=${quotaRecover}${providerGate.blocked ? ` providerQuotaResetAt=${new Date(providerGate.resetAt).toISOString()}` : ""}`,
      )
      // R2798：只被 provider 额度闸门挡住的 seed successor 保持待恢复状态。
      // 闸门会由任意健康回合提前解除；这里不写 skipped claim、不置 done，
      // 让 session.idle / resetAt 定时器还能再评估一次（仍然只有一次注入）。
      if (d.reason === "provider-quota-exhausted" && rolloverSeed && Number(rolloverSeed.attempts ?? 0) < 1) {
        armProviderRetry(sid, providerGate.resetAt, trigger === "session.idle-peer" || trigger === "quota-gate-cleared")
        return
      }
      // DB 可能还没就绪 / 会话还在挂载：有限补拍；其余终局直接落 claim，避免热重载再来一次。
      if (d.reason === "no-messages" || d.reason === "undated-tail" || d.reason === "active-turn" || d.reason === "compaction-tail") {
        schedule(sid)
        return
      }
      const claimed = tryClaim(sid, { status: "skipped", reason: d.reason, trigger })
      if (claimed === "exists") {
        await log("info", `session=${sid.slice(0, 14)} skip=${d.reason} but another instance already claimed this run`)
      } else if (claimed === "error") {
        await log("warn", `session=${sid.slice(0, 14)} skip=${d.reason} but could not write claim marker (no duplicate injection follows)`)
      }
      st.done = true
      return
    }

    const claimed = tryClaim(sid, { status: "injecting", reason: d.reason, trigger })
    if (claimed === "exists") {
      st.done = true
      await log("info", `session=${sid.slice(0, 14)} skip=already-claimed reason=${d.reason}`)
      return
    }
    if (claimed === "error") {
      // No exclusive claim = no safe injection. If the failed write already
      // created the file, treat it as claimed; otherwise allow a later timer.
      if (claimExists(sid)) st.done = true
      await log("warn", `session=${sid.slice(0, 14)} inject skipped: claim marker write failed reason=${d.reason}`)
      if (!st.done) schedule(sid)
      return
    }
    // R2676（fix 1）：quota 尾恢复和 auto-continue 在本 run 内互斥。标记必须在
    // promptAsync **之前**认领：谁先写谁注入，另一方只跳过这一条 pre-boot 429。
    // 不设时间限制；标记按 message id 区分，后续新 429 仍会正常恢复。
    // R2797：rollover seed 的恢复同样是“额度尾恢复”的一种，共用互斥标记。
    const quotaTailKind = d.reason === "quota-recovered" || d.reason === "rollover-seed-recovered"
    const quotaTailMsg = quotaTailKind ? String(d.messageID ?? "") : ""
    if (quotaTailKind) {
      if (!quotaTailMsg) {
        releaseClaim(sid)
        await log("warn", `session=${sid.slice(0, 14)} quota recovery skipped: tail message id missing trigger=${trigger}`)
        schedule(sid)
        return
      }
      const quotaClaim = claimQuotaTail(sid, quotaTailMsg, "resume-once")
      if (quotaClaim !== "ok") {
        if (quotaClaim === "exists") {
          const owner = quotaTailOwner(sid, quotaTailMsg) ?? "?"
          await log(
            "info",
            `session=${sid.slice(0, 14)} skip=quota-tail-exclusive owner=${owner} msg=${quotaTailMsg.slice(0, 20)} trigger=${trigger}`,
          )
          // 认领文件改写为「跳过」证据：本 run 已有另一方恢复这条尾消息。
          try {
            writeFileSync(
              claimPath(sid),
              JSON.stringify({
                sid,
                run: process.env.GITHUB_RUN_ID ?? "",
                pid: process.pid,
                at: Date.now(),
                status: "skipped",
                reason: "quota-tail-exclusive",
                owner,
                trigger,
                prompt: d.prompt,
              }),
              { encoding: "utf8", mode: 0o600 },
            )
          } catch {
            /* evidence only */
          }
          st.done = true
          return
        }
        // 标记写不了 = 没有排他保证，宁可交给下一拍/另一方，也不冒重复注入。
        releaseClaim(sid)
        await log(
          "warn",
          `session=${sid.slice(0, 14)} quota recovery deferred: exclusive marker write failed msg=${quotaTailMsg.slice(0, 20)} trigger=${trigger}`,
        )
        schedule(sid)
        return
      }
    }
    // R2797：先落 attempts=1 再注入。即使本进程在 promptAsync 中被杀，下一次
    // run 也不会把同一个 successor 再恢复一遍；注入失败会在 catch 里回滚。
    if (d.reason === "rollover-seed-recovered") {
      if (!markRolloverSeedAttempt(sid, 1)) {
        await log(
          "warn",
          `session=${sid.slice(0, 14)} rollover seed attempt marker write failed; prompt-turn count still bounds this recovery`,
        )
      }
    }
    let injected = false
    try {
      const text = `${resumeOncePromptText(d.prompt)}${lastRealUserExcerpt(rows)}`
      await withTimeout(
        client.session.promptAsync({
          path: { id: sid },
          body: { parts: [{ type: "text", text }], resume: true, delivery: "queue" },
        }),
        "session.promptAsync",
      )
      injected = true
      st.done = true
      // R2652：把「一次性续跑」也反映到所属 Bot 的注入状态卡上（复用
      // auto-continue 的 fireInjectNotices 总线）。这张卡是运营者看到的
      // “自动化进行中”提示：resume-once 不直接持有 Telegram 发送器，
      // 由拥有该会话的 tg-bridge 实例更新；没有实例/不拥有会话时静默跳过。
      try {
        fireInjectNotices(sid, quotaTailKind ? "quota" : "recover")
      } catch {
        /* best-effort */
      }
      // R2626：记录“最近一次额度尾条恢复”，供 TG 菜单展示（best-effort）。
      if (quotaTailKind) {
        writeQuotaRecoverLast({
          at: Date.now(),
          sid,
          reason: d.reason,
          prompt: d.prompt,
          run: process.env.GITHUB_RUN_ID ?? "",
          trigger,
        })
      }
      // 认领文件保留为“已注入”证据；覆盖 injecting 状态便于事后 grep。
      try {
        writeFileSync(claimPath(sid), JSON.stringify({ sid, run: process.env.GITHUB_RUN_ID ?? "", pid: process.pid, at: Date.now(), status: "injected", reason: d.reason, trigger, prompt: d.prompt }), {
          encoding: "utf8",
          mode: 0o600,
        })
      } catch {
        /* the exclusive claim already did its job */
      }
      await log(
        "info",
        `v=${RESUME_ONCE_VERSION} session=${sid.slice(0, 14)} INJECTED reason=${d.reason} prompt=${d.prompt} trigger=${trigger} quotaRecover=${quotaRecover} loopOff=${loopOff} autoLoop=${autoLoopActive} msg=${String(d.messageID ?? "").slice(0, 20)}`,
      )
    } catch (err) {
      // 注入没有成功才释放排他标记；成功后即使后续记账抛错，也不能把这条尾
      // 重新让给 auto-continue（否则同一条 429 又会被恢复第二次）。
      if (quotaTailKind && quotaTailMsg && !injected) {
        releaseQuotaTail(sid, quotaTailMsg, "resume-once")
      }
      // R2797：注入没有发生 => 这次 seed 机会没有花掉；回滚 attempts，下一拍/
      // 下一 run 仍可重试一次。
      if (d.reason === "rollover-seed-recovered" && !injected) {
        markRolloverSeedAttempt(sid, 0)
      }
      releaseClaim(sid)
      await log("warn", `session=${sid.slice(0, 14)} inject failed reason=${d.reason} trigger=${trigger}: ${String(err).slice(0, 160)}`)
      schedule(sid)
    }
  }

  for (const sid of sids) {
    void log(
      "info",
      `v=${RESUME_ONCE_VERSION} armed session=${sid.slice(0, 14)} boot=${new Date(bootAt).toISOString()} hostBoot=${new Date(HOST_BOOT_AT).toISOString()} force=${force} quotaRecover=${quotaRecover}`,
    )
    schedule(sid)
  }

  // R2804（运营者：「你的输出没有正常结束，应该尾恢复的」）：provider 闸门由
  // **任意会话**的健康回合清除（auto-continue 的 clearProviderQuotaGate），但宿主
  // 不保证发 session.idle；被闸门挡住的 seed successor 若只靠 resetAt 定时器，
  // 会白等到 retry_after（实测 10:59 skip → 11:00 清闸 → 无唤醒，13h 后才醒）。
  // 监听证据文件本身：清闸即重评估，仍然只注入一次（attempts 标记兜底）。
  watchFile(
    QUOTA_429_EVIDENCE_PATH,
    () => {
      if (providerQuotaGate().blocked) return
      for (const sid of states.keys()) {
        const st = states.get(sid)
        if (!st || st.done) continue
        if (!readRolloverSeed(sid)) continue
        void evaluate(sid, "quota-gate-cleared")
      }
    },
    { owner: "resume-once:quota-gate", scanOnStart: false },
  )

  return {
    event: async ({ event }: any) => {
      if (String(event?.type ?? "") !== "session.idle") return
      const props: any = event?.properties ?? event?.data ?? {}
      const sid = String(props?.sessionID ?? props?.id ?? "")
      if (sid && states.has(sid)) await evaluate(sid, "session.idle")
      // R2798：健康回合会清除 provider 额度闸门（auto-continue 的
      // clearProviderQuotaGate），但那个回合可能属于另一个会话。对端一 idle
      // 就重评估仍在等闸门的 seed successor，避免它整轮都死着。
      for (const other of states.keys()) {
        if (other === sid) continue
        const st = states.get(other)
        if (!st || st.done) continue
        if (!readRolloverSeed(other)) continue
        await evaluate(other, "session.idle-peer")
      }
    },
  }
}
