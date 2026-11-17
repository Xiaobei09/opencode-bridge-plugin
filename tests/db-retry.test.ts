import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"

// R1911：openDb 不得永久闩锁。
//
// 背景：原实现 `dbFailed = true` 在**第一次**打开失败后置位，此后 `if (dbHandle || dbFailed)
// return dbHandle` 让 openDb 永远返回 null —— 宿主启动瞬间的瞬态失败（DB 被占用/WAL 未就绪）
// 会把该实例的 history/usage **永久降级**，且日志只报一次，无从察觉。
// 实测：每次重启后每 bot 各报 1 次 `bundb unavailable ... unable to open database file`，
// 而直接 `new Database(path,{readonly:true})` 是能打开的 → 属瞬态失败，应当重试。
// 修法：失败进冷却（DB_RETRY_MS=30s），冷却过后自动重试，成功清失败态；日志节流 60s。

const src = readFileSync(new URL("../src/_v2compat.ts", import.meta.url), "utf8")

test("R1911：永久闩锁 dbFailed 已移除", () => {
  expect(src).not.toContain("let dbFailed") // 变量本身已删
  expect(src).not.toContain("if (dbHandle || dbFailed)")
  expect(src).not.toContain("dbFailed = true") // 不再置位（也不得在注释里留字面量）
})

test("R1911：失败进冷却 dbFailAt、成功清零、冷却期不重试", () => {
  expect(src).toContain("dbFailAt = now") // 失败记时
  expect(src).toContain("dbFailAt = 0") // 成功清态
  expect(src).toContain("now - dbFailAt < DB_RETRY_MS") // 冷却期内不重试
  expect(src).toContain("const DB_RETRY_MS")
})

test("R1911：失败日志节流并提示会自动重试", () => {
  expect(src).toContain("DB_FAIL_LOG_MS")
  expect(src).toMatch(/bundb unavailable.*自动重试/s)
})