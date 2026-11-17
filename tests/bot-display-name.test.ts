import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { botDisplayName } from "../src/tg-bridge"

// R921：用户明确要求「不要搞 bot 代号，直接用用户名」。界面层必须把内部 id
// （primary/bot3/bot4）映射成 registry label，且 label 自带 @ 时不能拼成 @@。
describe("用户可见 Bot 名", () => {
  it("label 的 @ 只出现一次，且不泄露内部 id", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-botname-"))
    const p = join(dir, "tg-bots.json")
    writeFileSync(p, JSON.stringify({ bots: [{ id: "bot3", label: "@codecilbot" }] }))
    expect(botDisplayName("bot3", p)).toBe("@codecilbot")
    expect(botDisplayName("missing", p)).toBe("missing")
  })

  it("label 缺失时退回 id（不伪造用户名）", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-botname-"))
    const p = join(dir, "tg-bots.json")
    writeFileSync(p, JSON.stringify({ bots: [{ id: "primary" }] }))
    expect(botDisplayName("primary", p)).toBe("primary")
  })
})
