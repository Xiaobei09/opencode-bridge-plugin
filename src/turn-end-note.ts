/**
 * 「AI 主动结束输出」短提示的**文案判据**（纯函数，供单测钉死）。
 *
 * R1565 背景（用户真实指令，2026-09-29）：
 *   用户反馈「tg 收不到 AI 主动结束输出的提示（无论有没有循环）」。
 *   现状：桥里已有「✅ 本轮完成/✅ 完成」status 卡逻辑（onIdle 7456-7460）与
 *   step-finish 卡（3738-3767），但 a) onIdle 依赖宿主 session.idle 事件
 *   （日志无证据触发）；b) step-finish 卡的 `:status` key 与队列置顶共用，
 *   且卡是「编辑旧消息」而非「新消息」→ Telegram 编辑不弹通知 → 用户端感知为收不到。
 *   用户拍板方案：**每轮发一条短新消息**。
 *
 * 本模块只产出该短消息的**文案**（必须是"短"：一行、不含大段状态/凭据）。
 * 发送动作在 tg-bridge.ts 的事件钩子（message.updated 中 time.completed 就绪处），
 * 触发信号与 auto-continue 同源（宿主给最后一条 assistant 消息写 time.completed）。
 *
 * 文案约定（全部由 turnEndLine 一处实现，别在别处再拼一次）：
 *   · loop=true（自动循环运行中） → 「✅ 本轮完成」，附轮次 R{n}（n 取 round，宽松检测）
 *   · loop=false（非循环）      → 「✅ 输出结束」
 *   · name 非空时追加会话别名，便于多会话时区分是哪条会话结束的
 *   · round 只有 `[0-9A-Za-z]+` 才拼接（防注入/防脏字符；lastRound 来自消息文本）
 *   · R2672（运营者："不要保留，不能直接询问要不要循环吗"）：循环未开时第二行直接
 *     问「要继续自动循环吗？」；循环中第二行说明「下一轮自动继续」。文案与按钮
 *     共用同一个 loop 状态，避免"问着要不要循环，按钮却不驱动循环"。
 *   · R2747（运营者：「继续缩短」）：循环中的「下一轮自动继续」是每轮重复的废话
 *     （注入提示/下一轮本身会证明它继续了，按钮也写着 ⏹ 停止循环），删掉后
 *     循环轮固定一行；未循环时的询问仍然保留。
 */

export type TurnEndCtx = {
  /** 是否处于自动循环运行中（决定「本轮完成」vs「输出结束」措辞） */
  loop?: boolean
  /** 轮次号（来自消息文本 [ROUND n]，可能为空/脏） */
  round?: string
  /** 会话别名（sessionNameOf 的结果，可空） */
  name?: string
  /** R2672：循环未开时在第二行直接询问（loop=false 才生效） */
  askLoop?: boolean
  /** R2672 的旧字段：循环中第二行续跑说明已删（R2747），保留以兼容旧调用 */
  autoLoop?: boolean
}

const SAFE_ROUND = /^[0-9A-Za-z]+$/

/** ROUND 轮次提取（R1570 从 L3557/7493 双实现收敛到一处，防止两处正则漂移）。
 *  兼容 `[ROUND 1547]` 与 `[ROUND R1569]`（循环报告实际输出带 R 前缀）及大小写。
 *  返回纯数字字符串（如 "1569"），无匹配返回空串。 */
export const extractRound = (text: string): string => {
  const rm = String(text ?? "").match(/\[ROUND\s*(?:R\s*)?(\d+)\]/i)
  return rm ? rm[1] : ""
}

/** R1593/R1595/R1603：note 判据的**续跑检测**。
 *  R1593（v1）以「消息含 [ROUND n]」判循环轮——ECONNRESET 中断回合常缺标记 → 漏检。
 *  R1595（v2）以「比 M 更新的用户消息含循环提示前缀」判定——宿主把循环提示写成
 *  type='synthetic'、无 parts 的行，role 过滤与 partsOf 都取不到 → 仍漏检。
 *  R1603（终版，用户规则原话：不发消息（包括循环提示）就不会继续时才发「输出结束」）：
 *  M 之后**存在任何消息**（synthetic 提示/真实 TG 消息/下一轮报告/事件行）→ 还会继续 →
 *  不发；M 是会话里最后一条 → 停摆 → 发。 */
export const noteSkipped = (c: { newerMessage: boolean; loopSkip: boolean }): boolean =>
  c.loopSkip && c.newerMessage

