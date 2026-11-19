// R2838：宿主进程启动时刻（**不是插件实例启动时刻**）。
//
// 事故（2026-11-19 10:57 UTC，本地 18:57）：
//   10:57:19.104 assistant 消息创建（宿主仍在生成）
//   10:57:20.858 插件热重载 → AC_BOOT_AT 重置为 10:57:20.817
//   10:57:21.389 orphan turn detected：created 比新插件 boot 早 1.7s
//   → 往正在生成的回合注入循环提示；该消息实际 10:57:33 才完成
//   10:57:40 再次热重载 → 10:57:41 第二次同样的假注入。
//
// pre-boot 判据要回答的是「写这条消息的宿主进程是否已经死了」，不是「插件实例
// 是否刚装载」。插件热重载只重建模块、不换进程；`process.uptime()` 属于宿主进程，
// 热重载不会清零，用 now - uptime 反推进程启动时刻，才能表达「宿主重启」。
//
// 只用于 pre-boot 判定；每 run/插件实例的计数与 quota 语义仍用 AC_BOOT_AT。
export const hostBootAtFrom = (now: number, uptimeSec: number): number => {
  const n = Number(now)
  const up = Number(uptimeSec)
  if (!Number.isFinite(n) || n <= 0) return 0
  // uptime 缺失/异常时退化为当前时刻：只会少判孤儿（保守），不会误放行活回合。
  if (!Number.isFinite(up) || up < 0) return n
  return Math.max(1, Math.round(n - up * 1000))
}

const uptimeSec = (() => {
  try {
    return typeof process !== "undefined" ? Number(process.uptime()) : NaN
  } catch {
    return NaN
  }
})()

export const HOST_BOOT_AT = hostBootAtFrom(Date.now(), uptimeSec)
