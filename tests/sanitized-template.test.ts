import { test, expect } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// 脱敏时最容易引入的回归：把原来的反引号模板改成了双引号字符串，
// 导致 `${...}` 变成字面量（路径错误），或内嵌双引号导致语法错误。
// 这里扫描所有 src/*.ts，禁止 `"REDACTED_ROOT...${` 这种双引号模板。
const srcDir = new URL("../src", import.meta.url).pathname
const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"))

test("REDACTED_ROOT 路径中的插值必须使用模板字面量", () => {
  const bad: string[] = []
  for (const f of files) {
    const lines = readFileSync(join(srcDir, f), "utf8").split("\n")
    lines.forEach((line, i) => {
      // 只看「同一个双引号字符串从 REDACTED_ROOT 开始、到闭合引号前出现 ${」的情况；
      // 同一行里另一个反引号模板不应误报。
      if (/"REDACTED_ROOT[^"]*\$\{/.test(line)) {
        bad.push(`${f}:${i + 1}: ${line.trim()}`)
      }
    })
  }
  expect(bad).toEqual([])
})
