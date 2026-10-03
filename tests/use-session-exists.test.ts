import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"

// R1829 源码断言：`/use` 目标的存在性校验。
//
// 背景：文本 /use 此前只校验 `ses_` 前缀 —— 粘贴一个已删除/不存在的完整 ID 会被静默钉选，
// 之后消息发不出去。修复引入纯函数 sessionIdAcceptable 并在 /use 命中后核对会话列表。

const src = readFileSync(new URL("../src/tg-bridge.ts", import.meta.url), "utf8")

test("R1829：存在性判定纯函数已接线", () => {
  expect(src).toContain("export const sessionIdAcceptable = (id: string, knownIds: readonly string[], listOk: boolean): boolean")
  // 保守放行：查询失败或列表为空时不阻断
  expect(src).toMatch(/if \(!listOk\) return true/)
  expect(src).toMatch(/if \(knownIds\.length === 0\) return true/)
  // 列表可用且非空 → 必须在列表里
  expect(src).toMatch(/return knownIds\.includes\(id\)/)
})

test("R1829：文本 /use 在钉选前核对会话存在性", () => {
  expect(src).toContain("if (!sessionIdAcceptable(id, cachedSessionList.map((s) => s.id), true))")
  expect(src).toContain("会话不存在：")
})
