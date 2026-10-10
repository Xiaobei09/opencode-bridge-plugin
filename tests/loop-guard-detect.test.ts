import { describe, expect, it } from "bun:test"
import { detectGuardSignals, guardVerdict, loopPauseDecl, DEFAULT_GUARD } from "../src/loop-guard"

// 循环「自动停止守卫」的**纯判据**回归测试（此前仅有 alreadyTripped/noteGuardTrip 的持久化测试）。
// 为什么必须有：这两类判据是守卫的失效模式两端 ——
//   · 误报（false-positive）：报告里**复述**循环规则（必然出现 [STATUS: CONTINUE/STOP] 字面文本）
//     或代码块里**提及**标记时若被判停 → 循环一装即死（历史事故 2026-09-28 [LOOP:PAUSE]）。
//   · 漏报（false-negative）：真正的独占行宣告若因换行/加粗变体不匹配 → 守卫形同虚设，问题不被拦停。
// 判据只认**独占一行**（允许 markdown 标题/加粗/`[ROUND n]+` 前缀），且先挖空围栏代码块与行内代码。

describe("detectGuardSignals · 文本通道（独占行）", () => {
  it("独占行 [STATUS: STOP] → problem=''（宣告停机，无原因）", () => {
    expect(detectGuardSignals("[STATUS: STOP]", []).problem).toBe("")
  })
  it("加粗包裹 **[STATUS: STOP]** → 仍命中", () => {
    expect(detectGuardSignals("**[STATUS: STOP]**", []).problem).toBe("")
  })
  it("标题 + ROUND 前缀 ## [ROUND 5]+[STATUS: STOP] → 仍命中", () => {
    expect(detectGuardSignals("## [ROUND 5]+[STATUS: STOP]", []).problem).toBe("")
  })
  it("[STATUS: CONTINUE] → 不命中（续跑不是停止）", () => {
    expect(detectGuardSignals("[STATUS: CONTINUE]", []).problem).toBeUndefined()
  })
  it("规则复述里的字面文本 [STATUS: CONTINUE/STOP] 在行内 → 不命中", () => {
    expect(detectGuardSignals("输出 [ROUND n]+[STATUS: CONTINUE/STOP]", []).problem).toBeUndefined()
  })
  it("标记夹在正文中间（非独占行）→ 不命中", () => {
    expect(detectGuardSignals("我必须输出 [STATUS: STOP] 才行", []).problem).toBeUndefined()
  })
  it("独占行 [SIGNAL:PROBLEM: 原因] → problem=原因", () => {
    expect(detectGuardSignals("[SIGNAL:PROBLEM: 数据库锁竞争]", []).problem).toBe("数据库锁竞争")
  })
  it("独占行 [SIGNAL: WEBSEARCH: 要查什么] → websearch=要查什么", () => {
    expect(detectGuardSignals("[SIGNAL: WEBSEARCH: 查 X 的 API 文档]", []).websearch).toBe("查 X 的 API 文档")
  })
})

describe("detectGuardSignals · 代码挖空（提及≠宣告）", () => {
  it("围栏代码块内的 [STATUS: STOP] → 不命中", () => {
    expect(detectGuardSignals("```\n[STATUS: STOP]\n```", []).problem).toBeUndefined()
  })
  it("行内代码 `[STATUS: STOP]` → 不命中", () => {
    expect(detectGuardSignals("`[STATUS: STOP]`", []).problem).toBeUndefined()
  })
  it("行内代码 [SIGNAL:PROBLEM] → 不命中", () => {
    expect(detectGuardSignals("说明：`[SIGNAL:PROBLEM: 举例]` 只在需要时写", []).problem).toBeUndefined()
  })
  it("空文本 → 无任何信号", () => {
    const s = detectGuardSignals("", [])
    expect(s.problem).toBeUndefined()
    expect(s.websearch).toBeUndefined()
  })
})

describe("detectGuardSignals · parts 通道（客观事实：真调了搜索工具）", () => {
  it("tool=websearch → websearch 被置位", () => {
    expect(detectGuardSignals("随便写点", [{ type: "tool", tool: "websearch" }]).websearch).toContain("websearch")
  })
  it("tool=shell → 不命中（不做 /search/i 泛匹配，避免误停）", () => {
    expect(detectGuardSignals("随便写点", [{ type: "tool", tool: "shell" }]).websearch).toBeUndefined()
  })
  it("非 tool 类型 part 被忽略", () => {
    expect(detectGuardSignals("x", [{ type: "text", tool: "websearch" }]).websearch).toBeUndefined()
  })
})

describe("guardVerdict · 开关 × 信号", () => {
  it("problem 开 + [STATUS: STOP] → trip, kind=problem", () => {
    const v = guardVerdict({ problem: true, websearch: true }, { problem: "" })
    expect(v.trip).toBe(true)
    expect(v.kind).toBe("problem")
  })
  it("problem 关 → 该类信号不拉闸", () => {
    const v = guardVerdict({ problem: false, websearch: true }, { problem: "有大事" })
    expect(v.trip).toBe(false)
  })
  it("websearch 开 + 工具信号 → trip, kind=websearch", () => {
    const v = guardVerdict({ problem: true, websearch: true }, { websearch: "查东西" })
    expect(v.trip).toBe(true)
    expect(v.kind).toBe("websearch")
  })
  it("两类同时命中 → kind 取 problem（有问题比要搜索更需要人来）", () => {
    const v = guardVerdict({ problem: true, websearch: true }, { problem: "p", websearch: "w" })
    expect(v.kind).toBe("problem")
    expect(v.reason).toContain("检测到问题")
    expect(v.reason).toContain("网页搜索请求")
  })
  it("默认配置 = problem/websearch 全开", () => {
    expect(DEFAULT_GUARD).toEqual({ problem: true, websearch: true })
  })
})

describe("loopPauseDecl · [LOOP: PAUSE] 宣告", () => {
  it("独占行 → declared=true, reason 取冒号后内容", () => {
    expect(loopPauseDecl("[LOOP: PAUSE: 等用户决定]")).toEqual({ declared: true, reason: "等用户决定" })
  })
  it("无原因 → declared=true, reason=''", () => {
    expect(loopPauseDecl("[LOOP: PAUSE]")).toEqual({ declared: true, reason: "" })
  })
  it("行内代码 `[LOOP: PAUSE]` → 不宣告", () => {
    expect(loopPauseDecl("`[LOOP: PAUSE]`").declared).toBe(false)
  })
  it("围栏代码块内 → 不宣告", () => {
    expect(loopPauseDecl("```\n[LOOP: PAUSE]\n```").declared).toBe(false)
  })
  it("正文中间提及 → 不宣告", () => {
    expect(loopPauseDecl("我不该写 [LOOP: PAUSE] 这种话").declared).toBe(false)
  })
})
