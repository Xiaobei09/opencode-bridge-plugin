/**
 * shell-promo —— 「插件层强制 shell 转后台」工具覆盖（用户 2026-09-28 要求：
 * 「我说的不是模型判断，是插件判断」——跑超 1 分钟的 shell 由**插件**计时并强制转后台）。
 *
 * 为什么必须覆盖 `shell` 工具：
 *   宿主内置 shell 的 `background:true` 是"启动时就后台"，没有"运行中 ≥60s 再提升"的机制；
 *   模型侧自觉（shellAuto）又依赖模型判断。要满足"插件判断"，唯一机制层拦截点就是
 *   Hooks.tool 槽位**同名覆盖**内置 shell 工具：execute 由插件掌控 → 插件自己 spawn 进程、
 *   自己计时，60s 未完成即强制转后台（进程不杀、继续跑），完成后把最终输出投递回原会话。
 *
 * 与宿主行为对齐（避免覆盖后出现回归）：
 *   - 前台快速命令（≤60s）：返回 stdout+stderr+exit 码，与原生 shell 工具一致的 ToolResult 文本；
 *   - `background:true`：立即返回"已转后台"标记，进程后台跑，完成后投递；
 *   - `timeout`（若显式给出且 < 提升阈值）：按 timeout 超时处置（不触发 60s 提升）；
 *   - workdir → cwd；空命令直接报错文本。
 */
import { spawn } from "node:child_process"
import { z } from "zod"

export type ShellPromoDeps = {
  /** 前台命令超过该时长（ms）由插件强制转后台。默认 60_000（用户口径"超过一分钟"）。 */
  promoteMs?: number
  /** 后台命令完成时把最终输出投递回原会话（闭包注入，桥内实现）。 */
  deliver: (sessionID: string, text: string) => Promise<void>
  /** 熔断：false 时覆盖立即退出、回退宿主行为（配合 background-mode.json 的 shellPromo）。 */
  enabled?: boolean
  log?: (line: string) => void
}

export const shellPromoArgs = {
  command: z.string(),
  timeout: z.number().int().min(0).optional(),
  background: z.boolean().optional(),
  workdir: z.string().optional(),
}
export type ShellPromoArgs = z.infer<typeof shellPromoArgs>

/** 纯判定：前台命令在该时长(millis)是否应被插件强制转后台（可单测）。 */
export const shouldPromote = (elapsedMs: number, timeoutMs: number | undefined, promoteMs: number): boolean => {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return false
  // 用户显式 timeout 且比提升阈值小 → 走 timeout 杀路径，不触发提升。
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs < promoteMs) {
    return false
  }
  return elapsedMs >= promoteMs
}

const promoTag = (shellID: string, promoteMs: number): string =>
  `[shell-promo] 命令已运行超过 ${Math.round(promoteMs / 1000)}s，由插件强制转为后台执行（shellID=${shellID}）；完成后结果将自动投递回本会话。`

