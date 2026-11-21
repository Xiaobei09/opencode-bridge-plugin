/**
 * R1733：投递静默判据（**纯函数**，不碰任何闭包/模块状态）。
 *
 * 为什么要抽出来：R1728 加的 watchdog 只被"没误报"验证过 —— 但**没报警**和**不能报警**
 * 在日志上长得一模一样（都是 0 条 `proto silent`）。若定时器没注册、或文案/条件写错，
 * 会得出"判据从严、0 误报"的**假绿**结论。共同规律是：
 * **判据必须被单独验证"能抓到目标形态"，且好输入/坏输入双向都要测。**
 *
 * R2775：本函数从 `tg-bridge.ts` 抽出成独立模块（并新增 flooded 豁免）：桥本体顶层有
 * 加载生产状态的副作用，直接 import 无法在测试里安全驱动判据；独立模块让每条分支都能
 * 被单独验证。
 *
 * 所有输入显式传入（含 loopStopped / isCurrentGen / paused / flooded 这些环境态），
 * 测试无需启动插件、无需接触真实系统。
 */
export type ProtoSilentVerdict = { warn: boolean; minutes: number; why: string }

export function protoSilentVerdict(
  now: number,
  lastSendAt: number,
  lastWarnAt: number,
  opts: {
    thresholdMs: number
    throttleMs: number
    loopStopped: boolean
    isCurrentGen: boolean
    paused?: boolean
    /**
     * R2775：本 Bot 正在 429 冷却（flood / fallback 闸门）内。冷却期发送被**主动拦截**，
     * 静默是预期状态；此时报"疑似热重载断流 → 需 reload 桥"是误诊（会诱使无谓重启）。
     */
    flooded?: boolean
  }
): ProtoSilentVerdict {
  const silentMs = now - (lastSendAt || 0)
  const minutes = Math.round(silentMs / 60000)
  if (!opts.isCurrentGen) return { warn: false, minutes, why: "陈旧热重载实例" }
  if (!lastSendAt) return { warn: false, minutes, why: "尚无投递基线" }
  if (silentMs < opts.thresholdMs) return { warn: false, minutes, why: "静默未超阈值" }
  // R1905：实时推送被**主动暂停**（`/pause` 或菜单「暂停推送」→ pausedMode）时，
  // 静默同样是预期行为，不是故障。此前判据只看 loopStopped，导致一个"暂停推送"的 bot
  // 每 15 分钟刷一条"proto silent … 疑似热重载半完成致事件流断开 → 需 reload 桥"的
  // **误报**（2026-10-08 bot2 实测：paused=true，会话活跃、lastpush 冻结，告警一路
  // 升级到 61min）。误报的代价是把"主动暂停"误诊成"链路损坏"，诱使去重启/reload。
  if (opts.paused) return { warn: false, minutes, why: "实时推送已暂停，静默属预期" }
  // R2775（2026-11-17 bot5 实测）：429 冷却期（`bot-flood.json` until≈02:18，恢复日志
  // `restored persisted flood gate ... left=9726s`）同样不可能有成功投递，但 flush 前
  // 静默被误报成"热重载半完成"。冷却期**任何**消息都发不出去，桥并没有坏；等冷却结束
  // 若仍静默，下面的告警会照常触发。故这里与 paused / loopStopped 同类处理。
  if (opts.flooded) return { warn: false, minutes, why: "429 冷却中，静默属预期" }
  // 循环闸已停时静默是**预期行为**（用户主动停的），不是故障
  if (opts.loopStopped) return { warn: false, minutes, why: "循环已停，静默属预期" }
  if (lastWarnAt && now - lastWarnAt < opts.throttleMs) return { warn: false, minutes, why: "告警节流中" }
  return { warn: true, minutes, why: "静默超阈值且循环未停" }
}
