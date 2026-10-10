import { describe, expect, it } from "bun:test"
import { idleVerdict } from "../src/_v2compat"

// 行形状与 client.session.messages 返回一致：{ info: { role, time:{created,completed}, finish }, parts }
type Row = {
  info: {
    role: string
    time: { created: number; completed?: number }
    finish?: string
    // 压缩行（rowToV1 把 type=compaction 渲染成 role=assistant 的"假完成消息"）
    compaction?: boolean
    compactionStatus?: string
  }
  parts?: any[]
}
const asst = (created: number, completed: number, parts: any[] = [], finish?: string): Row => ({
  info: { role: "assistant", time: { created, completed }, finish },
  parts,
})
const compact = (created: number, status = "started"): Row => ({
  info: { role: "assistant", time: { created, completed: created }, compaction: true, compactionStatus: status },
  parts: [],
})
const running = (created: number, completed: number, tool: string, status: string): Row => ({
  info: { role: "assistant", time: { created, completed } },
  parts: [{ type: "tool", tool, state: { status } }],
})
const user = (created: number): Row => ({ info: { role: "user", time: { created } } })

describe("idleVerdict —— 回合真空闲判据（R2232）", () => {
  it("空会话 = 无助手，不空闲", () => {
    expect(idleVerdict({ rows: [], now: 1000 }).idle).toBe(false)
    expect(idleVerdict({ rows: [], now: 1000 }).why).toBe("no-assistant")
  })

  it("最后一条 assistant 未完成（completed=0）= 不空闲", () => {
    const v = idleVerdict({ rows: [asst(100, 0)], now: 200 })
    expect(v.idle).toBe(false)
    expect(v.why).toBe("assistant-in-flight")
  })

  it("已完成且刚过落定窗口、无更新消息、无工具 = 空闲", () => {
    const v = idleVerdict({ rows: [user(50), asst(100, 150)], now: 5000, settleMs: 4000 })
    expect(v.idle).toBe(true)
    expect(v.why).toBe("settled")
  })

  // ── 核心回归：用户实报「循环提示词在没有输出完成时注入」─────────────────────
  // DB 实证 bot3 2026-10-10：inject 10:48:09.218 参照的步已于 10:48:08.751 completed，
  // 但**下一步 10:48:08.773 已在跑**（到 10:48:14.412 才完成）。旧判据只看 completed
  // 就放行 → 注入插进正在跑的回合。此例必须判否。
  it("回归：一步 completed 后 ~20ms 就落盘下一步（仍在跑）→ 不空闲", () => {
    const stepN = asst(1000, 1000 + 8000) // completed 到 9000
    const stepN1 = asst(9000 + 22, 0) // 下一步 22ms 后开跑，仍在跑
    const v = idleVerdict({ rows: [user(500), stepN, stepN1], now: 9000 + 445, settleMs: 4000 })
    expect(v.idle).toBe(false)
    // 末尾那条 assistant 尚未完成
    expect(v.why).toBe("assistant-in-flight")
  })

  it("回归：最新消息是晚于上一步 completed 的 user（回合刚开始）→ newer-message", () => {
    const stepN = asst(1000, 9000)
    const u = user(9010)
    const v = idleVerdict({ rows: [stepN, u], now: 9000 + 445, settleMs: 4000 })
    expect(v.idle).toBe(false)
    expect(v.why).toBe("newer-message")
  })

  // ── 最可靠的一票：finish=tool-calls = 回合没结束（宿主马上还会跑下一步）──────────
  // DB 实证 bot3 2026-10-10：坏注入 11:02:51.498 前那步（11:02:25.936→11:02:51.494）
  // finish=tool-calls，宿主随后又跑了 11:02:51.513→11:02:55.205（也 tool-calls），
  // 直到 11:02:55.223 finish=stop 回合才收尾（随后 idle outcome=succeeded）。
  // 只看 completed 会把中间步当回合结束 → 注入插进还在续跑的回合。
  it("回归：最后一步 finish=tool-calls（回合续跑）→ 不空闲，即使已 completed 且过了落定窗口", () => {
    const step = asst(1000, 9000, [], "tool-calls")
    const v = idleVerdict({ rows: [user(500), step], now: 90_000, settleMs: 4000 })
    expect(v.idle).toBe(false)
    expect(v.why).toBe("turn-continues(tool-calls)")
  })

  it("finish=tool_calls（下划线写法）同样识别为续跑", () => {
    const step: Row = { info: { role: "assistant", time: { created: 1000, completed: 9000 }, finish: "tool_calls" }, parts: [] }
    expect(idleVerdict({ rows: [step], now: 90_000, settleMs: 4000 }).idle).toBe(false)
  })

  it("最后一步 finish=stop（回合收尾）→ 到落定窗口即空闲", () => {
    const step = asst(1000, 9000, [], "stop")
    expect(idleVerdict({ rows: [step], now: 14000, settleMs: 4000 }).idle).toBe(true)
  })

  it("回归：即使下一步尚未落盘，completed 距今 < 落定窗口也不放行（settling）", () => {
    const v = idleVerdict({ rows: [user(500), asst(1000, 9000)], now: 9000 + 20, settleMs: 4000 })
    expect(v.idle).toBe(false)
    expect(v.why).toBe("settling-0s")
  })

  it("落定窗口边界：刚好达到 settleMs 即放行", () => {
    const v = idleVerdict({ rows: [asst(1000, 9000)], now: 13000, settleMs: 4000 })
    expect(v.idle).toBe(true)
  })

  it("尾段有 running/pending 工具 = 不空闲", () => {
    expect(idleVerdict({ rows: [asst(100, 150), running(200, 250, "bash", "running")], now: 9000 }).idle).toBe(false)
    expect(idleVerdict({ rows: [asst(100, 150), running(200, 250, "bash", "pending")], now: 9000 }).idle).toBe(false)
    // 已完成/失败的工具不算
    expect(idleVerdict({ rows: [asst(100, 150), running(200, 250, "bash", "completed")], now: 9000 }).idle).toBe(true)
  })

  it("事件静默期：最近有事件（lastEventTs）→ 不空闲", () => {
    const v = idleVerdict({ rows: [asst(100, 150)], now: 9000, lastEventTs: 8500, eventSettleMs: 10000 })
    expect(v.idle).toBe(false)
    expect(v.why).toBe("event-1s-ago")
  })

  it("事件静默期可不传（auto-continue 由事件驱动，传了会恒判否）", () => {
    expect(idleVerdict({ rows: [asst(100, 150)], now: 9000, settleMs: 0 }).idle).toBe(true)
  })

  // ── 回归：压缩（compaction）被 rowToV1 渲染成 role=assistant 的"假完成消息"，骗过 ③ ──
  // DB 实证 bot3 2026-10-10：12:09:53.689 决策参照 msg=msg_125b7fda7001（=seq 8545，
  // type=compaction，len=46 正是压缩 header），结果注进了正在压缩的会话（下一个 assistant
  // 直到 12:11:29 才落盘）。压缩行的 info 无 finish，若不识别会被当"回合已 stop"。
  it("回归：进行中的压缩（compactionStatus!=completed）在最尾 → 不空闲", () => {
    const v = idleVerdict({ rows: [asst(100, 150, [], "stop"), compact(9400, "started")], now: 90_000, settleMs: 4000 })
    expect(v.idle).toBe(false)
    expect(v.why).toBe("compaction-in-flight")
  })

  it("回归：压缩行即使（错误地）标成 completed，也不当作助手回合 → 看真实助手状态", () => {
    // 前一条真实助手 finish=tool-calls ⇒ 回合未结束，压缩行不该"洗白"成空闲
    const v = idleVerdict({ rows: [asst(100, 150, [], "tool-calls"), compact(9400, "completed")], now: 90_000, settleMs: 4000 })
    expect(v.idle).toBe(false)
    expect(v.why).toBe("turn-continues(tool-calls)")
  })

  it("已完成的压缩 + 前面助手 finish=stop → 正常空闲（压缩不阻断收尾回合）", () => {
    const v = idleVerdict({ rows: [asst(100, 150, [], "stop"), compact(9400, "completed")], now: 90_000, settleMs: 4000 })
    expect(v.idle).toBe(true)
  })
})
