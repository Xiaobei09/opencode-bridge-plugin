import {
  floodBackoffSeconds,
  FLOOD_BACKOFF_BASE_S,
  FLOOD_BACKOFF_CAP_S,
  FLOOD_BACKOFF_FLOOR_S,
} from "../src/tg-bridge.ts"
import { test, expect } from "bun:test"

// R1636：速率限制（429）时的**指数退避** —— 纯函数回归。
// 背景：旧 floodWaitSeconds 是平的 —— 连着挨几次 429，只要 retry_after 一样大，
// 等待就一样长，"冷却结束→再打→再 429"固定节奏无限循环。
// 全部用 jitter:0 + rand:0 做确定化，只测退避本体。

const nb = (attempt: number, retryAfter?: number): number =>
  floodBackoffSeconds({ attempt, retryAfter, jitter: 0 })

test("首次 429（attempt=1）= base，与旧默认 60s 一致（行为不回退）", () => {
  expect(nb(1)).toBe(FLOOD_BACKOFF_BASE_S)
  expect(nb(1)).toBe(60)
})

test("连续 429 等待时间翻倍：60 → 120 → 240 → 480 → 900（封顶）", () => {
  expect([1, 2, 3, 4, 5, 6, 7].map((n) => nb(n))).toEqual([60, 120, 240, 480, 900, 900, 900])
})

test("封顶后不再增长，长期限流不会把等待推到无穷", () => {
  expect(nb(50)).toBe(FLOOD_BACKOFF_CAP_S)
  expect(nb(1000)).toBe(FLOOD_BACKOFF_CAP_S)
  // 极端 attempt 不许溢出成 Infinity / NaN
  expect(Number.isFinite(nb(1e9))).toBe(true)
})

test("尊重 retry_after：指数项更小则用 retry_after（绝不早于 Telegram 允许）", () => {
  // attempt=1 → 指数 60 < retry_after 300 ⇒ 取 300
  expect(nb(1, 300)).toBe(300)
  // retry_after 巨大时按 cap 收敛（不无限等）
  expect(nb(1, 52435)).toBe(FLOOD_BACKOFF_CAP_S)
  // retry_after 极小时仍用指数项（我们主动更保守）
  expect(nb(3, 1)).toBe(240)
})

test("retry_after 下限 5s：比下限小的值被抬到下限", () => {
  // 需要指数项本身 < 5s 才看得到下限生效：把 base 压到 1s。
  expect(floodBackoffSeconds({ attempt: 1, retryAfter: 0.2, baseSeconds: 1, jitter: 0 })).toBe(FLOOD_BACKOFF_FLOOR_S)
  expect(floodBackoffSeconds({ attempt: 1, retryAfter: 1, baseSeconds: 1, jitter: 0 })).toBe(FLOOD_BACKOFF_FLOOR_S)
  expect(FLOOD_BACKOFF_FLOOR_S).toBe(5)
  // 默认 base=60 时指数项本就 > 下限 → 取 60（这正是"绝不早于 Telegram"的表现）
  expect(nb(1, 1)).toBe(FLOOD_BACKOFF_BASE_S)
})

test("不变量：返回值永远 ≥ Telegram 给的 retry_after（含抖动）", () => {
  for (const ra of [1, 5, 30, 300, 3600]) {
    for (let attempt = 1; attempt <= 8; attempt++) {
      for (const rand of [0, 0.25, 0.5, 0.999]) {
        const got = floodBackoffSeconds({ retryAfter: ra, attempt, rand })
        expect(got).toBeGreaterThanOrEqual(Math.min(FLOOD_BACKOFF_CAP_S, ra))
      }
    }
  }
})

test("成功一次后 attempt 归 1 → 等待回到 base（退避可恢复，不会永久变慢）", () => {
  const afterMany = nb(6) // 900
  expect(afterMany).toBe(FLOOD_BACKOFF_CAP_S)
  expect(nb(1)).toBe(FLOOD_BACKOFF_BASE_S) // streak 清零后的下一次
})

test("attempt 缺省/0/非法值按首次处理，不产生 NaN", () => {
  for (const a of [undefined, 0, -1, NaN] as const) {
    const v = floodBackoffSeconds({ attempt: a as number | undefined, jitter: 0 })
    expect(Number.isFinite(v)).toBe(true)
    expect(v).toBe(FLOOD_BACKOFF_BASE_S)
  }
  expect(Number.isFinite(floodBackoffSeconds({ retryAfter: NaN, attempt: NaN, jitter: 0 }))).toBe(true)
  expect(Number.isFinite(floodBackoffSeconds({ retryAfter: -99, attempt: 2, jitter: 0 }))).toBe(true)
})

test("抖动：默认 25% 上限，rand 越大等越久；jitter=0 完全确定", () => {
  const at = (rand: number, attempt = 2): number => floodBackoffSeconds({ attempt, rand })
  expect(at(0)).toBe(120) // 无抖动增量
  expect(at(0.5)).toBe(135) // 120 * 1.125
  expect(at(1 - 1e-9)).toBeLessThanOrEqual(Math.round(120 * 1.25)) // 不超 25%
  // jitter:0 时与 rand 无关
  expect(floodBackoffSeconds({ attempt: 3, rand: 0.99, jitter: 0 })).toBe(240)
  expect(floodBackoffSeconds({ attempt: 3, rand: 0, jitter: 0 })).toBe(240)
})

test("cap < base 时以 base 为准（不会退化成比首次还短）", () => {
  const v = floodBackoffSeconds({ attempt: 5, baseSeconds: 300, capSeconds: 10, jitter: 0 })
  expect(v).toBe(300)
})

test("退避序列单调不减（等待只会越来越保守，绝不抖动回落）", () => {
  let prev = 0
  for (let attempt = 1; attempt <= 12; attempt++) {
    const v = nb(attempt)
    expect(v).toBeGreaterThanOrEqual(prev)
    prev = v
  }
})
