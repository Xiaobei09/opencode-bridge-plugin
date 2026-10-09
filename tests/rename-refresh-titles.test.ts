import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"

// R1916c（用户指令「注意更新机器人名字」的接续修复）：
// bot 显示名 = 会话标题（renameBotToSession → Telegram setMyName）。但标题的循环状态
// 标记（[LOOP]/[LOOP:OFF]）由 auto-continue 独立进程写，而桥的 sessionTitleCache 只在
// boot 与闸口命令时刷新 → 60s poll 改名周期读到的还是旧标题 → rename (sid|title) 判重
// 静默 no-op。实测：R1916 上线后 bot2/bot3 会话标题已是「xxx [LOOP:OFF]」但 Telegram
// 机器人名不变。修法：poll 改名周期前强制 refreshSessionTitles()。

const src = readFileSync(new URL("../src/tg-bridge.ts", import.meta.url), "utf8")

test("R1916c: 改名周期前强制刷新标题缓存", () => {
  const start = src.indexOf("R1063：改名周期检查")
  expect(start).toBeGreaterThanOrEqual(0)
  const block = src.slice(start, start + 900)
  expect(block).toContain("await refreshSessionTitles()")
  expect(block).toContain("renameBotToSession(cur)")
  // refresh 必须在 rename 之前（await 后再触发改名）
  const refreshIdx = block.indexOf("await refreshSessionTitles()")
  const renameIdx = block.indexOf("renameBotToSession(cur)")
  expect(refreshIdx).toBeGreaterThan(-1)
  expect(renameIdx).toBeGreaterThan(refreshIdx)
})

test("R1916c: 注释记录了根因（cache 陈旧 → 判重 no-op）", () => {
  const start = src.indexOf("R1916c：改名前强制刷新标题缓存")
  expect(start).toBeGreaterThanOrEqual(0)
  const block = src.slice(start, start + 400)
  expect(block).toContain("sessionTitleCache 只在 boot 与闸口命令时")
  expect(block).toContain("陈旧")
})