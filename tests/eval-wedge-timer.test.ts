import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { advanceQueueSince, trackQueuedChain } from "../src/auto-continue.ts"

// R1909：评估链楔子（wedge）看门狗计时回归。
//
// 背景：evaluateQueued 原本在**每次**入队时 `queueSince.set(sessionID, Date.now())`。
// 定时器每 60s 对每个循环目标调一次，而 EVAL_WEDGE_MS=90s —— 计时被反复归零，
// `held` 永远 <90s，看门狗永不触发。症状：某会话评估链一旦挂起（promptAsync/fetch
// 悬挂）就**永久静默停摆**（实测 bot2 停摆 30+ 分钟、无 loop wedge 日志）。
// 修法：只有新链起点（无在途/刚判定 wedge）才取 now，在途链保留原起点。

test("advanceQueueSince：无在途链时取 now（新链起点）", () => {
  expect(advanceQueueSince(undefined, 1000, false)).toBe(1000)
})

test("advanceQueueSince：在途链未 wedge 时保留原起点（不重置计时）", () => {
  expect(advanceQueueSince(500, 60_000, false)).toBe(500)
  expect(advanceQueueSince(500, 89_999, false)).toBe(500)
})

test("advanceQueueSince：判定 wedge（另起新链）后重新计时", () => {
  expect(advanceQueueSince(500, 100_000, true)).toBe(100_000)
})

test("R1909 回归：定时器每 60s 入队不再重置计时，held 能累积过阈值", () => {
  const WEDGE = 90_000
  let since: number | undefined
  let wedged = false
  const helds: number[] = []

  // t=0：定时器首拍，链开始
  since = advanceQueueSince(since, 0, wedged)

  // 之后每 60s 入队一次（链仍挂起，未完成）
  for (const t of [60_000, 120_000]) {
    const held = since === undefined ? 0 : t - since
    wedged = held > WEDGE
    since = advanceQueueSince(since, t, wedged)
    helds.push(held)
  }

  // 旧实现：每次入队把 since 重置为 t → held 恒为 0，看门狗永不触发。
  // 新实现：since 保持 0 → held 递增到 120s > 90s，看门狗触发。
  expect(helds).toEqual([60_000, 120_000])
  expect(wedged).toBe(true)
})

test("evaluateQueued 已接线到 advanceQueueSince（防回退）", () => {
  const src = readFileSync(new URL("../src/auto-continue.ts", import.meta.url), "utf8")
  expect(src).toContain("queueSince.set(sessionID, advanceQueueSince(")
  expect(src).not.toContain("queueSince.set(sessionID, Date.now())")
})

// R1918：链完成后必须清理 queue/queueSince。
// 原实现 finally 里判 `queue.get(sid) === next`，而 queue 存的是 finally 包装后的新
// promise，永不相等 → 清理从不发生 → queueSince 永停首拍 → 看门狗每 ~120s 误报一次
// "loop wedge detected"（实测 ~270 次/小时）。本测试钉死"完成即清理"。
test("R1918：链完成后清理 queue 与 queueSince", async () => {
  const queue = new Map<string, Promise<unknown>>()
  const queueSince = new Map<string, number>()
  const sid = "ses_test_clear"
  const next = Promise.resolve(1)
  trackQueuedChain(next, queue, queueSince, sid, undefined, 1000, false)
  expect(queue.has(sid)).toBe(true)
  expect(queueSince.get(sid)).toBe(1000)
  await next
  await Promise.resolve() // flush finally microtask
  expect(queue.has(sid)).toBe(false)
  expect(queueSince.has(sid)).toBe(false)
})

test("R1918：旧链完成不得误清仍在途的新链", async () => {
  const queue = new Map<string, Promise<unknown>>()
  const queueSince = new Map<string, number>()
  const sid = "ses_test_replace"
  let resolveOld!: () => void
  const oldP = new Promise<void>((r) => {
    resolveOld = r
  })
  trackQueuedChain(oldP, queue, queueSince, sid, undefined, 1000, false)
  let resolveNew!: () => void
  const newP = new Promise<void>((r) => {
    resolveNew = r
  })
  // 在途链（prevSince=1000, wedged=false）→ 保留起点 1000
  trackQueuedChain(newP, queue, queueSince, sid, 1000, 2000, false)
  // 旧链此刻完成：queue 已指向新链，旧链的 finally 不得删除
  resolveOld()
  await oldP
  await Promise.resolve()
  expect(queue.has(sid)).toBe(true)
  expect(queueSince.get(sid)).toBe(1000)
  // 新链完成才清理
  resolveNew()
  await newP
  await Promise.resolve()
  expect(queue.has(sid)).toBe(false)
  expect(queueSince.has(sid)).toBe(false)
})