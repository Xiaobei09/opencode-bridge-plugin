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
 *   2. pre-boot assistant 的 quota/429 尾条 + 本轮出口已变化
 *      （RESUME_ONCE_QUOTA_RECOVER=1）→ **不受 `/loop off` / 自动循环活跃限制**，
 *      用 recover 文案续一次。额度尾恢复是跨 CI 的一次性恢复，不是循环的一部分；
 *      仍受 halted / 每 run 一次认领 / boot 后已有活动约束。
 *   3. `/loop off`（loop-sessions-off）→ 不再续跑（quota 尾条已在第 2 步放行）；
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
import { readHaltRelease } from "./halt-release"
import { isRateLimitError, loopGateStopped, resolveExtraTargetPaths } from "./auto-continue"
import { writeQuotaRecoverLast } from "./quota-recover"

const HOME = process.env.HOME ?? "/root"
const STATE_DIR = `${HOME}/.config/opencode`
const TG_STATE_PATH = process.env.AC_TG_STATE_PATH ?? `${STATE_DIR}/tg-chats.json`
const LOOP_OFF_PATH = `${STATE_DIR}/loop-sessions-off.json`
const LOOP_CTL_PATH = `${STATE_DIR}/loop-ctl.json`
const LOOP_CTL_LEGACY = "/tmp/opencode/loop-ctl.json"
const PREBOOT_MARGIN_MS = 1000
const SID_RE = /^ses_[A-Za-z0-9_-]+$/
// 让运行日志能证明“本轮确实加载了 Option C”，而不是只看仓库文件。
// R2624：workflow 现在会 arm 每个 Bot 的 front/pinned（不再只 arm 本轮打开的
// 那一个会话）；每个会话仍独立走 decideBootResume 的 halted/loop-off/quota 闸门。
// R2664：quota 尾条在 loop-off/循环活跃之前单独放行；halted 仍是硬闸。
// R2665：CI 侧只把「可执行的 429 rollover」当作排斥条件；等待循环/已 halted/
// Bot 离线的 rollover 请求不再全局关闭额度尾恢复，也不再阻止该会话被 arm。
// R2666：额度尾恢复单独上报 kind=quota，桥据此发一条可见 TG 提示。
const RESUME_ONCE_VERSION = "r2666-quota-notice"

export const RESUME_ONCE_PROMPT = `CI 在上一回合未完成时重启，现已恢复同一会话。请从中断处继续完成上一项工作（仅此一次，不要开启或恢复自动循环）：

1. 先用一两句话说明上次进行到哪一步；若无法判断，直接说明“无法判断中断点”。
2. 接着完成被中断的任务；不要重复已经完成的部分，不要重新扫描整个项目。
3. 完成后直接给出结果并停止，等待用户下一步指令。不要输出 [STATUS: CONTINUE]，也不要自行开始新一轮循环。`

