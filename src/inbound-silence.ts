// R1740 回归：`inboundSilenceVerdict` —— 入站静默告警判据。
//
// 要解决的问题（有确凿证据，不是假想）：
//   R1739 在日志里查到 bot3 在 02:06:13→02:07:12 有 **59 秒入站静默**：
//   进程活着（`state save heartbeat` 每分钟照常）、没有任何 update 到达、
//   没有 poll error、没有 drop（dupe/notAllowed/noMsg 全 0），`cb recv` 整行都没打出来。
//   那种窗口内的用户消息**永久丢失**（bot 消费过 offset 即视为已读，Telegram 不重投）。
//   而当场**日志里什么都没有** —— 事后只能靠"census 计数变少"反推。
//
//   这与 R1728 是同一类盲区的两个实例：那次是"桥侧事件流断开但零日志"，
//   靠用户报告「已经30分钟没有推送了」才发现。**没有信号 = 无法判据**。
//
// 判据为什么不能是"空 result 就报"：
//   长轮询按设计 30 秒超时，用户不发言时**每次都返回空数组** —— 那是常态。
//   真故障与常态在"空"这个形态上完全同形（同 R1733/R1737 那条纪律）。
//   所以判据必须是**连续无 update 的时长**，且只在越过阈值时报一次。
//
// 纯函数、可注入 now，便于测试"边界两侧"与"时钟不前进"两种情形。
export interface SilenceInput {
  now: number
  /** 最近一次**收到** update 的时刻；从未收到过则为 0 */
  lastInboundAt: number
  /** 跨重载基线（来自持久化状态）；优先于 lastInboundAt，因为它能覆盖重启 */
  restoredAt: number
  /**
   * 本代实例的启动时刻 —— **R1741：这是必需的基线，不是可选的**。
   *
   * 缺陷实录（别删这段注释）：R1740 的判据只用「最近收到 update 的时刻」当基线，
   * 于是**用户长时间不说话时基线恒为 0 → 判据返回 basis:"none" → 永久放弃监控**。
   * 而"用户不说话"恰恰是长期常态，所以这个判据在绝大多数真实状态下**永远不会报警**。
   * R1739 那个 59 秒窗口能被抓到纯属侥幸 —— 基线恰好来自 17 分钟前的旧消息。
   * 干净重启后若一直无人发言（最常见的静默形态），判据完全瞎。
   *
   * 这比"没有判据"更坏：它让人以为入站在被监控。
   * 教训：**判据依赖的基线，必须在真实故障条件下也存在**。否则它是装饰。
   */
  bootAt: number
  /** 阈值：超过多少毫秒无 update 才判定为静默失联 */
  thresholdMs: number
  /** 节流：同一条告警至少间隔多少毫秒才再报（避免刷屏） */
  throttleMs: number
  /** 上次告警时刻；0 = 从未告警 */
  lastWarnAt: number
  /**
   * 当前实例是否就是"当前代"（热重载半完成时旧实例仍在跑，它的静默是假象）。
   * 旧代的静默必须抑制 —— 否则重载期间会刷出一堆假警，稀释真信号。
   */
  isCurrentGen: boolean
  /**
   * R1743：**同伴 bot 最近收到 update 的时刻**（三者取最新），0 = 同伴也没收到过。
   *
   * 为什么必须有它 —— 这是 R1743 差点又造出一个"常年误报的假判据"的教训：
   * 单看"我多久没收到 update"**无法区分**下面两种完全不同的状态：
   *   (a) 用户在安静、没人发消息   → 一切正常，没有任何丢失
   *   (b) 我这个 bot 的入站断了     → 用户发的消息正在永久丢失
   * 两者在"零 update"这个形态上同形。所以 R1741/R1742 那个纯时长判据，
   * 会在用户每次安静超过阈值时误报一次 —— 每天几十次纯噪声，
   * 等真故障来时没人会再看它（这正是我一路在对抗的"信号稀释"，R1735/R1738 主题）。
   *
   * R1739 的真实数据给出了唯一能区分二者的信号：**同一时刻别的 bot 收到了、
   * 只有我没收到**（02:06:31-02:06:47，alt 3 条、primary 2 条、bot3 零条）。
   * 同伴都在收而我不在 → 才是我这一路坏了。
   *
   * 取"最新"的同伴时间（而不是平均/最旧）：只要有一个同伴在正常收，
   * 就说明 chat 侧有流量，此时我的静默就是异常。
   */
  peerLastInboundAt: number
}