/** R1596：note 是否因「非属主实例」而跳过。ownerOnly 开启时只有主实例（拥有队列卡的
 *  实例=index 0）发 turn-end note——alt/bot3 实例的 front 是**各自项目**的会话，这些会话
 *  不喝本循环的注入提示，R1595 续跑检测对它们恒 false → 各自项目回合一结束就发 note，
 *  跨 bot 刷屏。与桥既有原则一致（「附加镜像档不打扰，只有主目标发状态卡」L7555）。
 *  关闭（ownerOnly=false）回到每实例都发。 */
export const noteOwnerOnlySkipped = (c: { ownerOnly: boolean; isOwner: boolean }): boolean =>
  c.ownerOnly && !c.isOwner

/** 自动注入循环提示的文本前缀（与 tg-bridge 的 SYNTHETIC_MARKERS 收敛，防漂移）。
 *  宿主自动续跑时注入的用户消息以这些前缀开头；真实 TG 指令不匹配。 */
export const SYNTHETIC_LOOP_MARKERS = [
  "继续自动筛查循环",
  "上一轮自动筛查应答因可恢复错误中断",
] as const

export const isLoopPromptText = (text: string): boolean =>
  SYNTHETIC_LOOP_MARKERS.some((p) => String(text ?? "").startsWith(p))

/** 自动循环注入提示（R227）：附在每次自动注入文本的**尾部**。
 * 必须是尾部追加而非前缀 —— SYNTHETIC_LOOP_MARKERS 用 startsWith 判定，
 * 前缀一旦挪动，tg-bridge 的合成消息识别与 turn-end 的 loop 判定会同时漏检。
 * 文案与 tg-bridge 的注入回执保持同语义：明确「非用户新指令」。 */
export const AUTO_INJECT_HINT =
  "\n\n（自动注入提示：本消息由自动筛查循环自动发出，非用户新指令；如用户无新发言，按 (a) 复述“自动注入,无新指令”后继续。）"

/** 消息的 parts 数组（兼容 V1 `{info, parts}` 与 v2 原始 `{content}` 两种形状）。 */
const messageParts = (m: any): any[] =>
  Array.isArray(m?.parts) ? m.parts : Array.isArray(m?.content) ? m.content : []

/** 消息的可见文本（V1 text parts + v2 顶层 text + 原始 content text parts）。 */
const messageText = (m: any): string => {
  let out = typeof m?.text === "string" ? m.text : ""
  for (const p of messageParts(m)) {
    if (String(p?.type ?? "") === "text") out += String(p?.text ?? "")
  }
  return out
}

const shellTagAttr = (tag: string, name: string): string => {
  const r = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag)
  return r ? r[1] : ""
}

/**
 * R2648c：**仍在后台运行的 shell**（用户实报：「输出结束会在没有结束时发送，注意bot5」）。
 *
 * 背景：shell 工具被提升到后台后，assistant 消息本身会立刻 `finish=stop`（宿主语义是
 * 「这一步结束」），但后台进程仍在跑，完成后会自动注入一条合成消息把回合续起来。
 * 只看 `finish` 的 turn-end note 会在这一刻误报「✅ 输出结束」。
 *
 * 判据三层（配对为主，存活为辅）：
 *   ① 工具 part 的 `state.metadata.status === "running"` 且带 `shellID` → 候选绑定；
 *   ② 之后（任意位置）出现完成通知 `<shell id="…" state="completed" …>`
 *      （宿主写成 synthetic/user 文本，metadata 里也带 `shellID`/`state`）→ 解除；
 *   ③ 调用方给出 `isAlive` 时再看 `metadata.pid` 是否存活 → 已死解除（有的后台 shell
 *      被中断后完成通知永远不来，只靠 ② 会永久卡住 note）。
 * 用 **shellID 配对**而不是只看 metadata：实测后台 shell 完成后，原工具 part 的
 * `metadata.status` 仍永久保持 `"running"`，只有完成通知（或进程消失）能证明它真的结束了。
 *
 * 返回未解除的 shellID（去重、保持出现顺序）。
 */
export type ShellLiveness = (shellID: string, pid: number) => boolean

