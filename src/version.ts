/**
 * 桥 / 自动续跑 / 一次性恢复的统一版本号。
 *
 * R2833（运营者：「每个版本都要更改版本号」）：此前 tg-bridge、auto-continue、
 * resume-once 各自硬编码 `r2814-seed-doa-lifecycle`，连续多个修复轮都没有更新，
 * 日志、`/status`、`/ping` 和热重载提示里的版本与实际部署轮次脱节。
 * 现在只保留这一处来源；三个模块都从这里导入。
 *
 * 约束：每轮发布必须把 `BRIDGE_VERSION` 改成 `r<最新 ROUND>`。
 * `scripts/tests/state-consistency.test.sh` 会拿它和 `loop-state.md` 的最大轮次
 * 比对，忘记更新版本号时全量回归直接失败。
 */
export const BRIDGE_VERSION = "r2877"
