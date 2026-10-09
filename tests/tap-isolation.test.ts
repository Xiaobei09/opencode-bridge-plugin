import { test, expect } from "bun:test"
import { TAP_PATH, LOG_ARCHIVE_DIR } from "../src/_v2compat"

// R1917：测试不得写入生产日志/归档路径。
//
// 故障：`bun test` 下 NODE_ENV=test，但 TAP_PATH 曾写死 /tmp/opencode/v2plugin.log；
// menu-root / proto-silent-baseline 两个测试 import tg-bridge → _v2compat，测试进程
// 打不开生产 DB（正常）→ 往**生产日志**追加 `[v2compat] error: bundb unavailable`。
// 后果：每跑一次回归就在线上诊断日志里留一条看似"真故障"的噪声，扫描时被误读。
// 本测试钉死：测试环境解析出的路径必须与生产路径分离；谁删掉这层隔离，它立刻红。
test("测试环境的 TAP_PATH 必须与生产路径分离 (R1917)", () => {
  expect(process.env.NODE_ENV).toBe("test")
  expect(TAP_PATH).not.toBe("/tmp/opencode/v2plugin.log")
  expect(TAP_PATH).toContain("test")
})

test("测试环境的归档目录必须与生产路径分离 (R1917)", () => {
  expect(LOG_ARCHIVE_DIR).not.toContain("/.opencode/log-archive")
  expect(LOG_ARCHIVE_DIR).toContain("test")
})