export const RESUME_ONCE_RECOVER_PROMPT = `CI 在上一回合失败/中断后重启，现已恢复同一会话。请只做一次恢复性续跑（不要开启自动循环）：

1. 先检查上一轮的错误是否仍然存在；若可恢复，从中断处继续完成被中断的工作。
2. 不要重复已经完成的部分。
3. 若错误仍在（例如 provider 不可用），用一两句话报告症状后停止，不要反复重试；不要输出 [STATUS: CONTINUE]。`

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
  bootAt: number
  halted?: boolean
  loopOff?: boolean
  autoLoopActive?: boolean
  force?: boolean
  /** R2626：workflow 已确认新出口与上一轮不同；只影响 quota 尾条，不越过其它闸门。 */
  quotaRecover?: boolean
  claimed?: boolean
  now?: number
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
const rowRole = (r: any): string => String(rowInfo(r)?.role ?? r?.role ?? "")
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

  const rows = sortByCreated(o.rows)
  if (rows.length === 0) return skip("no-messages")
  const last = rows[rows.length - 1]
  const created = rowCreated(last)
  if (created <= 0) return skip("undated-tail")
  const bootAt = Number(o.bootAt) || 0
  const postBoot = bootAt > 0 && created >= bootAt - PREBOOT_MARGIN_MS
  const role = rowRole(last)
  const id = String(rowInfo(last)?.id ?? last?.id ?? "")
  const info = rowInfo(last)

  // R2664 early quota bypass (must run before loopOff/autoLoopActive):
  // 额度尾恢复是**跨 CI 的一次性恢复**，不是自动循环的一部分。只要证据成立
  // （pre-boot assistant 的 429 尾条 + 本轮出口已变化），`/loop off` / 自动循环
  // 活跃都不能把它挡掉 —— 实测用户 `/loop off` 后，真正需要 recover 的额度尾条
  // 永远不会注入。halted / claimed / boot 后已有活动仍然优先。
  if (role === "assistant" && !postBoot && !info?.compaction) {
    const err = info?.error ?? last?.error
    if (err && o.quotaRecover && rateLimitProbe(err).hit) {
      return go("quota-recovered", "recover", id)
    }
  }

  // 循环状态只影响循环本身；quota 尾条已在上面单独放行。
  if (o.loopOff) return skip("loop-off")
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

  // 写这一条 assistant 的进程已经死了（created 早于本进程 boot，completed 永远为 0）。
  if (
    preBootOrphan({
      completed: Number(info?.time?.completed ?? 0),
      created,
      bootAt,
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

// ── 运行态读取（都是 best-effort：读不到按“没有该状态”处理）────────────────

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

const readCtl = (): any => {
  for (const p of [LOOP_CTL_PATH, LOOP_CTL_LEGACY]) {
    const j = readJson(p)
    if (j && typeof j === "object") return j
  }
  return {}
}

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

const claimPath = (sid: string): string =>
  `${process.env.RUNNER_TEMP ?? "/tmp/opencode"}/resume-once-${sid}.json`

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

  const evaluate = async (sid: string, trigger: string): Promise<void> => {
    const st = states.get(sid)
    if (!st || st.done) return
    const now = Date.now()
    if (now - st.lastEval < 2_000) return
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
    const gateStopped = loopGateStopped(readCtl(), sid)
    const autoLoopActive = !halted && !loopOff && !gateStopped && isLoopTargetSid(sid)
    const d = decideBootResume({
      sid,
      rows,
      bootAt,
      halted,
      loopOff,
      autoLoopActive,
      force,
      quotaRecover,
      now,
    })

    if (!d.resume) {
      await log(
        "info",
        `session=${sid.slice(0, 14)} skip=${d.reason} trigger=${trigger} gate=${gateStopped ? "stopped" : "open"} halted=${halted} loopOff=${loopOff} force=${force} quotaRecover=${quotaRecover}`,
      )
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
    try {
      const text = `${resumeOncePromptText(d.prompt)}${lastRealUserExcerpt(rows)}`
      await withTimeout(
        client.session.promptAsync({
          path: { id: sid },
          body: { parts: [{ type: "text", text }], resume: true, delivery: "queue" },
        }),
        "session.promptAsync",
      )
      st.done = true
      // R2652：把「一次性续跑」也反映到所属 Bot 的注入状态卡上（复用
      // auto-continue 的 fireInjectNotices 总线）。这张卡是运营者看到的
      // “自动化进行中”提示：resume-once 不直接持有 Telegram 发送器，
      // 由拥有该会话的 tg-bridge 实例更新；没有实例/不拥有会话时静默跳过。
      try {
        fireInjectNotices(sid, d.reason === "quota-recovered" ? "quota" : "recover")
      } catch {
        /* best-effort */
      }
      // R2626：记录“最近一次额度尾条恢复”，供 TG 菜单展示（best-effort）。
      if (d.reason === "quota-recovered") {
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
      releaseClaim(sid)
      await log("warn", `session=${sid.slice(0, 14)} inject failed reason=${d.reason} trigger=${trigger}: ${String(err).slice(0, 160)}`)
      schedule(sid)
    }
  }

  for (const sid of sids) {
    void log(
      "info",
      `v=${RESUME_ONCE_VERSION} armed session=${sid.slice(0, 14)} boot=${new Date(bootAt).toISOString()} force=${force} quotaRecover=${quotaRecover}`,
    )
    schedule(sid)
  }

  return {
    event: async ({ event }: any) => {
      if (String(event?.type ?? "") !== "session.idle") return
      const props: any = event?.properties ?? event?.data ?? {}
      const sid = String(props?.sessionID ?? props?.id ?? "")
      if (sid && states.has(sid)) await evaluate(sid, "session.idle")
    },
  }
}
