/**
 * R2694（运营者：「分模块化设计…不改表现」）：发送正文的编排层（原 sendTextRaw）。
 *
 * 这里保留的是**逐分支行为**：超长分段、行/句边界截断、HTML 预检与配平、
 * 400 时先丢坏锚点再剥标签降级、瞬时错误重试、永久失败记账。
 * 纯格式化规则在 tg-html；HTTP 在 tg-api；主备选择在 tg-send；执行中标记在 tg-still。
 *
 * 依赖全部注入而不是反向 import 桥：分块成功数、投递基线、丢弃计数都是桥的
 * 运行态；本模块只负责“这一条正文怎么发”。
 */
import {
  balanceHtmlTags,
  htmlEsc,
  splitHtmlChunks,
  truncateAt,
  validateHtmlText,
} from "./tg-html"
import {
  isTransientTgStatus,
  plainTextFromHtml,
  replyTargetMissing,
  validateInlineKeyboard,
  type TelegramResult,
} from "./tg-transport"
import { dropStaleRunning } from "./tg-still"

/** Telegram 单条正文上限（留出 parse_mode/截断脚注余量）。 */
export const PUSH_MAX = 3800

export type SendResult = {
  r: "sent" | "retry" | "drop"
  id?: number
  fallback?: boolean
  desc?: string
  status?: number
  retryAfter?: number
  same?: boolean
  len?: number
}

export type SendTextDeps = {
  /** 同 chat 新消息削峰（桥的 paceSend）。 */
  pace: (chatID: string) => Promise<void>
  /** 主/备通道 fetch（桥的 tgFetch）。 */
  fetch: (method: string, body: Record<string, unknown>, preferFallback?: boolean) => Promise<TelegramResult>
  /** 桥的统一日志出口。 */
  log: (level: "info" | "warn" | "error", message: string) => Promise<void> | void
  /** 日志脱敏。 */
  sanitize: (value: unknown) => string
  /** 丢弃计数（桥的 noteDrop）。 */
  noteDrop: (kind: string, detail: string) => void
  /** 出站计数累加（桥的 inboundCounters.outbound）。 */
  noteOutbound: (count: number) => void
  /** 成功投递后刷新看门狗基线（桥的 lastProtoSendAt）。 */
  markDelivered: () => void
}

