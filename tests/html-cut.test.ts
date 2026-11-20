import { test, expect } from "bun:test"
import { safeHtmlCut } from "../src/tg-bridge.ts"

// safeHtmlCut 守的是 splitHtmlChunks 的定长切片边界。
//
// 反例（修前）：`i += max` 硬切会把词切进标签/实体内部 →
//   · 片尾 `<b`（无 `>`）：validateHtmlText 不报，Telegram 若 400 则降级纯文本（丢格式）；
//   · 片尾 `&am`/`&`（无 `;`）且该片不含 `<`：发送层 400 降级分支不触发 → noteDrop **整片丢弃**
//     → 用户看到"消息发送不完整"。
// 本测试保证任何片都不会停在未闭合 `<`/`&` 之后，且切片不丢内容、必定前进。

const MAX = 3800

test("普通长行：切点不移动", () => {
  expect(safeHtmlCut("x".repeat(10000), 0, MAX)).toBe(MAX)
})

test("切点落在标签内部 → 回退到 `<`", () => {
  const line = "x".repeat(MAX - 2) + "<b>" + "y".repeat(10)
  const cut = safeHtmlCut(line, 0, MAX)
  expect(cut).toBe(MAX - 2)
  expect(line[cut]).toBe("<")
})

test("切点落在实体内部 → 回退到 `&`", () => {
  const line = "x".repeat(MAX - 2) + "&amp;" + "y".repeat(10)
  const cut = safeHtmlCut(line, 0, MAX)
  expect(cut).toBe(MAX - 2)
  expect(line[cut]).toBe("&")
})

test("完整实体之后的切点不移动", () => {
  const line = "x".repeat(MAX - 5) + "&amp;" + "y".repeat(10)
  expect(safeHtmlCut(line, 0, MAX)).toBe(MAX)
})

test("逐片切片不丢内容，且片尾绝不停在实体/标签中间", () => {
  const line = "a".repeat(MAX - 1) + "&amp;" + "b".repeat(MAX) + "<i>" + "c".repeat(20)
  const chunks: string[] = []
  for (let i = 0; i < line.length; ) {
    const end = safeHtmlCut(line, i, MAX)
    expect(end).toBeGreaterThan(i)
    chunks.push(line.slice(i, end))
    i = end
  }
  expect(chunks.join("")).toBe(line)
  for (const c of chunks) {
    expect(c.lastIndexOf("<") <= c.lastIndexOf(">")).toBe(true)
    expect(c.lastIndexOf("&") <= c.lastIndexOf(";")).toBe(true)
  }
})

test("病态输入仍能前进（不死循环）", () => {
  const line = "<".repeat(MAX) + "end"
  const chunks: string[] = []
  for (let i = 0; i < line.length; ) {
    const end = safeHtmlCut(line, i, MAX)
    expect(end).toBeGreaterThan(i)
    chunks.push(line.slice(i, end))
    i = end
  }
  expect(chunks.join("")).toBe(line)
})
