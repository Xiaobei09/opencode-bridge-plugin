import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"

// R1916（用户指令 2026-10-09）：「增加在循环是否启动在会话名称的显示」。
// 原实现只有运行态标记 [LOOP]：循环跑→标题挂 [LOOP]；循环停→标题与从未循环完全
// 无差别，会话名只回答了「循环在不在跑」的一半。现扩展为双标记三态：
//   running → [LOOP]      （循环进行中，与旧行为一致）
//   stopped → [LOOP:OFF]  （循环已停止，显式可辨识）
//   clear   → 剥掉标记    （非目标/清理）
// 机器人名由桥侧 renameBotToSession 以会话标题为源同步，标题变则 bot 名变。

const src = readFileSync(new URL("../src/auto-continue.ts", import.meta.url), "utf8")
const lines = src.split("\n")

// 解析 stripLoopTitle 具体实现，直接对它做行为断言（纯函数）。
const start = lines.findIndex((l) => l.includes("const stripLoopTitle"))
expect(start).toBeGreaterThanOrEqual(0)
const braceOpen = lines[start].indexOf("{")
let depth = 0
let end = start
for (let i = start; i < lines.length; i++) {
  for (const ch of lines[i]) {
    if (ch === "{") depth++
    else if (ch === "}") depth--
  }
  if (depth <= 0) {
    end = i
    break
  }
}
const fnBody = lines
  .slice(start, end + 1)
  .join("\n")
  .replace("const stripLoopTitle = (title: string): string => {", "function f(title) {")
const inline = fnBody
  .replace(/LOOP_TITLE_MARK_OFF/g, JSON.stringify("[LOOP:OFF]"))
  .replace(/LOOP_TITLE_MARK_ON/g, JSON.stringify("[LOOP]"))
  .replace(/LOOP_TITLE_MARKS/g, JSON.stringify(["[LOOP:OFF]", "[LOOP]"]))
const makeStrip = new Function(`"use strict"; ${inline}; return f`) as () => (t: string) => string
const strip = makeStrip()

test("stripLoopTitle: 剥运行标记", () => {
  expect(strip("GitHub gh 登录配置 [LOOP]")).toBe("GitHub gh 登录配置")
})

test("stripLoopTitle: 剥停止标记", () => {
  expect(strip("ProxyIP 无限迭代审查优化器 v6.7 [LOOP:OFF]")).toBe("ProxyIP 无限迭代审查优化器 v6.7")
})

test("stripLoopTitle: 无标记原样返回", () => {
  expect(strip("Run tests_pipeline foreground")).toBe("Run tests_pipeline foreground")
  expect(strip("")).toBe("")
})

test("stripLoopTitle: 历史叠加残留一并剥净（长标记优先）", () => {
  expect(strip("任务 [LOOP] [LOOP:OFF]")).toBe("任务")
})

test("applyMarker 三态类型存在且仅一条定义", () => {
  const defs = lines.filter((l) => l.includes('applyMarker = async (sessionID'))
  expect(defs.length).toBe(1)
  const line = defs[0]
  expect(line).toContain("running")
  expect(line).toContain("stopped")
  expect(line).toContain("clear")
})

test("循环中闸门开→ [LOOP]，闸门关→ [LOOP:OFF]（syncLoopMarker 三态映射）", () => {
  const syncStart = lines.findIndex((l) => l.includes("const syncLoopMarker"))
  const block = lines.slice(syncStart, syncStart + 14).join("\n")
  expect(block).toContain('"stopped"')
  expect(block).toContain('"running"')
  expect(block).toContain('loopGateStopped(readCtl(), sessionID) ? "stopped" : "running"')
})

test("refreshLoopMarkerIfChanged 清理残留调用为 clear 而非 false", () => {
  const refresh = lines.find((l) => l.includes('void applyMarker(sid, "clear")'))
  expect(refresh).toBeTruthy()
  const stale = lines.find((l) => l.includes("applyMarker(sid, false)"))
  expect(stale).toBeUndefined()
})

test("R1916b: refresh 遍历全部 targets 而非只第一个(三 bot 标题都要写状态)", () => {
  const refreshStart = lines.findIndex((l) => l.includes("const refreshLoopMarkerIfChanged"))
  const block = lines.slice(refreshStart, refreshStart + 30).join("\n")
  // 必须用全集 currentLoopTargets() 计算 sig，逐个 syncLoopMarker
  expect(block).toContain("const tgts = currentLoopTargets()")
  expect(block).toContain("tgts.includes(sid)")
  expect(block).toContain("for (const t of tgts) void syncLoopMarker(t)")
  // 不允许再退回「只 cur 一个目标」的写法
  expect(block).not.toContain("const sig = `${cur}:${state}`")
})

test("R1916d: sig 未变路径定期强制自愈(宿主剥掉标记也能补挂)", () => {
  const refreshStart = lines.findIndex((l) => l.includes("const refreshLoopMarkerIfChanged"))
  // 找到 R1916d 注释与自愈计数声明（在 refresh 函数定义之前）
  const declIdx = lines.findIndex((l) => l.includes("markerSelfHealTick"))
  expect(declIdx).toBeGreaterThan(-1)
  expect(lines.slice(declIdx - 6, declIdx + 2).join("\n")).toContain("R1916d")
  // 常量=12 声明在 refresh 之前（5s markerTimer → ~60s 一次自愈检查）
  expect(lines.slice(declIdx, refreshStart).join("\n")).toContain("REFRESH_SELF_HEAL_EVERY = 12")
  const block = lines.slice(refreshStart, refreshStart + 30).join("\n")
  // sig 未变 → 计数未到 12 则早退；到 12 则对全部目标强制 syncLoopMarker
  expect(block).toContain("if (++markerSelfHealTick < REFRESH_SELF_HEAL_EVERY) return")
  expect(block).toContain("markerSelfHealTick = 0")
  expect(block).toContain("for (const t of tgts) void syncLoopMarker(t)")
  // sig 未变路径里有强制重跑（自愈核心），而非裸 return 结尾
  const sigReturnSection = block.slice(block.indexOf("if (sig === markerLastSig)"))
  expect(sigReturnSection).toContain("markerSelfHealTick = 0")
  expect(sigReturnSection).toContain("syncLoopMarker")
  expect(sigReturnSection).toContain("return")
})