export const createSendText = (
  deps: SendTextDeps,
): ((chatID: string, text: string, kb?: unknown, silent?: boolean, replyTo?: number) => Promise<SendResult>) => {
  return async (chatID: string, text: string, kb?: unknown, silent?: boolean, replyTo?: number): Promise<SendResult> => {
  await deps.pace(chatID)
  // R1064：超长消息分段发送，不再 truncateAt 截断丢弃（用户报"消息发送不完整"）。
  if (text.length > PUSH_MAX) {
    const chunks = splitHtmlChunks(text, PUSH_MAX)
    const kbErr = validateInlineKeyboard(kb ? (kb as unknown) : undefined)
    if (kbErr) await deps.log("error", `sendMessage precheck keyboard invalid: ${kbErr}`)
    let firstId = 0
    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = {
        chat_id: Number(chatID) || chatID,
        text: balanceHtmlTags(chunks[i]),
        parse_mode: "HTML",
      }
      if (i === 0 && kb) body.reply_markup = { inline_keyboard: kb }
      if (silent) body.disable_notification = true
      if (i === 0 && replyTo) body.reply_to_message_id = replyTo
      const hErr = validateHtmlText(String(body.text ?? ""))
      if (hErr) await deps.log("error", `sendMessage chunk precheck html invalid: ${hErr}`)
      const r = await deps.fetch("sendMessage", body)
      if (r.ok) {
        // ⚠️ R1806：`r.id` 的类型是 `number | undefined`（`callTelegram` 在 HTTP 2xx 时
        // 有两条产路不给 id：① `result.message_id` 缺失/非数字 ② `res.json()` 抛异常）。
        // 而 `firstId` 由上面的 `= 0` 推断成 `number`，**bun build 不报错**
        // （strictNullChecks 关闭）→ 运行时 `undefined` 会被无声灌进来。
        // 生产实证：R1805 在归档里查到 3 次该形态（`proto send sent` 且消息其实已送达）。
        //
        // 所以**不要**在这里写 `firstId = r.id ?? 0` 之类"修补"：0 与 undefined 语义不同，
        // 而真正的容错在调用点 —— `protoDeliveryVerdict` 把两者都判成
        // `delivered:true, degraded:true`（已送达但无法锚定卡片）。
        // 本行保持原样，是为了让"送达但无 id"这个事实能原样传上去。
        if (i === 0) firstId = r.id as number
        continue
      }
      const status = r.status ?? 0
      if (isTransientTgStatus(status)) {
        await deps.log("info", `sendMessage chunk ${i + 1}/${chunks.length} failed (chat=${deps.sanitize(chatID)}): ${status || "network-exception"} (will retry whole)${r.desc ? ` desc=${deps.sanitize(r.desc).slice(0, 100)}` : ""}`)
        return { r: "retry", status, desc: r.desc || status || "network-exception" }
      }
      if (status === 400 && i === 0 && replyTo && replyTargetMissing(r.desc)) {
        // 先只丢锚点、保留正文/键盘重试：多数情况正文完全合法，只是被回复的消息没了。
        const body2: Record<string, unknown> = { ...body }
        delete body2.reply_to_message_id
        const rr = await deps.fetch("sendMessage", body2)
        if (rr.ok) {
          firstId = rr.id as number
          await deps.log("info", `sendMessage chunk ${i + 1}/${chunks.length} sent without stale reply anchor (chat=${deps.sanitize(chatID)})`)
          continue
        }
        await deps.log("warn", `sendMessage chunk ${i + 1}/${chunks.length} still failed without reply anchor (chat=${deps.sanitize(chatID)}): ${rr.status ?? 0} desc=${deps.sanitize(rr.desc ?? "").slice(0, 160)}`)
      }
      if (status === 400 && chunks[i].includes("<")) {
        // R1888：**先解码、后剥标签**。text 是已 htmlEsc 的 HTML（随后按 parse_mode=HTML
        // 发出），所以旧顺序 `.replace(/<[^>]*>/g,"")` 打在转义文本上**是空操作** ——
        // 紧接着的解码又把 &lt;b&gt; 还原成真标签，于是「剥标签纯文本降级」反而把标签
        // 当**字面文本**原样送到用户面前（实测 `<b>粗体</b> 正文` 原样送达，用户看到标签）。
        // 调换顺序后剥的才是真标签 → `粗体 正文`；其余用例（`ctx <1%`、`a & b`、
        // 讲解用的字面实体）两种顺序结果完全一致，不受影响。
        // R1888/R2687：先解码、后剥标签；与非分段路径共用 tg-transport 的唯一实现。
        const plain = plainTextFromHtml(chunks[i])
        // R1880：与非分段路径（下方那条 400 降级）对齐。旧实现在这里只发 `{chat_id, text}`：
        //   • **丢 reply_markup** —— 按钮消失、用户点不到（本轮 dim 5 的正题）；
        //   • **丢 disable_notification** —— 本该静默的思考/状态卡变响铃；
        //   • **丢 reply_to_message_id**；
        //   • 成功时**零日志** —— 非分段路径会记一条，所以日志里看不出"按钮被剥掉了"；
        //   • r2 若再失败会掉进下面的 drop 日志、报的是**原始 400** 而非 r2 的真实状态，
        //     两次失败被压成一次，定位时看到的是一个不存在的错误码。
        const fb: Record<string, unknown> = { chat_id: Number(chatID) || chatID, text: plain.slice(0, PUSH_MAX) }
        if (i === 0 && kb) fb.reply_markup = { inline_keyboard: kb }
        if (silent) fb.disable_notification = true
        if (i === 0 && replyTo && !replyTargetMissing(r.desc)) fb.reply_to_message_id = replyTo
        const r2 = await deps.fetch("sendMessage", fb)
        if (r2.ok) {
          // 同 R1806：r2.id 可能是 undefined，容错在调用点（protoDeliveryVerdict 判 degraded）。
          if (i === 0) firstId = r2.id as number
          await deps.log("info", `sendMessage plain-fallback ok (chat=${deps.sanitize(chatID)}) chunk=${i + 1}/${chunks.length}${i === 0 && kb ? " (kb kept)" : ""}`)
          continue
        }
        await deps.log("error", `sendMessage plain-fallback failed (chat=${deps.sanitize(chatID)}) chunk=${i + 1}/${chunks.length}: ${r2.status ?? 0} desc=${deps.sanitize(r2.desc ?? "").slice(0, 160)}`)
      }
      await deps.log("error", `sendMessage chunk ${i + 1}/${chunks.length} dropped (chat=${deps.sanitize(chatID)}): ${status} desc=${deps.sanitize(r.desc ?? "").slice(0, 160)}`)
      deps.noteDrop("send-chunk", `chat=${deps.sanitize(chatID)} status=${status} chunk=${i + 1}/${chunks.length}`)
      return { r: "drop", desc: r.desc ?? "", status }
    }
    deps.noteOutbound(chunks.length)
    await deps.log("info", `sendMessage chunked ok (chat=${deps.sanitize(chatID)}) parts=${chunks.length} len=${text.length}`)
    // R1898：投递基线在**源头**刷新（见 sendTextRaw 头部注释）
    deps.markDelivered()
    return { r: "sent", id: firstId, len: text.length }
  }
  const [cut, truncated] = truncateAt(text, PUSH_MAX)
  const body: Record<string, unknown> = {
    chat_id: Number(chatID) || chatID,
    text: `${cut}${truncated ? htmlEsc(`\n[truncated -${text.length - cut.length} chars]`) : ""}`,
    parse_mode: "HTML",
  }
  if (kb) body.reply_markup = { inline_keyboard: kb }
  if (silent) body.disable_notification = true
  if (replyTo) body.reply_to_message_id = replyTo
  const kbErr = validateInlineKeyboard(body.reply_markup ? (kb as unknown) : undefined)
  if (kbErr) await deps.log("error", `sendMessage precheck keyboard invalid: ${kbErr}`)
  const rawText0 = dropStaleRunning(String(body.text ?? ""))
  if (rawText0 !== String(body.text ?? "")) body.text = rawText0
  const rawText = String(body.text ?? "")
  const balanced = balanceHtmlTags(rawText)
  if (balanced !== rawText) body.text = balanced
  const htmlErr = validateHtmlText(String(body.text ?? ""))
  if (htmlErr) await deps.log("error", `sendMessage precheck html invalid: ${htmlErr}`)
  else if (balanced !== rawText) await deps.log("info", `html balanced before send (len=${rawText.length}→${balanced.length})`)
  const r = await deps.fetch("sendMessage", body)
  if (r.ok) {
    deps.noteOutbound(1)
    deps.markDelivered() // R1898 源头刷新基线
    return { r: "sent", id: r.id, fallback: r.viaFallback, len: String(body.text ?? "").length }
  }
  const status = r.status ?? 0
  if (status === 429 && r.desc === "local flood gate active") {
    return { r: "retry", status, desc: "local flood gate active" }
  }
  if (isTransientTgStatus(status)) {
    await deps.log("info", `sendMessage failed (chat=${deps.sanitize(chatID)}): ${status || "network-exception"} (will retry)${r.desc ? ` desc=${deps.sanitize(r.desc).slice(0, 100)}` : ""}`)
    return { r: "retry", status, desc: r.desc || status || "network-exception" }
  }
  if (status === 400) {
    if (replyTo && replyTargetMissing(r.desc)) {
      // 只丢坏锚点、保留原正文/键盘重试一次（正文本身通常没问题）。
      const body2: Record<string, unknown> = { ...body }
      delete body2.reply_to_message_id
      const rr = await deps.fetch("sendMessage", body2)
      if (rr.ok) {
        await deps.log("info", `sendMessage sent without stale reply anchor (chat=${deps.sanitize(chatID)})`)
        deps.markDelivered()
        return { r: "sent", id: rr.id, fallback: rr.viaFallback }
      }
      await deps.log("warn", `sendMessage still failed without reply anchor (chat=${deps.sanitize(chatID)}): ${rr.status ?? 0} desc=${deps.sanitize(rr.desc ?? "").slice(0, 160)}`)
    }
    // HTML 非法（如标签错位）：剥标签纯文本降级重发一次，保证送达；键保留（400 错在正文不在 markup）。
    // R1888：同分段路径 —— **先解码、后剥标签**，否则剥标签打在转义文本上是空操作，
    // 解码又把标签还原成字面文本，降级反而把 `<b>`/`<pre>` 送到用户面前。
    const plain = plainTextFromHtml(text)
    const fb: Record<string, unknown> = { chat_id: Number(chatID) || chatID, text: plain.slice(0, PUSH_MAX) }
    if (kb) fb.reply_markup = { inline_keyboard: kb }
    // R2439：与分段路径（L4379-4381）补齐 —— 非分段 400 降级此前**丢 silent/replyTo**。
    // R1880 的注释把"非分段路径"当基准来对齐，实则它自己也没带这两个字段：静默的
    // 思考/状态卡一旦 HTML 非法走降级就会**变响铃**，replyTo 也会丢。这里补上。
    if (silent) fb.disable_notification = true
    if (replyTo && !replyTargetMissing(r.desc)) fb.reply_to_message_id = replyTo
    const r2 = await deps.fetch("sendMessage", fb)
    if (r2.ok) {
      await deps.log("info", `sendMessage plain-fallback ok (chat=${deps.sanitize(chatID)})`)
      deps.markDelivered() // R1898 源头刷新基线
      return { r: "sent", id: r2.id, fallback: r2.viaFallback }
    }
  }
  // 永久失败必须记 API 的真实原因（desc），只记正文等于瞎猜：
  // 400 既可能是 HTML 非法，也可能是 inline_keyboard 不合法（callback_data 超 64 字节等）。
  const kbShape = kb ? JSON.stringify(kb).slice(0, 220) : "(none)"
  await deps.log(
    "error",
    // R2661：不要把正文写进 error 日志 —— 公共 CI 只打印插件 error/warn 尾部，
    // 这里带 text= 等于把用户/AI 消息内容搬到公开的 Actions 日志里。
    `sendMessage dropped (chat=${deps.sanitize(chatID)}): ${status} (no retry) desc=${deps.sanitize(r.desc ?? "").slice(0, 160)} kb=${kbShape} textLen=${text.length}`
  )
  deps.noteDrop("send", `chat=${deps.sanitize(chatID)} status=${status} len=${text.length}: ${deps.sanitize(text).slice(0, 120)}`)
  // 把真实原因带给调用方：否则上层只能记"丢了"，事后无法判断是 HTML 非法还是
  // 键盘非法（callback_data 超 64 字节是最常见的一种）。
  return { r: "drop", desc: r.desc ?? "", status }
}
}

