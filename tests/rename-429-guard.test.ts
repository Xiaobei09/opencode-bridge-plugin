import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"

// R1897：bot 自动改名 429 的三个回归点（2026-10-06 实测故障）。
//
// 故障现象：三个 Bot 的改名全部撞 429（retry_after≈21.5h，全部汇聚到同一秒级
// 截止窗口），且 `bot rename rate-limited` warn 每 60s 刷一条（1.5h 刷 159 条），
// 日志只打 HH:MM:SS 不带日期 → 跨天截止看起来像"过期仍在限流"，误导排查。
//
// 根因三条：
//  ① lastRenameSig 是纯内存态，服务重启即清零 → 名字没变也重打 setMyName；
//  ② 冷却只按 BOT_ID 存自己的键，限流实测是共享出口 IP 级 → 其它 Bot "陪打"再撞；
//  ③ rename429LogAt 放在 renameBotToSession 函数体内，每次调用重置 0 → 节流失效。
// 本测试把三条修复钉死在源码文本上（与 timer-guard.test.ts 同款"接线断言"）。

const src = readFileSync(new URL("../src/tg-bridge.ts", import.meta.url), "utf8")
const lines = src.split("\n")

const fnStart = lines.findIndex((l) => l.includes("const renameBotToSession ="))
test("renameBotToSession 存在", () => {
  expect(fnStart).toBeGreaterThanOrEqual(0)
})

test("① 改名签名持久化：RENAME_SIG_PATH 定义 + 启动读取 + 成功写入", () => {
  expect(src.includes("RENAME_SIG_PATH")).toBe(true)
  // 启动时从磁盘恢复签名（函数体之外，只读一次）
  const decl = lines.findIndex((l) => l.includes("const RENAME_SIG_PATH ="))
  expect(decl).toBeGreaterThanOrEqual(0)
  expect(decl).toBeLessThan(fnStart)
  expect(lines[decl + 1] + lines[decl + 2] + lines[decl + 3]).toContain("lastRenameSig = sj[BOT_ID]")
  // 成功改名后落盘
  const persist = lines.findIndex((l) => l.includes("sj[BOT_ID] = sig"))
  expect(persist).toBeGreaterThan(fnStart)
})

test("② 共享冷却键 __shared：读取取 max、写入双写", () => {
  // 读：max(自己, __shared)
  expect(src.includes(`rename429Until = Math.max(rename429Until, Number(j?.["__shared"]?.until ?? 0) || 0)`)).toBe(true)
  // 写：mergeRename429Until 同时写 __shared
  expect(src.includes(`mergeRename429Until(merged, "__shared", until)`)).toBe(true)
  // 读写必须都在 renameBotToSession 函数体内（该函数每次 poll 重读磁盘）
  const readShared = lines.findIndex((l) => l.includes(`j?.["__shared"]?.until`))
  expect(readShared).toBeGreaterThan(fnStart)
})

test("③ 429 告警节流戳在闭包层且节流 30min（跨天截止带完整日期）", () => {
  const decl = lines.findIndex((l) => l.includes("let rename429LogAt = 0"))
  expect(decl).toBeGreaterThanOrEqual(0)
  // 关键回归：节流戳不得再出现在函数体内（否则每次调用重置为 0，节流形同虚设）
  const inFn = lines.slice(fnStart).findIndex((l) => l.includes("let rename429LogAt"))
  expect(inFn).toBe(-1)
  expect(decl).toBeLessThan(fnStart)
  expect(src.includes("30 * 60_000")).toBe(true)
  // until 必须带完整 ISO 日期 + 剩余时长，而不是只切 HH:MM:SS
  expect(src.includes("until=${new Date(rename429Until).toISOString()}")).toBe(true)
  expect(src.includes("remaining≈${leftMin}min")).toBe(true)
  const warnLine = lines.find((l) => l.includes("bot rename rate-limited"))
  expect(warnLine).toBeDefined()
  expect(warnLine!.includes("slice(11, 19)")).toBe(false)
})
