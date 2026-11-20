import { describe, expect, it } from "bun:test"
import { injectCardText } from "../src/tg-bridge"

// R923：用户要求置顶「循环状态卡」也显示会话实时状态，而不只是 /loop status 文本。
// 旧调用不传 sessionState 时保持原卡片文案，避免破坏兼容。
const base = {
  bot: "@demo",
  lastAt: Date.now(),
  kind: "round",
  sid: "ses_sanitized01",
  count: 1,
  avgGapMs: 0,
  gate: { stopped: false, by: "", reason: "" },
  now: Date.now(),
  session: "@demo",
  queue: 0,
  pinQueue: 0,
  paused: false,
}

describe("循环状态卡会话状态", () => {
  it("显示运行中", () => {
    const text = injectCardText({ ...base, sessionState: "运行中" })
    expect(text).toContain("状态=运行中")
  })

  it("显示 outcome 与空闲时长", () => {
    const text = injectCardText({ ...base, sessionState: "completed（空闲 3m）" })
    expect(text).toContain("状态=completed（空闲 3m）")
  })

  it("旧调用不传 sessionState 时保持兼容", () => {
    const text = injectCardText(base)
    expect(text).not.toContain("状态=")
  })
})
