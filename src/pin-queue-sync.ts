/**
 * R2853（运营者：「有时候发有时候不发，绝对有问题，不行就直接不发了」）：
 * 注入队列的**稳定身份**与**磁盘对账**判据。
 *
 * 事故链（2026-11-20 03:13）：
 *   · 队列里 3 条用户消息早在 02:33/02:34 入队，sid 已跟随 429 换会话改到当前会话；
 *   · 泵在 idle 等待后用 `pinQueue.findIndex(qq => qq === item)` 复核，而
 *     `syncPinQueueFromDisk()` 会把队列对象整体替换（同 id、新对象）→ 身份比较失败；
 *   · 失败分支把它当成「已被循环搭便车取走」跳过，消息继续留在文件里，之后再也
 *     没人泵它（新的入队消息反而先被注入）；
 *   · `reconcilePinQueue()` 又可能拿**比内存旧**的磁盘快照做权威对账，把还在磁盘
 *     里的条目从内存删掉，制造同样的“消失”。
 *
 * 这里把两个判据抽成纯函数，桥只做 I/O：
 *   · 条目只按 `id` 认，绝不按对象引用；
 *   · 只有**比上次成功落盘更新**的状态文件才有资格删除内存条目；
 *   · 复核时内存没有、磁盘还有且未认领 → 重新采纳，而不是跳过。
 */

export type PinQueueLike = {
  id: string
  sid: string
  text: string
  ctx: string
  chat: string
  ts: number
  tgMid?: number
  claimedAt?: number
  retryCount?: number
}

/** 稳定身份查找：磁盘/热重载会替换对象，id 才是条目的身份。 */
export const pinIndexById = (items: ReadonlyArray<{ id?: string }>, id: string): number => {
  if (!id) return -1
  return items.findIndex((x) => String(x?.id ?? "") === id)
}

/**
 * 状态文件是否比本实例上次成功落盘更新。
 *
 * `toleranceMs` 吸收「atomicWrite 刚写完、stateSavedAt 在稍后才赋值」的毫秒级
 * 先后差：自己刚写的文件不算“别人改了”，否则会把内存里的新条目误删。
 */
export const stateFileIsNewer = (mtimeMs: number, lastSavedAt: number, toleranceMs = 2): boolean => {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return false
  return mtimeMs > Math.max(0, lastSavedAt) + Math.max(0, toleranceMs)
}

/**
 * 对账：只删除「本实例曾经落盘过、且权威磁盘快照里已经没有」的条目。
 * 新入队（还没落盘）的条目一律豁免 —— 否则 save 比 write 先读文件会把新条吃掉。
 */
export const reconcilePinItems = <T extends { id?: string }>(
  items: ReadonlyArray<T>,
  diskIds: ReadonlySet<string>,
  savedIds: ReadonlySet<string>,
): T[] => items.filter((x) => {
  const id = String(x?.id ?? "")
  return !(id && savedIds.has(id) && !diskIds.has(id))
})

/**
 * 磁盘副本能否被重新采纳。
 * `pininflight` 是 at-most-once 的认领记录：已经在别的实例里认领过的条目不能重放，
 * 否则会把同一句话注入两遍。
 */
export const canReAdoptPinItem = (
  id: string,
  diskIds: ReadonlySet<string>,
  inFlightIds: ReadonlySet<string>,
): boolean => !!id && diskIds.has(id) && !inFlightIds.has(id)

/**
 * 用磁盘快照对齐内存队列。
 *
 * 规则：
 *   · 磁盘里的条目 → 全部保留（可能是别的实例刚入队/刚改写的）；
 *   · 内存里有、磁盘没有、但**本实例曾成功落盘** → 丢弃（已被认领或删除）；
 *   · 内存里有、磁盘没有、且从未落盘 → 保留（本实例刚入队，磁盘还不知道）。
 *
 * 旧实现直接 `splice(0, len, ...disk)`，在「刚入队还没落盘」的窗口会把用户消息
 * 当场吞掉；这正是「有时候发有时候不发」的另一半成因。
 */
export const mergePinQueueFromDisk = <T extends { id: string }>(
  disk: ReadonlyArray<T>,
  memory: ReadonlyArray<T>,
  savedIds: ReadonlySet<string>,
): T[] => {
  const diskIds = new Set(disk.map((x) => x.id))
  const unsavedMemory = memory.filter((x) => !!x?.id && !diskIds.has(x.id) && !savedIds.has(x.id))
  return [...disk, ...unsavedMemory]
}
