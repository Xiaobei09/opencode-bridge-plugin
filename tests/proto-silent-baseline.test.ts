import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { protoSilentVerdict } from "../src/tg-bridge"

// R1898：投递静默 watchdog 基线（lastProtoSendAt）必须在**源头**刷新。
//
// 故障（2026-10-06 实测）：`proto silent 15/30/45min` 连续误报，而同时段日志里
// `proto send ok` / `proto edit ok` 全部正常。根因：基线只在 protoSend 的 3 个分支
// 刷新，编辑重渲染（循环期卡片的**主要**送达方式）、队列/命令回执/菜单/重试投递等
// 7 类成功送达路径各自不刷新 → 编辑活跃而发送稀疏的窗口里基线长期停滞 → 误报。
//
// 修复策略：刷新点下沉到 sendTextRaw / editTextRaw 的每个 `r:"sent"` 返回点
// （全文件仅这 2 个 SendResult 生产者）——一次修，未来新增返回点也不会再漏。
// 本测试钉死两件事：
//   ① 每个 `return { r: "sent"` 之前 3 行内必有基线刷新（新返回点自动被约束）；
//   ② watchdog 仍接线在同一个变量上（防"判据与基线脱钩"的假绿）。

const src = readFileSync(new URL("../src/tg-bridge.ts", import.meta.url), "utf8")
const lines = src.split("\n")

test("每个 sent 返回点之前都刷新 lastProtoSendAt（R1898 源头刷新）", () => {
  const returns: number[] = []
  lines.forEach((l, i) => {
    if (l.includes('return { r: "sent"')) returns.push(i)
  })
  expect(returns.length).toBeGreaterThanOrEqual(5)
  for (const i of returns) {
    const window = lines.slice(Math.max(0, i - 4), i).join("\n")
    expect(window.includes("lastProtoSendAt = Date.now()"), `第 ${i + 1} 行的 sent 返回点缺基线刷新:\n${lines[i]}`).toBe(true)
  }
})

test("watchdog 仍以 lastProtoSendAt 为基线（判据未脱钩）", () => {
  expect(src.includes("protoSilentVerdict(now, lastProtoSendAt, lastProtoSilentWarnAt")).toBe(true)
})

test("SendResult 生产者仅 sendTextRaw/editTextRaw 两个（源头覆盖完整）", () => {
  const producers = lines.filter((l) => l.includes("Promise<SendResult>"))
  expect(producers.length).toBe(2)
})

// R1905：主动暂停推送（pausedMode）时，静默属预期，不得误报"事件流断开"。
// 触发场景（2026-10-08 bot2 实测）：paused=true，会话活跃、lastpush 冻结 >1h，
// 旧判据只看 loopStopped → 每 15min 刷一条"疑似热重载半完成 → 需 reload 桥"的误报。
const NOW = 1_800_000_000_000
const baseOpts = {
  thresholdMs: 15 * 60_000,
  throttleMs: 15 * 60_000,
  loopStopped: false,
  isCurrentGen: true,
}

test("paused=true 时即使静默超阈值也不告警（预期静默）", () => {
  const v = protoSilentVerdict(NOW, NOW - 61 * 60_000, 0, { ...baseOpts, paused: true })
  expect(v.warn).toBe(false)
  expect(v.why).toContain("暂停")
})

test("paused=false 时同样的静默输入会告警（证明 paused 是唯一差异）", () => {
  const v = protoSilentVerdict(NOW, NOW - 61 * 60_000, 0, { ...baseOpts, paused: false })
  expect(v.warn).toBe(true)
})

test("paused 缺省（旧调用形态）等价于未暂停（向后兼容）", () => {
  const v = protoSilentVerdict(NOW, NOW - 61 * 60_000, 0, baseOpts)
  expect(v.warn).toBe(true)
})

test("watchdog 调用点已把 pausedMode 接进判据（防接线脱钩）", () => {
  const i = lines.findIndex((l) => l.includes("protoSilentVerdict(now, lastProtoSendAt"))
  expect(i).toBeGreaterThanOrEqual(0)
  const block = lines.slice(i, i + 8).join("\n")
  expect(block.includes("paused: pausedMode")).toBe(true)
})
