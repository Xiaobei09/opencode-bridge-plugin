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

test("VERSION 行存在且为 r 前缀版本号（与特性解耦，避免每次 bump 误报）", () => {
  expect(src).toMatch(/^const VERSION = "r[0-9A-Za-z._-]+"$/m)
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
  // 只补 boot 之后创建或完成的消息（热重载不重推旧历史）。
  // R1894：该基线由 catchupBootAt 改名为 turnNoteBootAt（与 turn-note 共用同一启动基线），
  // 发布仓策展测试曾硬编码旧名 → 整仓 sanitize 同步 live 后此用例变红。
  expect(block).toContain("turnNoteBootAt")
})

test("R1912：跨重载完成的消息（createdAt<boot 但 completedAt>boot）也在补扫范围内", () => {
  const idx = lines.findIndex((l) => l.includes("proto catchup pushed"))
  let start = idx
  while (start > 0 && !lines[start].includes("setInterval(() =>")) start--
  const block = lines.slice(start, idx).join("\n")
  // 双门控：创建于 boot 后（live）或完成于 boot 后（跨重载完成）都应补推；
  // 二者皆 boot 前（旧历史）跳过。
  expect(block).toContain("completedAt")
  expect(block).toMatch(/createdAt > turnNoteBootAt \|\|/)
  expect(block).toContain("completedAt > 0 && completedAt > turnNoteBootAt")
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