export const pendingBackgroundShells = (messages: any, isAlive?: ShellLiveness): string[] => {
  const list = Array.isArray(messages) ? messages : []
  const completed = new Set<string>()
  const running = new Map<string, number>()
  for (const m of list) {
    // 完成通知：宿主把 `<shell id="…" state="completed" …>` 作为合成用户消息落盘。
    const text = messageText(m)
    if (text.includes("<shell")) {
      const re = /<shell\b[^>]*>/gi
      let tag: RegExpExecArray | null
      while ((tag = re.exec(text))) {
        const id = shellTagAttr(tag[0], "id")
        if (!id) continue
        if (shellTagAttr(tag[0], "state") === "completed") completed.add(id)
      }
    }
    // 完成通知的 metadata 形态（原始 API 行 / 兼容层透传）。
    const meta = m?.metadata ?? {}
    const metaShell = typeof meta?.shellID === "string" ? meta.shellID : ""
    if (metaShell && String(meta?.state ?? "") === "completed") completed.add(metaShell)
    for (const p of messageParts(m)) {
      if (String(p?.type ?? "") !== "tool") continue
      const st = p?.state ?? {}
      const md = st?.metadata ?? p?.metadata ?? {}
      const shellID = String(md?.shellID ?? st?.shellID ?? p?.shellID ?? "")
      if (!shellID) continue
      // metadata.status 才是「进程仍在跑」（工具调用本身早已 completed）；
      // 没有 metadata 时退回工具调用状态。
      const status = String(md?.status ?? md?.state ?? st?.status ?? "")
      if (status === "running") running.set(shellID, Number(md?.pid ?? st?.pid ?? 0) || 0)
    }
  }
  // 第三层：**进程存活**（调用方提供时）。有的后台 shell 既不更新 metadata.status，
  // 也永远等不到完成通知（实测 08:06 那轮被中断，通知从未落盘）。只靠通知会把 note
  // 永久卡死；pid 已不存在即视为结束。注意调用方应留一个短宽限期，避免「进程刚退出、
  // 完成通知还在路上」时抢发 —— 那是本修复要消灭的原症状。
  return [...running.entries()]
    .filter(([id, pid]) => {
      if (completed.has(id)) return false
      if (isAlive && pid > 0) return isAlive(id, pid)
      return true
    })
    .map(([id]) => id)
}

/**
 * R2657（运营者："为什么输出结束比其他消息先发"）：这条已完成消息是否有需要**先投递**
 * 的可见内容。
 *
 * note 只看 DB 里的 `time.completed`；正文/思考卡走另一条路（事件推送，事件缺失时
 * 25s 补扫），且每张卡要过同 chat 的 1.1s 节流。实测 bot6 16:11:47：`✅ 输出结束`
 * 比它引用的那条消息（mid=msg_1dffa79b）的正文早 2.5s 到达。
 *
 * 判据与补扫（proto catchup）同源：文本/思考/错误/提问卡存在 → 必须先投递；
 * 纯工具步/空消息（没有可发内容）→ 不需要等。
 */
export const hasDeliverableContent = (m: any): boolean => {
  if ((m as any)?.error || (m as any)?.info?.error) return true
  for (const p of messageParts(m)) {
    const t = String(p?.type ?? "")
    if ((t === "text" || t === "reasoning") && String(p?.text ?? "").trim()) return true
    if (t === "tool" && String(p?.tool ?? "") === "question") return true
  }
  return false
}

/**
 * R2766（运营者实报：「✅ 输出结束 … 与输出的先后调换了」）：按 part 索引列出
 * 这条消息**必须等齐**的正文卡键。
 *
 * 旧闸门（R2657）只要看到同一条消息的任意一个键（thinking/message/catchup/error）
 * 就放行。2026-11-17 11:35 bot6 实证：思考卡 43.550 已发，note 44.381 抢在正文
 * （44.738）前面；`thinking:` 键让闸门误以为"内容已投递"。
 *
 * 键的 part 索引必须与 `protoPushAssistantMessage` 完全一致：那里对 `partsOf(m)` 的
 * **每个** part 递增 idx（工具/思考也占号），只有非空 text 才发 `:message:<msgKey>:<idx>`。
 * 因此这里同样遍历全部 parts 计数，避免工具 part 造成索引漂移。
 *
 * `include` 由调用方给（桥里传 `!isInternalLog(txt)`，与推送路径同源）；返回空数组 =
 * 没有正文需要等，闸门回落到原来的"任意可见内容"判据。
 */
export const visibleTextKeys = (c: {
  sid: string
  mid: string
  parts: any[]
  include?: (text: string) => boolean
}): string[] => {
  const msgKey = String(c.mid ?? "").slice(0, 20)
  const out: string[] = []
  let idx = 0
  for (const p of Array.isArray(c.parts) ? c.parts : []) {
    const pIdx = idx++
    if (String(p?.type ?? "") !== "text") continue
    const txt = String(p?.text ?? "").trim()
    if (!txt) continue
    if (c.include && !c.include(txt)) continue
    out.push(`${c.sid}:message:${msgKey}:${pIdx}`)
  }
  return out
}

