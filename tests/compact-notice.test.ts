import { test, expect } from "bun:test"
import { compactHowLine, compactTitle, compactWaterLine, compactLogDelta } from "../src/compact-notice"

// R724：新增 how="autoc"（自动循环压缩成功点经共享总线补报）后，文案判据回归。
// 核心不变量：**未知 ≠ 0** —— after<=0 只报「压缩后水位未知」，绝不显示 0B。

test("autoc：标题为「上下文已压缩」，说明行指明自动循环来源", () => {
  expect(compactTitle("autoc")).toBe("🗜 上下文已压缩")
  expect(compactHowLine("autoc", "").includes("自动循环")).toBe(true)
})

test("未知 ≠ 0：after<=0 明说未知、不出现 0B", () => {
  const line = compactWaterLine(160_000, 0, 200_000)
  expect(line.includes("压缩后水位未知")).toBe(true)
  expect(line.includes("0B")).toBe(false)
})

test("before/after 都有：箭头 + 双侧百分比", () => {
  const line = compactWaterLine(160_000, 34_000, 200_000)
  expect(line.includes("160.0k → 34.0k")).toBe(true)
  expect(line.includes("80%")).toBe(true)
  expect(line.includes("17%")).toBe(true)
})

test("两端都未知：只说发生过压缩", () => {
  const line = compactWaterLine(0, 0, 200_000)
  expect(line.includes("压缩前水位未知")).toBe(true)
  expect(line.includes("压缩后水位未知")).toBe(true)
})

test("日志箭头：未知端用 ?（不出现 ->0 / 0B-> 误读）", () => {
  expect(compactLogDelta(160_000, 0)).toBe("160.0k->?")
  expect(compactLogDelta(0, 34_000)).toBe("?->34.0k")
})
