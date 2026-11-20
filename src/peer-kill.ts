/**
 * R2844（运营者：「当前代码结构有没有可以优化的地方？不要环境还原失败！
 * 不要改动任何特性」）：结束本轮时杀掉**其他** opencode 进程的唯一实现。
 *
 * tg-bridge 的 `/proxy next`（endRunForNewExit）与 auto-continue 的 quota 兜底
 * （endRunNow）此前各抄一份 `/proc` 扫描。两处的语义必须完全一致：
 *   · 只认 comm 精确等于 `opencode`（trim 后），绝不误杀其它进程；
 *   · 跳过当前进程，自己的退出时机由调用方决定（延迟 SIGKILL / 写标记）；
 *   · 非数字目录、读不到 comm、无权限、/proc 不可读都只是跳过，不影响结束轮次。
 *
 * 可注入 procRoot/selfPid/kill 仅用于单测，生产默认值与原实现相同。
 */
import { readdirSync, readFileSync } from "node:fs"

export type KillPeersOptions = {
  /** 默认 /proc；测试可指向假目录。 */
  procRoot?: string
  /** 默认 process.pid。 */
  selfPid?: number
  /** 默认 process.kill(pid, "SIGKILL")；测试可注入记录器。 */
  kill?: (pid: number) => void
}

export const killOtherOpencodeProcesses = (opts: KillPeersOptions = {}): void => {
  const procRoot = opts.procRoot ?? "/proc"
  const selfPid = opts.selfPid ?? process.pid
  const kill = opts.kill ?? ((pid: number): void => process.kill(pid, "SIGKILL"))
  try {
    for (const name of readdirSync(procRoot)) {
      if (!/^\d+$/.test(name)) continue
      const pid = Number(name)
      if (pid === selfPid) continue
      let comm = ""
      try {
        comm = readFileSync(`${procRoot}/${name}/comm`, "utf8").trim()
      } catch {
        continue
      }
      if (comm !== "opencode") continue
      try {
        kill(pid)
      } catch {
        /* 已退出/无权限：忽略 */
      }
    }
  } catch {
    /* /proc 不可读：忽略 */
  }
}