/**
 * R2657：turn-end note 的**顺序闸门** —— M 的可见内容没投递前不发 `✅ 输出结束`。
 *
 * 为什么需要：note 与正文是两条独立路径，note 只要求 DB 行带 completed，而正文可能
 * 还在事件路径排队、在 1.1s 同 chat 节流后面，或要等 25s 补扫。没有这道闸，短提示
 * 会抢在它自己引用的那条回复前面到达（用户实报 + 日志实证）。
 *
 * 返回 true = 可以发 note：
 *   · R2766：给了 `requiredKeys` 时，**每一条**都必须已投递（正文按 part 索引逐张
 *     等齐；思考卡已发但正文未发不再提前放行）；
 *   · 否则回落到旧判据：protoMap 已有 M 的 message/thinking/error/catchup/ask 键；
 *   · 或 M 根本没有可投递内容（纯工具步/空消息）；
 *   · 或首投失败进了 protoRetry 但已超过 `retryMaxMs`（防永久卡死）；
 *   · 或等待超过 `graceMs`（防键被 200/800 上限淘汰或被 push 模式过滤后永远不发）。
 * 其余情况 false → 调用方只 defer，不标记已通知，下一轮检查再评估。
 */
export const turnEndContentDelivered = (c: {
  sid: string
  mid: string
  /** 当前 protoMap 的键（Map.keys()）。 */
  keys: Iterable<string>
  /** 待重发队列的键（protoRetry.keys()）。 */
  retryKeys: Iterable<string>
  /** R2766：必须全部投递的键（`visibleTextKeys` + 提问卡）；空/缺省走旧判据。 */
  requiredKeys?: Iterable<string>
  /** M 里提问卡的 callID（对应键 `${sid}:ask:${callID}`）。 */
  askIds?: string[]
  /** hasDeliverableContent(M) 的结果。 */
  hasVisibleContent: boolean
  /** M 的 time.completed。 */
  completedAt: number
  now: number
  /** 事件/补扫的宽限窗（默认 40s：补扫 25s + 逐卡节流）。 */
  graceMs?: number
  /** 重试队列的最长等待（默认 15min；超过就放行，避免永久不发）。 */
  retryMaxMs?: number
}): boolean => {
  const msgKey = c.mid.slice(0, 20)
  const pfx = `${c.sid}:`
  const askIds = c.askIds ?? []
  const age = c.completedAt > 0 ? c.now - c.completedAt : Number.POSITIVE_INFINITY
  const grace = c.graceMs ?? 40_000
  const retryMax = c.retryMaxMs ?? 15 * 60_000
  // R2766：正文卡的**全量**闸门。只要还有一条该消息的正文/提问卡没投递（且不在
  // "已超重试上限/宽限窗"的兜底里），就不发 note。10 行正文拆成多 part 时也逐张等。
  const required = [...(c.requiredKeys ?? [])].filter((k): k is string => typeof k === "string")
  if (required.length > 0) {
    const delivered = new Set<string>()
    for (const k of c.keys) if (typeof k === "string") delivered.add(k)
    const retrying = new Set<string>()
    for (const k of c.retryKeys) if (typeof k === "string") retrying.add(k)
    let missing = 0
    let pendingRetry = false
    for (const rk of required) {
      if (delivered.has(rk)) continue
      if (retrying.has(rk)) {
        if (age >= retryMax) continue
        pendingRetry = true
      }
      missing++
    }
    if (missing === 0) return true
    if (pendingRetry && age < retryMax) return false
    return age >= grace
  }
  for (const k of c.keys) {
    if (typeof k !== "string" || !k.startsWith(pfx)) continue
    if (
      k.startsWith(`${c.sid}:message:${msgKey}:`) ||
      k.startsWith(`${c.sid}:thinking:${msgKey}:`) ||
      k.startsWith(`${c.sid}:error:${msgKey}`) ||
      k.startsWith(`${c.sid}:catchup:${msgKey}`)
    ) {
      return true
    }
    for (const id of askIds) {
      if (id && k === `${c.sid}:ask:${id}`) return true
    }
  }
  if (!c.hasVisibleContent) return true
  for (const k of c.retryKeys) {
    if (typeof k === "string" && k.startsWith(pfx) && k.includes(msgKey)) {
      return age >= retryMax
    }
  }
  return age >= grace
}

