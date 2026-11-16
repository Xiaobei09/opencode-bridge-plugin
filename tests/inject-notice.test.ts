import { describe, expect, it } from "bun:test"
import {
  fireInjectNotices,
  injectNotifierCount,
  registerInjectNotifier,
  unregisterInjectNotifier,
} from "../src/_v2compat"

// R2228 循环注入提醒（用户需求：循环消息注入时发消息提醒我）：
// 1) 注册后可收到 fire（携带 sessionID + kind）；
// 2) 发送器同步/异步抛错都不影响 fire 主链路（不向上抛）；
// 3) 注销后不再触发；重复注册覆盖旧实现。
describe("循环注入提醒注册表", () => {
  it("注册后 fire 携带 sessionID 与 kind", async () => {
    const seen: Array<{ sessionID: string; kind: string }> = []
    registerInjectNotifier("t1", (sessionID, kind) => {
      seen.push({ sessionID, kind })
    })
    expect(injectNotifierCount()).toBeGreaterThan(0)
    fireInjectNotices("ses_abc123", "round")
    await new Promise((r) => setTimeout(r, 5))
    expect(seen).toEqual([{ sessionID: "ses_abc123", kind: "round" }])
    unregisterInjectNotifier("t1")
    expect(injectNotifierCount()).toBe(0)
  })

  it("fire 不因发送器同步抛错而向上抛", () => {
    registerInjectNotifier("t2", () => {
      throw new Error("boom")
    })
    expect(() => fireInjectNotices("ses_xyz", "recover")).not.toThrow()
    unregisterInjectNotifier("t2")
  })

  it("异步发送器拒绝也被吞掉", async () => {
    registerInjectNotifier("t3", async () => {
      throw new Error("async boom")
    })
    expect(() => fireInjectNotices("ses_xyz", "round")).not.toThrow()
    await new Promise((r) => setTimeout(r, 5))
    unregisterInjectNotifier("t3")
  })

  it("注销后不再触发；重复注册覆盖旧实现", () => {
    const calls: string[] = []
    registerInjectNotifier("t4", () => {
      calls.push("old")
    })
    unregisterInjectNotifier("t4")
    fireInjectNotices("ses_abc", "round")
    expect(calls).toEqual([])
    registerInjectNotifier("t4", () => {
      calls.push("new")
    })
    fireInjectNotices("ses_abc", "round")
    expect(calls).toEqual(["new"])
    unregisterInjectNotifier("t4")
  })
})