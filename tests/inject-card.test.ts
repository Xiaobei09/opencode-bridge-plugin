import { describe, expect, it } from "bun:test"
import {
  injectCardStatePath,
  injectCardText,
  readInjectCardState,
} from "../src/tg-bridge"

// R2228 v3 循环注入状态卡：用户嫌逐条提醒刷屏（125 条）→ 改「单张可编辑状态卡」+「置顶」。
// 卡片文案抽成模块级纯函数（不必起桥即可钉行为），落盘读取按空态容错。
const gateOn = { stopped: false, by: "", reason: "" }

describe("循环注入状态卡文案", () => {
  it("运行态：5 行，含 Bot/轮次/计数/运行中/已置顶", () => {
    const text = injectCardText({
      bot: "bot3",
      lastAt: Date.parse("2026-10-10T10:11:08"),
      kind: "round",
      sid: "ses_eee7ea0d1234abcd",
      count: 125,
      avgGapMs: 121_000,
      gate: gateOn,
      now: Date.now(),
    })
    const lines = text.split("\n")
    expect(lines).toHaveLength(5)
    expect(lines[0]).toContain("循环注入状态卡 · bot3")
    expect(lines[1]).toContain("轮次")
    expect(lines[1]).toContain("ses_eee7ea0d")
    expect(lines[2]).toContain("累计: 125 次")
    expect(lines[3]).toBe("▶ 循环运行中")
    expect(lines[4]).toContain("已置顶")
  })

  it("恢复态与平均间隔格式化", () => {
    const text = injectCardText({
      bot: "primary",
      lastAt: 0,
      kind: "recover",
      sid: "ses_xyz",
      count: 1,
      avgGapMs: 150_000,
      gate: gateOn,
      now: Date.now(),
    })
    expect(text).toContain("恢复")
    expect(text).toContain("平均间隔 2分30秒")
    // lastAt=0 → 回落到 now（不显示 1970）
    expect(text).not.toContain("1970")
  })

  it("无间隔样本显示占位符 —", () => {
    const text = injectCardText({
      bot: "bot2",
      lastAt: Date.now(),
      kind: "round",
      sid: "ses_x",
      count: 1,
      avgGapMs: 0,
      gate: gateOn,
      now: Date.now(),
    })
    expect(text).toContain("平均间隔 —")
  })

  it("停止态展示 by 与 reason（截断 48 字）", () => {
    const text = injectCardText({
      bot: "bot3",
      lastAt: Date.now(),
      kind: "round",
      sid: "ses_x",
      count: 2,
      avgGapMs: 90_000,
      gate: { stopped: true, by: "user", reason: "长".repeat(80) },
      now: Date.now(),
    })
    expect(text).toContain("⏸ 循环已停（by:user）")
    const gateLine = text.split("\n")[3]!
    const reasonSeg = gateLine.split(" · ")[1] ?? ""
    expect(reasonSeg.length).toBe(48)
  })

  it("动态字段统一 htmlEsc（防注入破坏 HTML 解析）", () => {
    const text = injectCardText({
      bot: "b<ot&3>",
      lastAt: Date.now(),
      kind: "round",
      sid: "ses_<x>",
      count: 3,
      avgGapMs: 0,
      gate: { stopped: true, by: "a<b>&c", reason: "" },
      now: Date.now(),
    })
    expect(text).not.toContain("<ot")
    expect(text).not.toContain("<x>")
    expect(text).toContain("b&lt;ot&amp;3&gt;")
    // 卡片自身固定文案里没有裸标签（凡是 < 都必须来自转义实体）
    expect(text).not.toMatch(/[<>]/)
  })
})

describe("状态卡落盘", () => {
  it("路径按 Bot 名拼接，非法字符归一到 x", () => {
    expect(injectCardStatePath("bot3")).toContain("inject-card-bot3.json")
    expect(injectCardStatePath("../../etc/passwd")).toContain("inject-card-x.json")
    expect(injectCardStatePath("bot 3/../x")).toContain("inject-card-x.json")
  })

  it("文件缺失/损坏按空态返回（不抛）", () => {
    const st = readInjectCardState("no-such-bot-for-test")
    expect(st).toEqual({ count: 0, lastAt: 0, lastKind: "round", lastSid: "", avgGapMs: 0 })
    expect(st.msgID).toBeUndefined()
  })
})
