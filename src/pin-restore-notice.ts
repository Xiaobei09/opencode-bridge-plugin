/**
 * R2830（运营者：「📌 注入队列恢复 3 条 … 大量重复发送，并且不知道为什么发送」）：
 * 「注入队列恢复」提示的**同进程**去重。
 *
 * 热重载会在同一进程里重新求值 tg-bridge 模块，模块级 `pinRestorePending`
 * 随之重新置位；如果不去重，每次保存代码/同步运行态都会再发一条恢复提示。
 * 用 globalThis 上的 Set 跨模块实例共享，键取每个 Bot 的 STATE_PATH。
 *
 * 这不是唯一一道闸：tg-bridge 还把「当前队列已提示过」落盘（pinrestored），
 * 真正的进程重启/CI 新 run 也不会对同一批未清空的队列反复提示；队列清空后
 * 才重置，下一批队列恢复时仍会提示一次。这里负责挡住同一进程内的热重载。
 */
const KEY = "__tgBridgePinRestoreNotifiedV1"

export const claimPinRestoreNotice = (
  key: string,
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): boolean => {
  if (!key) return false
  let seen = scope[KEY]
  if (!(seen instanceof Set)) {
    seen = new Set<string>()
    scope[KEY] = seen
  }
  const set = seen as Set<string>
  if (set.has(key)) return false
  set.add(key)
  return true
}
