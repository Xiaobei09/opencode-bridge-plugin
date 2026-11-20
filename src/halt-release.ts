/**
 * 跨实例停机解除表（R2500 引入，R2572 抽成独立模块）。
 *
 * 背景：`halted` 是各 Bot 状态文件里「用户按过 ⏹ 的会话」名单，auto-continue 取
 * **所有 Bot 状态文件的并集**；但清除只清当前 Bot 自己那份，导致一个 Bot 写入的
 * 停机别的 Bot 永远清不掉（2026-10-18 实测：会话自动循环被永久卡死）。解除表是
 * 唯一能跨实例生效的通道：谁解除谁登记，所有消费方读 halted 时先做差集。
 *
 * 契约（D5 取消状态机，顺序不能错）：
 *   1) 解除（用户新消息投递成功 / `/loop start`）→ 写入 sid；
 *   2) 重新停机（⏹ doStop）→ **先抹除** sid 的旧解除条目，再落盘 halted；
 *      否则「停机 → 解除 → 再停机」的第二次停机会被旧解除吃掉，用户表现就是
 *      「按了 ⏹ 但自动循环还在跑」。
 *   3) 文件缺失/损坏 → 视为“无解除”（halt 保持有效）——失败方向必须偏向“已取消
 *      保持取消”，绝不能因为读不到文件而擅自恢复一个被停的会话。
 *
 * 路径可用 HALT_RELEASE_PATH 覆盖：隔离回归测试不得读写生产状态。
 * 写入采用 tmp+rename，避免读侧看到半截 JSON（那会把一次解除当成没发生）。
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs"

export const haltReleasePath = (): string =>
  process.env.HALT_RELEASE_PATH ?? `REDACTED_ROOT/.config/opencode/halt-release.json`

export const readHaltRelease = (): Record<string, number> => {
  try {
    const j = JSON.parse(readFileSync(haltReleasePath(), "utf8")) as unknown
    return j && typeof j === "object" ? (j as Record<string, number>) : {}
  } catch {
    return {} // 无解除表 = 无解除（保持「已取消保持取消」）
  }
}

export const writeHaltRelease = (rel: Record<string, number>): void => {
  const path = haltReleasePath()
  const tmp = `${path}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify(rel), { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    // 只读/并发：忽略（这是尽力而为的跨实例通道）；清掉可能残留的临时文件。
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

/** 登记「已解除停机」。各 Bot 实例与 auto-continue 都据此把 sid 从 halted 里剔除。 */
export const noteHaltRelease = (sids: Iterable<string>): void => {
  const rel = readHaltRelease()
  let dirty = false
  for (const s of sids) {
    if (typeof s === "string" && s) {
      rel[s] = Date.now()
      dirty = true
    }
  }
  if (dirty) writeHaltRelease(rel)
}

/** 重新停机：抹除解除表条目，保证「停机 → 解除 → 再停机」时序正确。 */
export const noteHaltArm = (sid: string): void => {
  const rel = readHaltRelease()
  if (sid in rel) {
    delete rel[sid]
    writeHaltRelease(rel)
  }
}

/** 把 halted 名单灌进集合，剔除已解除的 sid。返回实际置入条数。 */
export const loadHaltedInto = (hl: unknown, into: Set<string>): number => {
  if (!Array.isArray(hl)) return 0
  const rel = readHaltRelease()
  let n = 0
  for (const s of hl) if (typeof s === "string" && s && !(s in rel)) {
    into.add(s)
    n++
  }
  return n
}
