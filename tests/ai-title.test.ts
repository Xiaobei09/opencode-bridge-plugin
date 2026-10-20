import { describe, expect, it } from "bun:test"
import { sanitizeAiTitle } from "../src/tg-bridge"

describe("AI 改标题结果清洗（R756）", () => {
  it("剥离 Markdown、前缀、引号与循环标记", () => {
    expect(sanitizeAiTitle("**会话标题**：修复 TG 桥标题按钮")).toBe("修复 TG 桥标题按钮")
    expect(sanitizeAiTitle("“Snapshot 优化” [LOOP]")).toBe("Snapshot 优化")
    expect(sanitizeAiTitle("`CI 环境还原`\n多余解释")).toBe("CI 环境还原")
  })

  it("丢掉模型越界返回的后续行与序号", () => {
    expect(sanitizeAiTitle("1. 循环状态检查\n解释：因为……")).toBe("循环状态检查")
  })

  it("不把 HTML/控制字符写进标题，并限制长度", () => {
    expect(sanitizeAiTitle("<b>菜单 UX</b>")).toBe("菜单 UX")
    expect(Array.from(sanitizeAiTitle("abcdefghijk", 5)).join("")).toBe("abcde")
  })
})
