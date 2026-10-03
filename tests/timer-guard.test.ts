import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"

// 定时器换代自检的"接线断言"。
//
// 背景：热重载会留下旧模块实例，其 setInterval 不会自动清除。因此 tg-bridge 里**每个**
// 定时器都必须在换代后自停（`globalThis[GEN_KEY] !== myGen` → return/clearInterval）。
// R1826 发现 `bgAutoTick`（60s 拍，会 fetchTail + 可能 POST background promote）
// 是**唯一**漏网者 —— 旧实例会持续转后台并刷网络，且每次热重载再累加一个。
// 本测试把"具名定时器函数必须在函数体开头自检"钉死，防止再次漏网。

const src = readFileSync(new URL("../src/tg-bridge.ts", import.meta.url), "utf8")
const lines = src.split("\n")

// 由 setInterval 直接调用的具名 async 函数（见 setInterval(() => { void NAME() })）。
const TIMER_FNS = ["askReconcile", "bgAutoTick", "emitCensus"]

for (const name of TIMER_FNS) {
  test(`定时器函数 ${name} 在函数体开头自检换代 (GEN_KEY)`, () => {
    const start = lines.findIndex((l) => l.includes(`const ${name} =`))
    expect(start).toBeGreaterThanOrEqual(0)
    const head = lines.slice(start, start + 8).join("\n")
    expect(head.includes("GEN_KEY")).toBe(true)
  })
}

test("bgAutoTick 不再是无自检的漏网者（R1826 回归）", () => {
  const start = lines.findIndex((l) => l.includes("const bgAutoTick ="))
  expect(start).toBeGreaterThanOrEqual(0)
  const head = lines.slice(start, start + 8).join("\n")
  expect(head).toContain("GEN_KEY")
})
