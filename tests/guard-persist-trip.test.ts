import { describe, expect, it, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { alreadyTripped, noteGuardTrip, readGuardLastTrip, readGuard, writeGuard } from "../src/loop-guard"

// R1902 守卫持久化判重：
// 事故（2026-10-07）—— bot2 会话一条旧 [STATUS: STOP] 助手消息在**每次部署重启**后
// 重新拉起全局停机闸（in-memory 判重随进程清零），/loop start 清闸只能活到下次重启，
// 用户观感「自动循环又失效了，两个会话都是这样」。
// 修复：lastTrip 落盘带 msgId；alreadyTripped(sid+msgId 一致) = 已判过，放行续跑。

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmpFile = (): string => {
  const d = mkdtempSync(join(tmpdir(), "guard-trip-"))
  dirs.push(d)
  return join(d, "loop-guard.json")
}

describe("alreadyTripped 跨重启持久化判重", () => {
  it("同一 sid+msgId = 已判过（重启后陈旧消息不再拉闸）", () => {
    const t = { sid: "ses_eee6c66c", msgId: "msg_113a975600012sm0ESFohvQ5fL", at: 1 }
    expect(alreadyTripped(t, "ses_eee6c66c", "msg_113a975600012sm0ESFohvQ5fL")).toBe(true)
  })

  it("消息换了（新一轮真宣告）= 没判过，照常拉闸", () => {
    const t = { sid: "ses_eee6c66c", msgId: "msg_old", at: 1 }
    expect(alreadyTripped(t, "ses_eee6c66c", "msg_new")).toBe(false)
  })

  it("会话换了 = 没判过", () => {
    const t = { sid: "ses_A", msgId: "msg_1", at: 1 }
    expect(alreadyTripped(t, "ses_B", "msg_1")).toBe(false)
  })

  it("旧格式记录（无 msgId）一律视为没判过 —— 宁可多判一次写新格式，不静默漏判", () => {
    expect(alreadyTripped({ sid: "ses_A", at: 1 }, "ses_A", "msg_1")).toBe(false)
    expect(alreadyTripped(undefined, "ses_A", "msg_1")).toBe(false)
  })
})

describe("noteGuardTrip 落盘带 msgId", () => {
  it("记录 sid+msgId，readGuardLastTrip 能读回；开关本身不被改动", () => {
    const p = tmpFile()
    writeGuard({ problem: true, websearch: false }, undefined, p)
    noteGuardTrip("problem", "检测到问题", "ses_X", "msg_Y", p)
    const t = readGuardLastTrip(p)
    expect(t?.sid).toBe("ses_X")
    expect(t?.msgId).toBe("msg_Y")
    expect(t?.kind).toBe("problem")
    expect(readGuard(p)).toEqual({ problem: true, websearch: false })
    // 落盘即判据：模拟"重启"（不带任何内存态）也能判出已判过
    expect(alreadyTripped(readGuardLastTrip(p), "ses_X", "msg_Y")).toBe(true)
  })

  it("缺省 msgId 时仍落盘空串字段（结构稳定，读端宽容）", () => {
    const p = tmpFile()
    noteGuardTrip("problem", "r", "ses_X", undefined as unknown as string, p)
    const raw = JSON.parse(readFileSync(p, "utf8"))
    expect(raw.lastTrip.msgId).toBe("")
    expect(alreadyTripped(raw.lastTrip, "ses_X", "")).toBe(false) // 空 msgId 不算判据
  })

  it("事故数据形态：bot2 旧 STOP 记录（旧格式无 msgId）补写后闭环", () => {
    const p = tmpFile()
    // 旧格式（事故时的 loop-guard.json 形态）
    writeFileSync(
      p,
      JSON.stringify({ problem: true, websearch: true, lastTrip: { kind: "problem", reason: "检测到问题", sid: "ses_eee6c66c", at: 1791361281850 }, ts: 1791361281850 })
    )
    const oldMsg = "msg_113a975600012sm0ESFohvQ5fL"
    // 旧格式下：还没判过（会触发一次拉闸，同时写入新格式）
    expect(alreadyTripped(readGuardLastTrip(p), "ses_eee6c66c", oldMsg)).toBe(false)
    noteGuardTrip("problem", "检测到问题", "ses_eee6c66c", oldMsg, p)
    // 新格式下：重启后同一条消息不再拉闸
    expect(alreadyTripped(readGuardLastTrip(p), "ses_eee6c66c", oldMsg)).toBe(true)
  })
})
