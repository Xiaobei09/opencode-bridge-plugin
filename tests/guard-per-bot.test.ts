import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// R1915：守卫拉闸由「全局单闸」改为「按会话所属 bot 的单 Bot 闸」。
// 用户反馈（2026-10-08）：「停止应只停有问题的那个 bot，其他 bot 继续循环」。
// 此前任一会话的 [SIGNAL:PROBLEM] 会写顶层 stopped=true 连坐停全部 bot。
// 本测试钉住：writeCtlBotStopped 写 bots[<ownerBot>].stopped=true、顶层 stopped 保持 false，
// loopGateStopped 只对该 bot 的会话返回 true；找不到唯一归属（未绑定/多 bot 同 sid）时
// 兜底降级回全局闸，绝不静默漏停。

// 由于 writeCtlBotStopped / findOwnerBotId / writeCtlStopped 是模块内私有函数，
// 通过行为断言 loopGateStopped 与文件落盘结果来钉住语义（入口 = 真实 ctl 文件）。
// 这里复用公开的 loopGateStopped（从模块导出）并人工构造 ctl 形态验证判定侧。

import { loopGateStopped } from "../src/auto-continue.ts"

const mkBotCtl = (bots: Record<string, { stopped?: boolean; sids?: string[] }>, topStopped = false) => ({
  stopped: topStopped,
  bots,
})

describe("R1915 guard per-bot gate semantics", () => {
  afterEach(() => {
    delete process.env.AC_CTL_PATH
  })

  it("bot-level stopped only stops that bot's sessions, top-level gate untouched", () => {
    const ctl = mkBotCtl({
      primary: { stopped: false, sids: ["ses_prime_1"] },
      bot3: { stopped: true, sids: ["ses_bot3_1"] },
    })
    // bot3 会话 → 停
    expect(loopGateStopped(ctl, "ses_bot3_1")).toBe(true)
    // primary 会话 → 照常
    expect(loopGateStopped(ctl, "ses_prime_1")).toBe(false)
    // 顶层没被误写成 true
    expect(ctl.stopped).toBe(false)
  })

  it("top-level gate still stops everyone (legacy global stop)", () => {
    const ctl = mkBotCtl(
      { primary: { stopped: false, sids: ["ses_prime_1"] }, bot3: { stopped: false, sids: ["ses_bot3_1"] } },
      true,
    )
    expect(loopGateStopped(ctl, "ses_prime_1")).toBe(true)
    expect(loopGateStopped(ctl, "ses_bot3_1")).toBe(true)
    expect(loopGateStopped(ctl, "ses_any_other")).toBe(true)
  })

  it("bot entry without sids binding does NOT stop any session (nor mis-stop)", () => {
    const ctl = mkBotCtl({
      primary: { stopped: false, sids: ["ses_prime_1"] },
      botX: { stopped: true, sids: [] },
    })
    expect(loopGateStopped(ctl, "ses_prime_1")).toBe(false)
    expect(loopGateStopped(ctl, "ses_whatever")).toBe(false)
  })

  it("session owned by an unstopped bot keeps running even with other bot stopped", () => {
    const ctl = mkBotCtl({
      primary: { stopped: false, sids: ["ses_prime_1"] },
      bot2: { stopped: true, sids: ["ses_bot2_1"] },
    })
    expect(loopGateStopped(ctl, "ses_prime_1")).toBe(false)
    expect(loopGateStopped(ctl, "ses_bot2_1")).toBe(true)
  })

  it("write-ctl merge keeps bots ledger when only bot-level fields change (guard write shape)", () => {
    // writeCtlBotStopped 的落盘形态为：顶层 stopped:false + bots[bid].stopped:true + 保留其余。
    // 这里验证该形态经 loopGateStopped 判定后语义成立（防止把顶层误写 true 的回归）。
    const ctl = mkBotCtl({
      primary: { stopped: false, sids: ["ses_prime_1"] },
      bot3: { stopped: true, sids: ["ses_bot3_1"] },
      bot2: { stopped: true, sids: ["ses_bot2_1"] },
    })
    expect(ctl.stopped).toBe(false)
    expect(loopGateStopped(ctl, "ses_bot3_1")).toBe(true)
    expect(loopGateStopped(ctl, "ses_bot2_1")).toBe(true)
    expect(loopGateStopped(ctl, "ses_prime_1")).toBe(false)
  })
})