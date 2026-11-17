import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"

// R1896：front/pinned 目标会话默认入循环（2026-10-06 实测故障）。
//
// 故障现象：`eval begin … loop=no -> skip` 每分钟一条，自动循环完全不生效，
// 但会话标题上却还挂着 [LOOP]（marker 由 syncLoopMarker 按闸门状态写，与注册表
// 无关，两套状态漂移）。
//
// 根因：正向注册表 loop-sessions.json 只有"消息带标记词"或"/loop on"时才会被创建；
// 文件不存在（新装/清库/迁移）时，R1839 的"目标保命"合并（persistLoopSessions 内）
// 又被 loopSessionsDirty 挡住永不执行 → front 会话恒 loop=no，死锁。
// 标记词检测（compaction 后窗口里标记文本会消失）只是补充判据，不该是唯一入口。

const src = readFileSync(new URL("../src/auto-continue.ts", import.meta.url), "utf8")
const lines = src.split("\n")

test("eval：注册表初始判定之后紧跟 front 目标兜底", () => {
  const init = lines.findIndex((l) => l.includes("let loop = loopSessions.has(sessionID)"))
  expect(init).toBeGreaterThanOrEqual(0)
  const head = lines.slice(init, init + 18).join("\n")
  // 兜底必须在初始判定同一轮生效，且显式 /loop off 仍然最优先
  expect(head.includes("isLoopTarget(sessionID)")).toBe(true)
  expect(head.includes("!loopOffSessions.has(sessionID)")).toBe(true)
  // 兜底命中即登记 + 置脏，让 persistLoopSessions 真正落盘（打破"文件不存在
  // → dirty 永不置位 → 文件永远不创建"的死锁）
  expect(head.includes("loopSessionsDirty = true")).toBe(true)
})

test("目标兜底在标记词检测之前（标记词只是补充判据）", () => {
  const init = lines.findIndex((l) => l.includes("let loop = loopSessions.has(sessionID)"))
  const fallback = lines.findIndex((l) => l.includes("&& isLoopTarget(sessionID)"))
  const markerScan = lines.findIndex((l, i) => i > init && l.includes("await readRecentUserTexts"))
  expect(fallback).toBeGreaterThan(init)
  expect(markerScan).toBeGreaterThan(fallback)
})
