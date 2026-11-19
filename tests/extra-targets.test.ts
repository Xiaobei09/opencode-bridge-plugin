import { test, expect } from "bun:test"
import { resolveExtraTargetPaths } from "../src/auto-continue"
import { readFileSync } from "node:fs"

// R1899：附加循环目标必须在 AC_EXTRA_TARGETS 缺省时从 Bot 注册表自动发现。
//
// 故障（2026-10-07 用户实测）：「另外那个会话也不能自动循环」。根因是
// AC_EXTRA_TARGETS 从未在任何配置里出现 → EXTRA_TARGET_PATHS 恒空 → auto-continue
// 单实例只驱动 tg-chats.json（primary）→ bot2/bot3 的 front 会话既不进目标集、
// 也永不注册进 loop-sessions。而多目标单实例本就是设计架构，缺的只是入口配置。
//
// 命名契约必须与 tg-bridge 装载器的 statePath 推导一致：
//   index 0 → tg-chats.json（沿用历史），其余 → `tg-chats-${id}.json`（sfx=`-${id}`）。
// 本测试钉死三条线：
//   ① 显式 env 优先生效（显式覆盖推导，不与注册表合并）；
//   ② env 缺省时按注册表推导出全部 Bot 的状态文件；
//   ③ 坏注册表/空注册表 → 退回空列表（不打断主目标、不抛错）。

const ROOT = "/home/xiaobei"
const REG = JSON.stringify({
  bots: [
    { id: "primary", label: "cilv2bot", envFile: `${ROOT}/.config/opencode/tg.env` },
    { id: "bot2", label: "opencodev2", envFile: `${ROOT}/.config/opencode/tg-bot2.env` },
    { id: "bot3", label: "codecil", envFile: `${ROOT}/.config/opencode/tg-bot3.env` },
  ],
})

test("env 缺省时从注册表自动发现全部 Bot 状态文件（R1899）", () => {
  expect(resolveExtraTargetPaths(undefined, REG, ROOT)).toEqual([
    `${ROOT}/.config/opencode/tg-chats.json`,
    `${ROOT}/.config/opencode/tg-chats-bot2.json`,
    `${ROOT}/.config/opencode/tg-chats-bot3.json`,
  ])
})

test("显式 env 优先生效（覆盖推导，不合并）", () => {
  const env = `${ROOT}/.config/opencode/tg-chats-x.json, ${ROOT}/.config/opencode/tg-chats-y.json`
  expect(resolveExtraTargetPaths(env, REG, ROOT)).toEqual([
    `${ROOT}/.config/opencode/tg-chats-x.json`,
    `${ROOT}/.config/opencode/tg-chats-y.json`,
  ])
})

test("env 非法项被过滤（必须以 / 开头），合法项保留", () => {
  expect(resolveExtraTargetPaths(`relative/x.json,${ROOT}/.config/opencode/tg-chats-z.json`, null, ROOT)).toEqual([
    `${ROOT}/.config/opencode/tg-chats-z.json`,
  ])
})

test("注册表读不到（null）或坏 JSON → 空列表不抛错", () => {
  expect(resolveExtraTargetPaths(undefined, null, ROOT)).toEqual([])
  expect(resolveExtraTargetPaths(undefined, "{broken", ROOT)).toEqual([])
  expect(resolveExtraTargetPaths(undefined, JSON.stringify({}), ROOT)).toEqual([])
})

test("id 非法（路径穿越/空）跳过，重复 id 去重", () => {
  const reg = JSON.stringify({
    bots: [{ id: "../etc" }, { id: "bot2" }, { id: "bot2" }, { id: "" }, {}],
  })
  expect(resolveExtraTargetPaths(undefined, reg, ROOT)).toEqual([
    // index 0 非法被跳过 → bot2 出现在其后；index 规则按原下标（0=首个沿用历史文件）
    `${ROOT}/.config/opencode/tg-chats-bot2.json`,
  ])
})

test("部署副本已接线：EXTRA_TARGET_PATHS 走 resolveExtraTargetPaths", () => {
  let src = ""
  try {
    src = readFileSync("/home/xiaobei/.opencode/v2lib/auto-continue.ts", "utf8")
  } catch {
    return // 部署副本不可读（纯源码环境）→ 跳过，接线由源码测试与线上 boot 日志双确认
  }
  expect(src).toContain("EXTRA_TARGET_PATHS = resolveExtraTargetPaths(")
  expect(src).toContain("tg-chats-")
})
