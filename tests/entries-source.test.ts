import { test, expect } from "bun:test"
import { existsSync, readFileSync } from "node:fs"

// R1907：两个 V2 装载入口都必须在仓库里有**可复现的源**。
// 事故：live `~/.config/opencode/plugins/auto-continue-v2.ts` 存在，但仓库从未跟踪
// 其源（`src/auto-continue-v2.ts`）——入口是运行时关键件却不可版本化/不可复现。
// 本测试钉死：
//   ① 两个入口源文件都存在；
//   ② 都使用 REDACTED_ROOT 占位（部署靠 sed 替换，不得写死 /home/xiaobei）。

const entries = ["../src/tg-bridge-v2.ts", "../src/auto-continue-v2.ts"]

for (const rel of entries) {
  const url = new URL(rel, import.meta.url)
  test(`入口源存在且用 REDACTED_ROOT 占位：${rel}`, () => {
    expect(existsSync(url)).toBe(true)
    const src = readFileSync(url, "utf8")
    expect(src.includes("REDACTED_ROOT")).toBe(true)
    // 不得把真实家目录写死（否则 sed 部署会 no-op/错乱）
    expect(src.includes("/home/xiaobei")).toBe(false)
  })
}