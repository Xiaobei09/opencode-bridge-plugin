import { describe, expect, it } from "bun:test"
import { buildMenuKeyboard, MENU_ACTION_TEXT, modelListEntries, resolveModelRef, buildModelKeyboard, MODEL_PAGE_SIZE, modelMenuText } from "../src/tg-bridge"
import type { ModelEntry } from "../src/tg-bridge"

const mk = (over: Partial<ModelEntry> & { key?: string }): ModelEntry => ({
  id: "m1",
  providerID: "opencode",
  name: "Model 1",
  status: "active",
  context: 200000,
  key: "opencode/m1",
  display: "Model 1",
  ...over,
})

const sampleList = modelListEntries({
  data: [
    { providerID: "opencode", id: "big-pickle", name: "Big Pickle", status: "active", limit: { context: 200000 } },
    { providerID: "opencode", id: "exo-free", name: "Exo Free", status: "active", limit: { context: 1048576 } },
    { providerID: "opencode", id: "dead-model", name: "Dead Model", status: "deprecated", limit: { context: 1000 } },
    { providerID: "opencode", id: "disabled-model", name: "Disabled Model", status: "active", enabled: false, limit: { context: 1000 } },
    { providerID: "anthropic", id: "opus", name: "Claude Opus", status: "beta", limit: { context: 200000 } },
    { providerID: "openai", id: "opus", name: "Opus X", status: "active", limit: { context: 200000 } },
  ],
})

describe("modelListEntries（R2231）", () => {
  it("解析 {data:[...]}，剔除 deprecated/禁用的", () => {
    const ids = sampleList.map((m) => m.key)
    expect(ids).toContain("opencode/big-pickle")
    expect(ids).not.toContain("opencode/dead-model")
    expect(ids).not.toContain("opencode/disabled-model")
  })

  it("active 排前，组内按名称排序", () => {
    // beta 的 anthropic/opus 应排在所有 active 之后
    const activeKeys = sampleList.filter((m) => m.status === "active").map((m) => m.key)
    const lastIdx = sampleList.findIndex((m) => m.status !== "active")
    expect(lastIdx).toBeGreaterThanOrEqual(activeKeys.length)
    // 组内名称升序：Big Pickle < Exo Free < Opus X
    expect(sampleList[0]?.key).toBe("opencode/big-pickle")
    expect(sampleList[1]?.key).toBe("opencode/exo-free")
    expect(sampleList[2]?.key).toBe("openai/opus")
  })

  it("空响应/非数组安全回落空表", () => {
    expect(modelListEntries(null)).toEqual([])
    expect(modelListEntries({})).toEqual([])
    expect(modelListEntries([])).toEqual([])
  })
})

describe("resolveModelRef（R2231）", () => {
  const keyOf = (r: { id: string; providerID: string }) => `${r.providerID}/${r.id}`

  it("provider/id 精确命中", () => {
    expect(keyOf(resolveModelRef("anthropic/opus", sampleList) ?? { id: "", providerID: "" })).toBe("anthropic/opus")
  })

  it("id 精确命中（含大小写不敏感）", () => {
    expect(keyOf(resolveModelRef("big-pickle", sampleList) ?? { id: "", providerID: "" })).toBe("opencode/big-pickle")
    expect(keyOf(resolveModelRef("BIG-PICKLE", sampleList) ?? { id: "", providerID: "" })).toBe("opencode/big-pickle")
  })

  it("name 忽略大小写命中", () => {
    expect(keyOf(resolveModelRef("big pickle", sampleList) ?? { id: "", providerID: "" })).toBe("opencode/big-pickle")
  })

  it("跨 provider 同名时优先当前 provider", () => {
    expect(resolveModelRef("opus", sampleList, { providerID: "openai" })?.providerID).toBe("openai")
    expect(resolveModelRef("opus", sampleList, { providerID: "anthropic" })?.providerID).toBe("anthropic")
    // 不指定当前 provider → 首个（active 优先）＝ openai/opus
    expect(resolveModelRef("opus", sampleList)?.providerID).toBe("openai")
  })

  it("唯一模糊包含命中（≥2 字符）", () => {
    expect(keyOf(resolveModelRef("big", sampleList) ?? { id: "", providerID: "" })).toBe("opencode/big-pickle")
  })

  it("空参数/未命中返回 null；@variant 尾巴丢弃", () => {
    expect(resolveModelRef("", sampleList)).toBeNull()
    expect(resolveModelRef("nope-xyz", sampleList)).toBeNull()
    expect(keyOf(resolveModelRef("big-pickle@high", sampleList) ?? { id: "", providerID: "" })).toBe("opencode/big-pickle")
  })
})

