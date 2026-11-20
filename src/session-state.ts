/**
 * R2859：会话「运行中 / 空闲」的单一判据。
 *
 * 旧实现（`tg-bridge.sessionStateLabel` 与 `tg-command-loop` 的 `/loop` 状态行）
 * 各自用 `lastActivity` 是否落在 2 分钟内来猜运行中：
 *  · 回合刚结束仍显示「运行中」最多 2 分钟；
 *  · 长工具/思考超过 2 分钟没有事件，活回合被显示成「完成/空闲」；
 *  · 热重载后 `lastActivity` 为空，活会话显示「未知」。
 * 宿主 `/api/session` 的 `time.busy` / `time.idle` 才是回合边界：
 *  · 运行中：`busy > 0` 且（`idle` 缺失/0 或 `busy > idle`）；
 *  · 空闲：`idle >= busy`。
 * 事件流 `busyTurn` 作为补充：会话列表刷新有 TTL，刚起的新回合可能还没反映到
 * 缓存里；此时事件流已经知道它在跑。但 `busyTurn` 也可能因漏收完成事件滞留，
 * 所以**宿主数据新鲜时以宿主为准**（`infoFresh`），只有宿主数据陈旧/缺失时才让
 * `busyTurn` 覆盖「空闲」，避免菜单长期虚报「运行中」。
 *
 * 只有宿主时间戳与 `busyTurn` 都缺失时，才回退到旧的 `lastActivity` 窗口，
 * 保证旧状态文件/降级 API 下仍能给出保守结果。
 */
export type SessionTimes = { busy?: number; idle?: number }

/** 宿主时间戳的权威判据；没有可用时间戳时返回 undefined（交给调用方回退）。 */
export const hostSessionRunning = (info?: SessionTimes | null): boolean | undefined => {
  const busy = Number(info?.busy ?? 0)
  const idle = Number(info?.idle ?? 0)
  if (!(busy > 0) && !(idle > 0)) return undefined
  return busy > 0 && (idle <= 0 || busy > idle)
}

/** 会话是否正在跑一个回合。宿主时间戳优先，`busyTurn` 补充，最后才用活动时间兜底。 */
export const sessionIsRunning = (o: {
  now: number
  info?: SessionTimes | null
  busyTurn?: boolean
  /** 宿主数据是否刚刷新过；true 时宿主「空闲」压过滞留的 busyTurn。 */
  infoFresh?: boolean
  lastActivity?: number
  fallbackWindowMs?: number
}): boolean => {
  const host = hostSessionRunning(o.info)
  if (host === true) return true
  if (o.busyTurn && (host !== false || o.infoFresh !== true)) return true
  if (host !== undefined) return host
  const act = Number(o.lastActivity ?? 0)
  return act > 0 && o.now - act <= Number(o.fallbackWindowMs ?? 120_000)
}
