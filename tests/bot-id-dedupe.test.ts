import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// R2571：不同 token secret 但相同数字前缀 = 同一个 Telegram bot。
// 只做“同 token”去重不够：两个实例会抢 getUpdates → 409/随机重复回复。
// 这里直接测入口导出的选择函数（不启动 setup，不发真实 Telegram 请求）。
const dir = mkdtempSync(join(tmpdir(), "tg-botid-"))
process.env.TG_BOTS_PATH = join(dir, "tg-bots.json")
process.env.TG_BRIDGE_DIAG_LOG = join(dir, "diag.log")
writeFileSync(process.env.TG_BOTS_PATH, JSON.stringify({ bots: [] }))
const mod = await import("../src/tg-bridge-v2")

const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

const env = (name: string, token: string): string => {
  const p = join(dir, name)
  writeFileSync(p, `TG_BOT_TOKEN=${token}\n`)
  return p
}

globalThis.fetch = (async (url: string | URL | Request) => {
  const tok = String(url).split("/bot")[1]?.split("/getMe")[0] ?? ""
  if (tok.startsWith("40004:FFFF")) throw new Error("network down")
  if (tok.startsWith("20002:DDDD")) {
    return new Response(JSON.stringify({ ok: true, result: { id: 20002 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  })
}) as typeof fetch

describe("同一 Telegram bot 只保留一个轮询者", () => {
  it("token 数字前缀就是 bot id", () => {
    expect(mod.tokenBotId("8964069383:secret")).toBe("8964069383")
    expect(mod.tokenBotId("not-a-token")).toBe("")
  })

  it("primary 同 bot id 时永远保留（通知/修复入口）", async () => {
    const r = await mod.selectPollerPerBotId([
      { id: "primary", envFile: env("primary.env", "10001:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") },
      { id: "botx", envFile: env("botx.env", "10001:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB") },
    ])
    expect(r.kept.map((b) => b.id)).toEqual(["primary"])
    expect(r.dropped).toHaveLength(1)
    expect(r.dropped[0].desc).toContain("duplicate bot id 10001")
  })

  it("吊销 token 在前也不挤掉后面的可用 token（bot4/bot5 实况）", async () => {
    const r = await mod.selectPollerPerBotId([
      { id: "bot4", envFile: env("bot4.env", "20002:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC") },
      { id: "bot5", envFile: env("bot5.env", "20002:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD") },
    ])
    expect(r.kept.map((b) => b.id)).toEqual(["bot5"])
    expect(r.dropped).toHaveLength(1)
    expect(r.dropped[0].desc).toContain("duplicate bot id 20002")
  })

  it("确定吊销 vs 网络抖动：保留可恢复的条目", async () => {
    const r = await mod.selectPollerPerBotId([
      { id: "bot8", envFile: env("bot8.env", "40004:GGGGGGGGGGGGGGGGGGGGGGGGGGGGGG") },
      { id: "bot7", envFile: env("bot7.env", "40004:FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF") },
    ])
    expect(r.kept.map((b) => b.id)).toEqual(["bot7"])
    expect(r.dropped).toHaveLength(1)
    expect(r.dropped[0].desc).toContain("duplicate bot id 40004")
  })

  it("无重复 bot id 时全部保留", async () => {
    const r = await mod.selectPollerPerBotId([
      { id: "bot4", envFile: env("bot4.env", "20002:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC") },
      { id: "bot6", envFile: env("bot6.env", "30003:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEE") },
    ])
    expect(r.kept.map((b) => b.id)).toEqual(["bot4", "bot6"])
    expect(r.dropped).toHaveLength(0)
  })
})
