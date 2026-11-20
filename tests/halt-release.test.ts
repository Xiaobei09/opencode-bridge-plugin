import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// R2572：停机解除表「停机 → 解除 → 再停机」。
// 关键回归：用户按 ⏹ 后会话进入 halted；发新消息 / `/loop start` 写解除表；
// 若第二次 ⏹ 没抹掉旧解除条目，auto-continue 会继续驱动该会话 —— 用户看到
// 「按了停止，循环还在跑」。这里直接测共享模块的真实行为。
const dir = mkdtempSync(join(tmpdir(), "halt-release-"))
const file = join(dir, "halt-release.json")
process.env.HALT_RELEASE_PATH = file
const mod = await import("../src/halt-release")

afterAll(() => {
  delete process.env.HALT_RELEASE_PATH
})

const loaded = (hl: unknown[]): string[] => {
  const s = new Set<string>()
  mod.loadHaltedInto(hl, s)
  return [...s]
}

describe("停机解除表状态机", () => {
  it("无解除表时停机保持有效（文件缺失 ≠ 自动恢复）", () => {
    expect(mod.readHaltRelease()).toEqual({})
    expect(loaded(["ses_a"])).toEqual(["ses_a"])
  })

  it("解除后该 sid 被剔除，其他停机不受影响", () => {
    mod.noteHaltRelease(["ses_a"])
    expect(typeof mod.readHaltRelease().ses_a).toBe("number")
    expect(loaded(["ses_a", "ses_b"])).toEqual(["ses_b"])
  })

  it("再次停机必须抹除旧解除条目（取消保持取消）", () => {
    mod.noteHaltArm("ses_a")
    expect("ses_a" in mod.readHaltRelease()).toBe(false)
    expect(loaded(["ses_a", "ses_b"])).toEqual(["ses_a", "ses_b"])
  })

  it("重新停机不影响其他已解除条目", () => {
    mod.noteHaltRelease(["ses_c"])
    expect(loaded(["ses_b", "ses_c"])).toEqual(["ses_b"])
    mod.noteHaltArm("ses_b") // 本就不在解除表：no-op
    expect(loaded(["ses_b", "ses_c"])).toEqual(["ses_b"])
    expect(typeof mod.readHaltRelease().ses_c).toBe("number")
  })

  it("解除表损坏时 fail-safe：停机仍有效，下一次解除可重写", () => {
    writeFileSync(file, "{not-json")
    expect(mod.readHaltRelease()).toEqual({})
    expect(loaded(["ses_d"])).toEqual(["ses_d"])
    mod.noteHaltRelease(["ses_d"])
    expect(typeof JSON.parse(readFileSync(file, "utf8")).ses_d).toBe("number")
  })
})
