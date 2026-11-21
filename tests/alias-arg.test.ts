/**
 * R1830：命令别名/群聊后缀下的**参数提取**回归。
 *
 * 缺陷（R1823 同一类的残余分支）：命令名经 CMD_ALIAS 归一（/u→use）、
 * stripCmdBotSuffix 已剥 @suffix 后，文本可能仍是 `/u 3`；
 * 但各处理器按**字面 canonical 前缀**切片（`text.startsWith("/use ")`）→ 得空串：
 *   · `/u 3`    → 参数被吞，静默退化成"看当前目标"（用户以为切了会话，其实没切）
 *   · `/r 10`   → 退化成默认 5 条
 * 修复：统一走 `commandArg(text)`（跳过首个命令 token，其余原样返回）。
 */
import { commandArg, stripCmdBotSuffix } from "../src/tg-bridge.ts"
import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"

const norm = (s: string): string => commandArg(stripCmdBotSuffix(s))

test("canonical 前缀：正常取值", () => {
  expect(commandArg("/use 3")).toBe("3")
  expect(commandArg("/use alice")).toBe("alice")
})

test("别名：/u 3 不再吞参（核心回归）", () => {
  expect(commandArg("/u 3")).toBe("3")
  expect(norm("/u 3")).toBe("3")
})

test("群聊 @后缀：/use@bot 3 与 /u@bot 3 都取值", () => {
  expect(norm("/use@my_bot 3")).toBe("3")
  expect(norm("/u@my_bot 3")).toBe("3")
})

test("无参命令 → 空串（保持原有语义）", () => {
  expect(commandArg("/use")).toBe("")
  expect(commandArg("/u")).toBe("")
  expect(commandArg("/watch")).toBe("")
  expect(commandArg("/replay")).toBe("")
})

test("多空格 / 前后空白 / Tab 归一", () => {
  expect(commandArg("/use   3")).toBe("3")
  expect(commandArg("  /use 3  ")).toBe("3")
  expect(commandArg("/u\t3")).toBe("3")
})

test("参数可含空格（/sendto / alias 名称）", () => {
  expect(commandArg("/sendto 2 hello world")).toBe("2 hello world")
  expect(commandArg("/alias my name ses_x")).toBe("my name ses_x")
  expect(commandArg("/replay all")).toBe("all")
})

test("普通文本 / 非命令 → 空串（不误伤）", () => {
  expect(commandArg("hello /use 3")).toBe("")
  expect(commandArg("use 3")).toBe("")
  expect(commandArg("")).toBe("")
})

test("参数内的 @ 不受影响", () => {
  expect(commandArg("/use@bot foo@bar")).toBe("foo@bar")
})

test("源码守门：受影响处理器不再用字面 canonical 前缀切片", () => {
  const src = readFileSync(new URL("../src/tg-bridge.ts", import.meta.url), "utf8")
  for (const cmd of ["/use", "/watch", "/unwatch", "/alias", "/sendto"]) {
    expect(src.includes(`text.startsWith("${cmd} ") ? text.slice`)).toBe(false)
  }
  expect(src.includes('text.startsWith("/replay ") || text.startsWith("/reload ")')).toBe(false)
})
