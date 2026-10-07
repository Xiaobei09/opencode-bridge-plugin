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
 */

export type TurnEndCtx = {
  /** 是否处于自动循环运行中（决定「本轮完成」vs「输出结束」措辞） */
  loop?: boolean
  /** 轮次号（来自消息文本 [ROUND n]，可能为空/脏） */
  round?: string
  /** 会话别名（sessionNameOf 的结果，可空） */
  name?: string
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

export const turnEndLine = (c: TurnEndCtx): string => {
  const head = c.loop ? "✅ 本轮完成" : "✅ 输出结束"
  const parts: string[] = [head]
  const rnd = typeof c.round === "string" ? c.round.trim() : ""
  if (rnd && SAFE_ROUND.test(rnd)) parts.push(`R${rnd}`)
  const name = typeof c.name === "string" ? c.name.trim() : ""
  if (name) parts.push(cleanName(name))
  return parts.join(" · ")
}

/** 会话别名再收紧：去掉换行/控制字符，长度 ≤ 20（Telegram 短消息不显示超长名） */
const cleanName = (s: string): string => {
  const t = s.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim()
  return t.length > 20 ? `${t.slice(0, 20)}…` : t
}