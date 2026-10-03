/**
 * cmd-bot-suffix 单测（R1823）：群聊命令的 @botname 后缀剥离。
 *
 * Telegram 在群聊会把命令改写成 `/cmd@BotName`。桥内各命令块按 "/cmd " 前缀切片取参数，
 * 带 @ 后缀时前缀失配 → 参数被吞空（/use、/watch、/alias）或错位（/sendto 把 "BotName"
 * 当成会话名）。修复：入站解析前用 stripCmdBotSuffix 剥离紧跟首个命令 token 的 @后缀。
 */
import { stripCmdBotSuffix } from "../src/tg-bridge.ts"
import { test, expect } from "bun:test"

test("剥离紧跟命令 token 的 @botname 后缀", () => {
  expect(stripCmdBotSuffix("/use@my_bot 3")).toBe("/use 3")
  expect(stripCmdBotSuffix("/watch@my_bot 2")).toBe("/watch 2")
  expect(stripCmdBotSuffix("/alias@my_bot foo 2")).toBe("/alias foo 2")
  expect(stripCmdBotSuffix("/sendto@my_bot 2 hi")).toBe("/sendto 2 hi")
  expect(stripCmdBotSuffix("/menu@my_bot")).toBe("/menu")
})

test("普通文本 / 无后缀命令零影响", () => {
  expect(stripCmdBotSuffix("/use 3")).toBe("/use 3")
  expect(stripCmdBotSuffix("/menu")).toBe("/menu")
  expect(stripCmdBotSuffix("hello world")).toBe("hello world")
  expect(stripCmdBotSuffix("")).toBe("")
})

test("参数里出现的 @ 不受影响（@ 前有空格）", () => {
  expect(stripCmdBotSuffix("/raw foo@bar.com")).toBe("/raw foo@bar.com")
  expect(stripCmdBotSuffix("/sendto 2 user@example.com")).toBe("/sendto 2 user@example.com")
})

test("只剥离首个命令 token 的 @后缀，不碰参数中后续的 @", () => {
  expect(stripCmdBotSuffix("/use@bot a@b")).toBe("/use a@b")
})