describe("buildModelKeyboard（R2231）", () => {
  type Btn = { text: string; callback_data: string }

  it("每模型一行，回调为短编码下标；当前模型带 ✅", () => {
    const kb = buildModelKeyboard(sampleList, 0, "opencode/big-pickle")
    const flat = kb.flat() as Btn[]
    const setBtns = flat.filter((b) => b.callback_data.startsWith("mdl:set:"))
    expect(setBtns.length).toBe(sampleList.length)
    const cur = flat.find((b) => b.text.includes("✅"))
    expect(cur?.text).toContain("Big Pickle")
    // callback_data 全部 ≤ 64 字节（Telegram 硬限）
    for (const b of flat) expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64)
  })

  it("超一页时带翻页行；末页钳制", () => {
    const big = Array.from({ length: MODEL_PAGE_SIZE + 3 }, (_, i) => mk({ id: `m${i}`, name: `Model ${i}`, key: `opencode/m${i}`, display: `Model ${i}` }))
    const kb0 = buildModelKeyboard(big, 0, "")
    const flat0 = kb0.flat() as Btn[]
    expect(flat0.filter((b) => b.callback_data.startsWith("mdl:set:")).length).toBe(MODEL_PAGE_SIZE)
    expect(flat0.some((b) => b.callback_data.startsWith("mdl:pg:"))).toBe(true)
    // 页号越界 → 钳到最后页（第 2 页只剩 3 个模型；翻页行仍在，便于回退）
    const kbLast = buildModelKeyboard(big, 99, "")
    const flatLast = kbLast.flat() as Btn[]
    expect(flatLast.filter((b) => b.callback_data.startsWith("mdl:set:")).length).toBe(3)
    expect(flatLast.some((b) => b.callback_data.startsWith("mdl:pg:"))).toBe(true)
  })

  it("底部固定刷新/关闭；关闭按钮数据 mdl:close", () => {
    const kb = buildModelKeyboard(sampleList, 0, "")
    const last = (kb[kb.length - 1] as Array<{ text: string; callback_data: string }>) ?? []
    expect(last.map((b) => b.callback_data)).toEqual(["mdl:refresh", "mdl:close"])
  })
})

describe("根菜单接入（R2231）", () => {
  it("根菜单出现 🤖 模型入口，且映射到 /model", () => {
    const root = buildMenuKeyboard("root") as Array<Array<{ text: string; callback_data: string }>>
    const all = root.flat()
    const btn = all.find((b) => b.callback_data === "ma:model")
    expect(btn?.text).toContain("模型")
    expect(MENU_ACTION_TEXT["model"]).toBe("/model")
  })
})

// R2231.1：用户实报「列表不能翻页」——真因是文案里写了裸 `/model <名称或 id>`，
// 被 Telegram HTML 解析器当成起始标签 → 每次 editMessageText 都 400，
// 页面永远停在第 1 页。此组测试钉死「选择器文案 HTML 安全」。
const WHITELIST_TAG =
  /<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|span|tg-spoiler|blockquote)(?:\s[^<>]*)?\/?>/g
/** 去掉白名单标签后，若仍残留裸 `<`/`>`，说明文案会被 Telegram 判为非法实体。 */
const hasRawAngleAfterAllowedTags = (s: string): boolean => /[<>]/.test(s.replace(WHITELIST_TAG, ""))

describe("modelMenuText HTML 安全（R2231.1）", () => {
  it("文案无裸角括号（翻页/刷新编辑 400 的根因）", () => {
    const t = modelMenuText("opencode/big-pickle", sampleList)
    expect(hasRawAngleAfterAllowedTags(t)).toBe(false)
    // 明确回归：不得再出现字面量 `<名称或` 之类的伪标签
    expect(t).not.toContain("<名称")
    expect(t).toContain("&lt;名称或 id&gt;")
  })

  it("模型名里的 HTML 元字符被转义（当前模型名不可注入标签）", () => {
    const evil = modelListEntries({
      data: [{ providerID: "opencode", id: "x", name: "<img src=x onerror=alert(1)>", status: "active", limit: { context: 1 } }],
    })
    const t = modelMenuText("opencode/x", evil)
    expect(hasRawAngleAfterAllowedTags(t)).toBe(false)
    expect(t).toContain("&lt;img")
    expect(t).not.toContain("<img")
  })

  it("未找到当前模型时也安全（curKey 空/不匹配）", () => {
    expect(hasRawAngleAfterAllowedTags(modelMenuText("", sampleList))).toBe(false)
    expect(hasRawAngleAfterAllowedTags(modelMenuText("nope/none", sampleList))).toBe(false)
  })
})