import { describe, expect, it } from "bun:test"
import { buildMenuKeyboard, MENU_ACTION_TEXT } from "../src/tg-bridge"

type Btn = { text: string; callback_data: string }

const rows = (view: string, opts: Parameters<typeof buildMenuKeyboard>[1] = {}): Btn[][] =>
  buildMenuKeyboard(view, opts) as Btn[][]

const flat = (view: string, opts: Parameters<typeof buildMenuKeyboard>[1] = {}): Btn[] =>
  rows(view, opts).flat() as Btn[]

// R231 菜单整理（小步1：根菜单）：对着**真定义**检查，避免"测试抄字面量、真菜单坏了溜过去"。
describe("根菜单整理", () => {
  it("根菜单 3 行 × 2 键，末行不再孤悬单个按钮", () => {
    const r = rows("root")
    expect(r).toHaveLength(3)
    for (const row of r) expect(row).toHaveLength(2)
  })

  it("五个分页入口齐备，且后台/系统不再同图标", () => {
    const f = flat("root")
    const data = f.map((x) => x.callback_data)
    for (const v of ["m:sess", "m:push", "m:loop", "m:bg", "m:sys"]) {
      expect(data).toContain(v)
    }
    const bg = f.find((x) => x.callback_data === "m:bg")
    const sys = f.find((x) => x.callback_data === "m:sys")
    expect(bg?.text.startsWith("⚙")).toBe(true)
    expect(sys?.text.startsWith("🛠")).toBe(true)
  })

  it("根菜单每个 ma: 动作都能映射到文本命令（缺映射=点了只回未知动作）", () => {
    for (const btn of flat("root")) {
      if (btn.callback_data.startsWith("ma:")) {
        const key = btn.callback_data.slice(3)
        expect(MENU_ACTION_TEXT[key]).toBeTruthy()
      }
    }
  })

  it("所有视图的 ma: 动作均有映射（回归防护）", () => {
    for (const view of ["root", "sess", "push", "loop", "bg", "sys"]) {
      for (const btn of flat(view)) {
        if (btn.callback_data.startsWith("ma:")) {
          const key = btn.callback_data.slice(3)
          expect(MENU_ACTION_TEXT[key], `${view}/${btn.text}`).toBeTruthy()
        }
      }
    }
  })

  // R234 sys 页分组重排：诊断置顶、危险动作成对集中、除「返回」外全部成对（消除孤行）。
  it("sys 页 10 行：前 9 行成对，仅末行返回按钮独立", () => {
    const r = rows("sys")
    expect(r).toHaveLength(10)
    for (let i = 0; i < 9; i++) expect(r[i], `row ${i}`).toHaveLength(2)
    expect(r[9]).toHaveLength(1)
    expect(r[9][0].callback_data).toBe("m:root")
  })

  it("sys 页首行是只读诊断（info/digest），两个丢弃按钮成对同排且位于诊断之后", () => {
    const r = rows("sys")
    const firstData = r[0].map((x) => x.callback_data)
    expect(firstData).toContain("ma:info")
    expect(firstData).toContain("ma:digest")
    const dropRow = r.findIndex((row) => row.some((x) => x.callback_data === "ma:drop"))
    expect(dropRow).toBeGreaterThan(2) // 诊断/日志/列表排在危险动作之前
    expect(r[dropRow].map((x) => x.callback_data)).toContain("ma:dropq") // 两个 🗑 同排
  })

  // R234 子页整理小步4：loop 页 4 行无孤行（除返回）；bg 页由 6 竖排收敛为 4 行、前两行成对。
  it("loop 页 4 行：前 3 行成对，仅返回独立；紧急动作在首行", () => {
    const r = rows("loop")
    expect(r).toHaveLength(4)
    for (let i = 0; i < 3; i++) expect(r[i], `row ${i}`).toHaveLength(2)
    expect(r[3]).toHaveLength(1)
    const first = r[0].map((x) => x.callback_data)
    expect(first).toContain("ma:stop")
    expect(first).toContain("ma:retry")
    // 守卫详情与其两个开关连续排布（不隔行）
    const info = r.findIndex((row) => row.some((x) => x.callback_data === "ma:guardinfo"))
    const prob = r.findIndex((row) => row.some((x) => x.callback_data === "ma:guardprob"))
    expect(prob).toBe(info + 1)
  })

  it("bg 页 4 行：前两行成对（动作+状态、两个自动开关），阈值独占第三行", () => {
    const r = rows("bg")
    expect(r).toHaveLength(4)
    expect(r[0].map((x) => x.callback_data)).toEqual(["ma:bg", "ma:bgstatus"])
    expect(r[1].map((x) => x.callback_data)).toEqual(["ma:bgauto", "ma:bgshell"])
    expect(r[2].map((x) => x.callback_data)).toEqual(["ma:bgth"])
    expect(r[3][0].callback_data).toBe("m:root")
  })
})

// R1908：菜单回调完整性 —— 防止未来新增按钮用了没有分派分支的前缀、或跳到
// 不存在的视图（点下去只回"未知动作/无反应"）。这是对**真实菜单枚举**的钉死，
// 而不是抄一份前缀白名单。
describe("菜单回调完整性（R1908）", () => {
  const VIEWS = ["root", "sess", "push", "loop", "bg", "sys"]
  // handleCallback(data.split(":")) 实际分派的前缀（见 tg-bridge.ts 的 parts[0] 分支）
  const HANDLED_PREFIXES = new Set(["m", "ma", "flt", "use", "stop", "retry", "qpin", "full", "fold", "qa", "qfree", "q"])

  it("每个视图的每个按钮前缀都有分派分支，m: 只跳已知视图", () => {
    for (const view of VIEWS) {
      for (const btn of flat(view)) {
        const data = String((btn as Btn).callback_data ?? "")
        if (!data) continue
        const parts = data.split(":")
        expect(HANDLED_PREFIXES.has(parts[0]), `${view} 非法前缀：${data}`).toBe(true)
        if (parts[0] === "m") {
          expect(VIEWS.includes(parts[1]), `${view} 跳未知视图：${data}`).toBe(true)
        }
      }
    }
  })
})