export type EditTextDeps = Pick<SendTextDeps, "fetch" | "log" | "sanitize" | "noteDrop" | "markDelivered"> & {
  /** 记录最后一次编辑正文（桥的 lastEditBody，供重载后的卡片恢复）。 */
  setLastEditBody: (text: string) => void
}

/**
 * R2695：编辑正文的编排（原 editTextRaw）。
 * 与发送共用 HTML 预处理/校验/降级知识；差异只在 message_id、空的 reply_markup 语义
 * 和 “message is not modified” 视为成功。
 */
export const createEditText = (
  deps: EditTextDeps,
): ((chatID: string, messageID: number, text: string, kb?: unknown, preferFallback?: boolean) => Promise<SendResult>) => {
return async (chatID: string, messageID: number, text: string, kb?: unknown, preferFallback = false): Promise<SendResult> => {
  deps.setLastEditBody(text)
  const [cut, truncated] = truncateAt(text, PUSH_MAX)
  const body: Record<string, unknown> = {
    chat_id: Number(chatID) || chatID,
    message_id: messageID,
    text: `${cut}${truncated ? htmlEsc(`\n[truncated -${text.length - cut.length} chars]`) : ""}`,
    parse_mode: "HTML",
  }
  if (kb !== undefined) body.reply_markup = kb ? { inline_keyboard: kb } : { inline_keyboard: [] }
  // 编辑路径同样要配平：截断会切断 <pre><code>，正文可能带落单 </code>
  {
    const t0 = dropStaleRunning(String(body.text ?? ""))
    if (t0 !== String(body.text ?? "")) body.text = t0
    const t1 = balanceHtmlTags(t0)
    if (t1 !== t0) {
      body.text = t1
      await deps.log("info", `html balanced before edit (msg=${messageID}, len=${t0.length}→${t1.length})`)
    }
  }
  // 与 sendTextRaw 同样的发送前自检：编辑路径的按钮（stop/full/fold）也要保证合法
  const kbErrE = validateInlineKeyboard(body.reply_markup ? (kb as unknown) : undefined)
  if (kbErrE) await deps.log("error", `editMessageText precheck keyboard invalid: ${kbErrE}`)
  const r = await deps.fetch("editMessageText", body, preferFallback)
  // R1898：编辑是循环期卡片的**主要**送达方式（整张重渲染）——源头刷新基线，
  // 否则只编辑不发送的窗口里 watchdog 会误报 `proto silent`（2026-10-06 实测）。
  if (r.ok) {
    deps.markDelivered()
    return { r: "sent", id: r.id ?? messageID, fallback: r.viaFallback, len: String(body.text ?? "").length }
  }
  // 内容一字不差时 TG 回 400 message is not modified：屏上本就是对的，按成功处理，不降级重发
  if (r.status === 400 && /not modified/i.test(r.desc ?? "")) {
    await deps.log("info", `editMessageText same (chat=${deps.sanitize(chatID)}, msg=${messageID}): already up to date`)
    deps.markDelivered() // R1898 同文也是"链路活着"的证据
    return { r: "sent", id: messageID, same: true }
  }
  const status = r.status ?? 0
  // status 0 = fetch 抛异常（网络不可达/DNS/超时），**必须可重试**。
  // 此前只判 429/5xx，把网络异常当永久失败 → 00:54 那次网络抖动直接把菜单点击
  // 变成"点了没反应"（用户报告 /menu 打不开的一类成因）。
  // R2609（D3 可观测性）：必须保留 tgFetch 给的 desc。此前这里把 desc 改写成
  // 状态码，本地闸门返回的 "local flood gate active" 在日志里变成 desc=429，
  // 被误读成"闸门旁路、仍在触网"（2026-11-12 02:45 实测）。
  if (isTransientTgStatus(status)) return { r: "retry", status, desc: r.desc || status || "network-exception", retryAfter: r.retryAfter }
  await deps.log("error", `editMessageText failed (chat=${deps.sanitize(chatID)}, msg=${messageID}): ${status} (no retry) desc=${deps.sanitize(r.desc ?? "").slice(0, 160)}`)
  deps.noteDrop("edit", `chat=${deps.sanitize(chatID)} msg=${messageID} status=${status} len=${text.length}`)
  return { r: "drop" }
}
}

