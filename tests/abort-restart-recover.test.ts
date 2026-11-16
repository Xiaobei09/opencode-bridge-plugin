import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { classifyAbort } from "../src/abort-classify.ts"

// R1910：区分「进程重启打断的在途回合」与「用户按 ESC」。
//
// 背景：进程重启会打断在途回合（host 在上一实例创建的 assistant 消息上写 error=aborted）。
// 这不是用户撤销。旧代码按"新鲜中止 → pause"处理，pause 分支把该消息 settle() 进 `decided`，
// 而 evaluate 在拿消息后 `if (decided.has(msg.id)) return` 是**唯一不打日志的静默早退** ——
// 该会话此后每 60s 的评估都被它吞掉，永远走不到"超龄(>180s) → recover"分支，
// 症状 = 该会话循环**永久停摆且无任何日志**（实测 bot2 两度停摆 30+ 分钟）。
// 判据：消息 time.created < bootAt（本实例启动时刻）= 上一实例的在途回合被启动杀掉 → recover。

test("R1910：重启打断的在途回合（created<bootAt, 新鲜）→ recover 而非 pause", () => {
  const d = classifyAbort({
    completed: 5_000, // 中止锚点
    created: 4_000, // 上一实例创建 → 早于 bootAt
    lastUserTime: 0,
    staleMs: 180_000,
    now: 10_000, // fresh: now-anchor=5000<180000
    bootAt: 6_000,
  })
  expect(d.fresh).toBe(true)
  expect(d.userAfter).toBe(false)
  expect(d.verdict).toBe("recover") // 旧行为会是 pause → 永久静默停摆
})

test("R1910：重启打断 + 用户随后发言 → skip（不注入恢复提示，防双发）", () => {
  const d = classifyAbort({
    completed: 5_000,
    created: 4_000,
    lastUserTime: 7_000, // > anchor
    staleMs: 180_000,
    now: 10_000,
    bootAt: 6_000,
  })
  expect(d.verdict).toBe("skip")
})

test("R1910 回归：本实例启动之后创建的消息（真·用户 ESC）仍是 pause", () => {
  const d = classifyAbort({
    completed: 7_000,
    created: 7_000, // > bootAt → 不是重启造成
    lastUserTime: 0,
    staleMs: 180_000,
    now: 10_000,
    bootAt: 6_000,
  })
  expect(d.verdict).toBe("pause") // 用户 ESC：仅本轮暂停、下条用户消息恢复（R1553 语义）
})

test("未传 bootAt（缺省）保持老行为：新鲜无后续 → pause", () => {
  const d = classifyAbort({ completed: 5_000, created: 4_000, lastUserTime: 0, staleMs: 180_000, now: 10_000 })
  expect(d.verdict).toBe("pause")
})

test("陈旧中止（超 staleMs）仍 → recover（与 bootAt 判据无关）", () => {
  const d = classifyAbort({
    completed: 5_000,
    created: 7_000, // > bootAt：非重启造成
    lastUserTime: 0,
    staleMs: 180_000,
    now: 205_000, // now-anchor=200000>180000 → stale
    bootAt: 6_000,
  })
  expect(d.verdict).toBe("recover")
})

test("R1910 接线：evaluate 调 classifyAbort 时传了 bootAt", () => {
  const src = readFileSync(new URL("../src/auto-continue.ts", import.meta.url), "utf8")
  expect(src).toContain("bootAt: AC_BOOT_AT")
  expect(src).toContain("const AC_BOOT_AT = Date.now()")
})