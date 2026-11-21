/**
 * R2844（运营者：「当前代码结构有没有可以优化的地方？不要环境还原失败！
 * 不要改动任何特性」）：跨模块**运行期路径**的唯一来源。
 *
 * 这些路径此前在 tg-bridge / auto-continue / resume-once 各写一份：
 *   · `model-windows.json` —— 2 份；
 *   · `/tmp/opencode/quota-fork-requests`（含 remap）—— 2 份（两种写法）；
 *   · `rollover-requests` —— 2 份；
 *   · `rollover-seeds` —— 3 份；`24h` 过期时间 —— 3 份。
 * 复制本身不会立刻出错，但一边改了默认值/环境变量、另一边没改，就会让
 * 「tg-bridge 写 A、auto-continue 读 B」变成静默丢状态 —— 与 state-io 的
 * 路径收口同一族问题。这里只收口常量，不做任何 IO，默认值与原实现逐一相同。
 *
 * 独立成文件（而不是塞进 state-io）：热重载时共享模块按 URL 缓存，给旧模块
 * **新增导出**可能触发链接期 `Export named ... not found`；新模块名没有旧缓存，
 * 旧状态、环境快照与回滚窗口都保持原样。
 */
import { STATE_DIR } from "./state-io"

/** 宿主模型窗口表：tg-bridge 写、auto-continue 读。 */
export const MODEL_WINDOWS_PATH = `${STATE_DIR}/model-windows.json`

/** 429 fork 请求目录（/tmp 不随 env 快照回滚；空串按未设置处理）。 */
export const QUOTA_FORK_DIR = process.env.QUOTA_FORK_DIR || "/tmp/opencode/quota-fork-requests"
/** 每个 old→new 一份 remap 文件（兄弟 Bot 同时 fork 不互相覆盖）。 */
export const QUOTA_FORK_REMAP_DIR = `${QUOTA_FORK_DIR}/remap`

/** 429 rollover 请求目录（随 env 快照跨 run 存活）。 */
export const ROLLOVER_REQUEST_DIR =
  process.env.ROLLOVER_REQUEST_DIR ?? `${STATE_DIR}/rollover-requests`

/** rollover successor 的 seed 目录（随 env 快照跨 run 存活）。 */
export const ROLLOVER_SEED_DIR =
  process.env.ROLLOVER_SEED_DIR ?? `${STATE_DIR}/rollover-seeds`
/** seed 只保护 successor 的**首回合**；超过 24h 的旧 marker 不得再续跑。 */
export const ROLLOVER_SEED_MAX_AGE_MS = 24 * 3600_000

/**
 * R2889（运营者：「出现频繁发送，真的触发了这么多次吗」）：429 换会话「暂缓」
 * 提示的跨进程认领表。
 *
 * 请求文件会随每次 CI 轮次重写（`ts` 变新），但同一轮 429 的 `first429At`
 * 不变。按 `bot + sid + first429At` 认领，热重载/新 run 不会再把同一条保留
 * 请求重复播报；换会话请求本身仍原样保留，`/loop start` 后照常执行。
 */
export const ROLLOVER_NOTICE_CLAIM_PATH = `${STATE_DIR}/rollover-notice-claims.json`
