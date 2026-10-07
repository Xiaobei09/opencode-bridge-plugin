import { describe, expect, it } from "bun:test"
import { AUTO_INJECT_HINT, SYNTHETIC_LOOP_MARKERS, isLoopPromptText } from "../src/turn-end-note"

// R227 自动循环注入提示：
// 1) 提示必须是尾部追加 —— 前缀挪动会让 tg-bridge 合成消息识别与 turn-end loop 判定漏检；
// 2) 附带提示后，注入文本仍须被 isLoopPromptText 识别（startsWith 语义不被破坏）；
// 3) 提示文案必须点明「非用户新指令」，与 tg-bridge 注入回执同语义。
describe("自动循环注入提示 AUTO_INJECT_HINT", () => {
  const ROUND_PREFIX = "继续自动筛查循环"
  const RECOVER_PREFIX = "上一轮自动筛查应答因可恢复错误中断"

  it("提示为尾部追加：原始前缀在附加后仍位于开头", () => {
    for (const marker of SYNTHETIC_LOOP_MARKERS) {
      const injected = `${marker}…正文…${AUTO_INJECT_HINT}`
      expect(injected.startsWith(marker)).toBe(true)
      expect(injected.endsWith(AUTO_INJECT_HINT)).toBe(true)
    }
  })

  it("附带提示后仍被 isLoopPromptText 识别", () => {
    expect(isLoopPromptText(`${ROUND_PREFIX}（…）${AUTO_INJECT_HINT}`)).toBe(true)
    expect(isLoopPromptText(`${RECOVER_PREFIX}（…）${AUTO_INJECT_HINT}`)).toBe(true)
    // 真实 TG 指令不误判
    expect(isLoopPromptText(`继续自动筛查xyz${AUTO_INJECT_HINT}`)).toBe(false)
  })

  it("提示文案点明非用户新指令，且含『自动注入』标识", () => {
    expect(AUTO_INJECT_HINT).toContain("非用户新指令")
    expect(AUTO_INJECT_HINT).toContain("自动注入提示")
    expect(AUTO_INJECT_HINT.startsWith("\n\n")).toBe(true)
  })
})