export interface SilenceVerdict {
  silent: boolean
  reason: "" | "old-gen" | "throttled" | "peer-ahead" | "peer-ok" | "no-peer"
  /** 无 update 已持续多久（毫秒）；未静默时为 0 */
  durationMs: number
  /** 判据用哪个基准时刻：restored / runtime / none */
  basis: "restored" | "runtime" | "boot" | "none"
}

export function inboundSilenceVerdict(i: SilenceInput): SilenceVerdict {
  // 基线优先级：持久化恢复值 > 运行期观测值 > 本代启动时刻。
  // 第三项是 R1741 补的：前两项在"重启后一直无人发言"时都是 0，
  // 而那正是最需要监控的形态（bot 在线却收不到任何东西，用户发什么都没反应）。
  const candidates: Array<{ t: number; basis: "restored" | "runtime" | "boot" }> = []
  if (i.restoredAt > 0) candidates.push({ t: i.restoredAt, basis: "restored" })
  if (i.lastInboundAt > 0) candidates.push({ t: i.lastInboundAt, basis: "runtime" })
  if (i.bootAt > 0) candidates.push({ t: i.bootAt, basis: "boot" })
  if (candidates.length === 0) return { silent: false, reason: "", durationMs: 0, basis: "none" }
  candidates.sort((a, b) => b.t - a.t)
  const base = candidates[0]

  // 旧代实例的静默是**热重载半完成的假象**，不是故障。R1738 又一次实证：重载
  // 第一次尝试常常"快照已换但宿主没重新 setup"，那段时间日志安静得可怕。
  if (!i.isCurrentGen) return { silent: false, reason: "old-gen", durationMs: 0, basis: base.basis }

  const durationMs = Math.max(0, i.now - base.t)

  // ── R1743 核心判别：**同伴有流量而我没有**才判故障 ──
  //
  // 这里有个我第一版做错的地方（写下来防止再犯）：同伴信息**缺失**时我原本
  // "退回纯时长判据"。但同伴账本只在真的有消息进来时才被写入 —— 三 bot 长期
  // 无人发言时它必然是空/陈旧的，于是"缺失"恰恰对应**最常见的正常状态**。
  // 退回纯时长 = 每 10 分钟报一次假警，正是我一路在对抗的信号稀释。
  //
  // 正确取舍：
  //   - 有同伴数据 → 只信同伴判别（唯一能区分"安静"与"坏了"的信号）。
  //   - 无同伴数据 → **不报**。宁可漏报，也不要一个每天误报几十次的判据；
  //     漏报的后果是回到今天这个状态（靠巡检/人工发现），可接受；
  //     误报的后果是判据被无视，真故障来时也没人看。
  //
  if (i.peerLastInboundAt > 0) {
    const lagMs = Math.max(0, i.peerLastInboundAt - base.t)
    if (lagMs >= i.thresholdMs) {
      if (i.lastWarnAt > 0 && i.now - i.lastWarnAt < i.throttleMs)
        return { silent: false, reason: "throttled", durationMs, basis: base.basis }
      return { silent: true, reason: "peer-ahead", durationMs, basis: base.basis }
    }
    // 同伴也没比我新多少 → 我大概率只是和大家一起安静，不是故障
    return { silent: false, reason: "peer-ok", durationMs, basis: base.basis }
  }
  // 无同伴数据 = 无法区分"用户安静"与"我坏了" → 不下结论
  return { silent: false, reason: "no-peer", durationMs, basis: base.basis }

  // R1745：这里原先还留着"兜底"的纯时长判据（reason: silent / below-threshold）。
  // 它**不可达** —— peerLastInboundAt 是必填字段，漏传时 `undefined > 0` 为 false，
  // 照样落到上面的 no-peer。而它上面那句注释却写着"调用方漏传时才可达"，
  // **注释是错的**（R1738 教训：注释不能当依据）。
  //
  // 留着它的实际危害已经发生过了：我曾写过 `reason === "silent"` 的断言，
  // 那是拿"永不发生的现象"当正例，测的是一个不存在的分支 —— 正是我一路在
  // 提防的假绿。故直接删除，让"reason 的取值集合"与"真实可能路径"严格一致。
  // unreachable 标记为 false：peer 分支与 no-peer 分支都 return 了。
}