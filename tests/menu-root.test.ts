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
})
