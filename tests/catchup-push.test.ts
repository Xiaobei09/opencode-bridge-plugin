import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"

// R1827 接线断言：assistant 推送的**轮询补扫**。
//
// 背景：事件驱动路径只在 message.updated 且事件 info.role === "assistant" 时推送。
// 实测非主实例会话多条**带正文**的 assistant 消息完全未推送（proto 无记录），而同期
// tool 消息正常——因为宿主对部分 assistant 消息不发 message.updated（或事件 info 为
// 无 role/parts 的骨架）。修法与 turn-end note 同源：轮询抓 front 会话尾部，补推 proto
// 无记录的正文/思考。本测试把该补扫的关键不变量钉死，防止被误删或漏掉幂等/换代保护。

const src = readFileSync(new URL("../src/tg-bridge.ts", import.meta.url), "utf8")
const lines = src.split("\n")

test("VERSION 已推进到 r1063-catchup", () => {
  expect(src).toContain('const VERSION = "r1063-catchup"')
})

test("补扫间隔存在且有 R1827 标记", () => {
  expect(src).toContain("R1827")
  expect(src).toContain("proto catchup pushed")
})

test("补扫在世代自检（GEN_KEY）之后才触网", () => {
  const idx = lines.findIndex((l) => l.includes("proto catchup pushed"))
  expect(idx).toBeGreaterThanOrEqual(0)
  let start = idx
  while (start > 0 && !lines[start].includes("setInterval(() =>")) start--
  expect(start).toBeGreaterThan(0)
  const block = lines.slice(start, idx).join("\n")
  expect(block).toContain("GEN_KEY")
  const afterFetch = block.indexOf("session.messages")
  expect(afterFetch).toBeGreaterThanOrEqual(0)
  expect(block.slice(afterFetch)).toContain("GEN_KEY")
})

test("补扫幂等：跳过 proto 已有记录的键，且只补 boot 后消息", () => {
  const idx = lines.findIndex((l) => l.includes("proto catchup pushed"))
  let start = idx
  while (start > 0 && !lines[start].includes("setInterval(() =>")) start--
  const block = lines.slice(start, idx).join("\n")
  expect(block).toContain("protoMap.keys()")
  expect(block).toContain("seen")
  expect(block).toContain("catchupBootAt")
})

test("补扫只推正文/思考，且走 full 档 protoPushAssistantMessage", () => {
  const idx = lines.findIndex((l) => l.includes("proto catchup pushed"))
  let start = idx
  while (start > 0 && !lines[start].includes("setInterval(() =>")) start--
  const block = lines.slice(start, idx).join("\n")
  expect(block).toContain('"text"')
  expect(block).toContain('"reasoning"')
  expect(block).toContain('protoPushAssistantMessage(sid, String(chat), m, false, "full")')
})
