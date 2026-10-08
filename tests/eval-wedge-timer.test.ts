import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { advanceQueueSince } from "../src/auto-continue.ts"

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