/**
 * R2671：turn-end note 的「自动循环是否真的会继续」判据。
 *
 * R2648 的 120s 安静窗原本只看 `loopStopped()`（loop-ctl 的全局/单 Bot 闸），
 * 但 `/loop off` 是**会话级**否定清单（loop-sessions-off.json），优先级高于
 * 全局闸（auto-continue 的 `loop = loopSessions.has(sid) && !loopOffSessions.has(sid)`）。
 * 实报（2026-11-16 10:30 bot6）：该会话已 `/loop off`，auto-continue 日志一直
 * `loop=no`，但 bot6.stopped=false → note 仍等 120s：正文 10:30:59 已投递，
 * `✅ 输出结束` 拖到 10:33:01，用户看到「差 3 分钟」。
 *
 * R2672 起安静窗已彻底移除（运营者："不要保留"）。本判据仍用于决定 note 的
 * 文案与按钮：true = 单行完成 + 停止按钮；false = 单行完成 + 直接询问要不要循环。
 * false 的三种成因：Bot 闸停、会话 `/loop off`、用户按过 ⏹（halted）。
 */
export const turnEndLoopActive = (c: { gateStopped: boolean; sessionLoopOff: boolean; sessionHalted?: boolean }): boolean =>
  !c.gateStopped && !c.sessionLoopOff && !c.sessionHalted

export const turnEndLine = (c: TurnEndCtx): string => {
  const head = c.loop ? "✅ 本轮完成" : "✅ 输出结束"
  const parts: string[] = [head]
  const rnd = typeof c.round === "string" ? c.round.trim() : ""
  if (rnd && SAFE_ROUND.test(rnd)) parts.push(`R${rnd}`)
  const name = typeof c.name === "string" ? c.name.trim() : ""
  if (name) parts.push(cleanName(name))
  const base = parts.join(" · ")
  // R2747：循环中不再追加「下一轮自动继续」——每轮重复且按钮/下一轮已证明。
  const tail = !c.loop && c.askLoop ? "要继续自动循环吗？" : ""
  return tail ? `${base}\n${tail}` : base
}

export type TurnEndButton = { text: string; callback_data: string }
export type TurnEndKeyboard = TurnEndButton[][]

/**
 * R2672：turn-end note 的内联键盘。
 *
 * callback_data 只带动作与会话 id（`te:on:<sid>` / `te:off:<sid>`，30 字符的 sid
 * 实测 36 字节，远低于 Telegram 64 字节上限）。会话 id 必须进 data —— 否则用户
 * 切了会话/点了旧 note 时，按钮会作用到"当前 front"而不是提示所指的会话。
 *
 * 循环中只给「停止循环」；循环关闭时给「继续循环」+「保持停止」。
 * sid 异常/过长时返回空键盘，绝不发出 Telegram 400。
 */
export const turnEndKeyboard = (c: { sid: string; loopActive: boolean }): TurnEndKeyboard => {
  const sid = String(c.sid ?? "")
  if (!sid.startsWith("ses_")) return []
  const on = `te:on:${sid}`
  const off = `te:off:${sid}`
  // "te:off:" 是较长前缀（7 字节）；sid 必须是 ASCII 会话 id，按字节数校验。
  if (off.length > 64) return []
  return c.loopActive
    ? [[{ text: "⏹ 停止循环", callback_data: off }]]
    : [
        [
          { text: "🔁 继续循环", callback_data: on },
          { text: "⏹ 保持停止", callback_data: off },
        ],
      ]
}

/** 会话别名再收紧：去掉换行/控制字符，长度 ≤ 20（Telegram 短消息不显示超长名）。
 *  R2424：turnEndLine 的产物由 tg-bridge 以 `parse_mode=HTML` 发送（sendTextRaw），
 *  而会话别名来自宿主会话标题（可含 `&`/`<`/`>`）。旧实现不转义 → 标题含 `&`（如
 *  "A & B"，很常见）或 `<...>` 时整条 note 变成非法 HTML → Telegram 400 → 降级重发
 *  （每次回合结束多一次 400 与一次 API 调用）。故**先按可见长度截断、再转义**：
 *  实体不切断，普通标题显示不变，异常标题按字面显示。 */
const cleanName = (s: string): string => {
  const t = s.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim()
  const cut = t.length > 20 ? `${t.slice(0, 20)}…` : t
  return cut.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}