/** 生成同名覆盖 shell 的 ToolDefinition（Hooks.tool.shell）。 */
export const makeShellPromoTool = (deps: ShellPromoDeps) => ({
  description:
    "Execute a shell command. Plugin-layer enforcement: a foreground command still running after 60s is force-promoted to background by the plugin (not by model choice); its final output is delivered back to the session automatically.",
  args: shellPromoArgs,
  execute: async (argsIn: ShellPromoArgs, context: any): Promise<string> => {
    if (deps.enabled === false) {
      // 熔断逃生门：覆盖退出，回退宿主行为（返回占位，宿主不再接管 —— 见桥 wiring 注释）。
      deps.log?.(`[shell-promo] disabled by config; command: ${String(argsIn?.command ?? "").slice(0, 60)}`)
      return `[shell-promo] 已因配置熔断停用；命令未由插件执行。`
    }
    const promoteMs = Math.max(1_000, deps.promoteMs ?? 60_000)
    const { command, timeout, background, workdir } = argsIn ?? {}
    const sessionID = String(context?.sessionID ?? "")
    const cwd = workdir || context?.directory || process.cwd()
    if (!command || typeof command !== "string" || !command.trim()) {
      return "[shell-promo] 空命令：未执行任何内容。"
    }
    const shellID = `shp_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
    let child
    try {
      child = spawn(command, { shell: true, cwd, env: process.env })
    } catch (err) {
      return `[shell-promo] spawn 失败: ${String(err).slice(0, 200)}`
    }
    let outBuf = ""
    let errBuf = ""
    child.stdout?.on("data", (d) => (outBuf += d.toString()))
    child.stderr?.on("data", (d) => (errBuf += d.toString()))
    const merged = (): string => {
      const o = outBuf.trimEnd()
      const e = errBuf.trimEnd()
      return e ? (o ? `${o}\n${e}` : e) : o
    }
    const deliverDone = (): void => {
      void deps
        .deliver(sessionID, `[shell 后台完成] ${shellID}\n${merged()}`)
        .catch((err) => deps.log?.(`[shell-promo] deliver 失败: ${String(err).slice(0, 160)}`))
    }

    // background:true → 立即返回标记，进程后台跑，完成后投递。
    if (background === true) {
      child.on("close", deliverDone)
      child.on("error", (e) => deps.log?.(`[shell-promo] bg spawn error: ${String(e).slice(0, 160)}`))
      deps.log?.(`[shell-promo] background started session=${sessionID.slice(0, 12)} shellID=${shellID} cmd=${command.trim().slice(0, 80)}`)
      return `[shell-promo] 命令已转入后台执行（session=${sessionID.slice(0, 12)}… shellID=${shellID}）；完成后结果将自动投递回本会话。`
    }

    // 前台：先区分「超时终止」与「插件提升」——用户显式 timeout 且 < 60s 时按原生语义
    // 超时杀掉进程并报错；否则第 promoteMs 触发插件强制转后台。
    const killMs =
      typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 && timeout < promoteMs ? timeout : null
    const timerMs = killMs ?? promoteMs
    return await new Promise<string>((resolve) => {
      let settled = false
      const done = (r: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => {
        if (killMs !== null) {
          // 原生语义：超时终止（SIGTERM → 2s 后 SIGKILL 兜底）。
          deps.log?.(`[shell-promo] TIMEOUT-KILL shellID=${shellID} session=${sessionID.slice(0, 12)} after ${Math.round(killMs / 1000)}s`)
          const killer = (sig: NodeJS.Signals): void => {
            try {
              child.kill(sig)
            } catch {
              /* already gone */
            }
          }
          killer("SIGTERM")
          setTimeout(() => killer("SIGKILL"), 2_000)
          const out = merged()
          done(out ? `${out}\n[shell 超时] 命令超过 ${Math.round(killMs / 1000)}s 已终止 (shellID=${shellID})` : `[shell 超时] 命令超过 ${Math.round(killMs / 1000)}s 已终止 (shellID=${shellID})`)
          return
        }
        // 插件强制转后台：进程不杀、继续跑，完成后投递最终输出。
        deps.log?.(`[shell-promo] FORCE-PROMOTED shellID=${shellID} session=${sessionID.slice(0, 12)} after ${Math.round(timerMs / 1000)}s`)
        done(promoTag(shellID, timerMs))
        child.on("close", deliverDone)
      }, timerMs)
      child.on("close", (code) => {
        if (settled) return
        clearTimeout(timer)
        const out = merged()
        done(out ? `${out}\n[exit ${code ?? "?"}]` : `[exit ${code ?? "?"}]（无输出）`)
      })
      child.on("error", (e) => {
        clearTimeout(timer)
        done(`[shell-promo] shell 执行失败: ${String(e).slice(0, 200)}`)
      })
    })
  },
})