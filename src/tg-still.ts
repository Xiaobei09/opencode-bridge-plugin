/**
 * R2693（运营者：「分模块化设计…不改表现」）：执行中/终态标记的唯一纯函数实现。
 *
 * 这些规则此前在 tg-bridge 模块级，被发送边界（sendTextRaw/editTextRaw）与
 * 看门狗纠正（patchStillNote）共用；抽成纯函数后可脱离 Telegram/插件单测。
 *
 * 关键不变量：
 *   · 只看终态正文里的运行中标记；纯 running 卡片必须保留（否则“已 N 分钟”会冻住）；
 *   · 代码块（<pre>/<code>）里的同名文本是**工具输出数据**，绝不改写；
 *   · 锚点不存在时返回 null，调用方退回整卡重渲染。
 */

// ── 格式保全：只替换那一行状态，其余一个字节都不动 ──────────────────────────
// 结构性原因：工具卡正文**从不落盘**（读回来是 text: ""），所以重载后看门狗**没有能力**
// 保留你原本那张卡，只能整张替换成简版终态卡 → 卡面从"完整卡"变成"简版卡"，
// 用户看到的就是"格式坏了"。现在正文有界落盘，终态时**就地替换**"仍在执行中"那一行。
// 没有锚点（首次/遗留卡/header-only 标题卡）→ 照旧退回整张重渲染。
const STILL_NOTE_RE = /⏳ 仍在执行中（已[^）]*）/
// 事件路径自己发的执行中标记（**最常见的一种**）。此前只认上面那句看门狗标记，
// 而绝大多数卡片上根本没有那句 → 实测 card mode=patch 只有 2、rerender 却有 12。
// 认了它之后，"发出去时就是执行中、随后才查到期"这条主路径也能就地替换。
const EVENT_RUNNING_RE = /<blockquote>⏳ 执行中…<\/blockquote>/
// 终态正文里**不许**残留"运行中"标记 —— 用户在 R1022 抓到一张同时显示
// 「⏳ 执行中…」和「✅ 已完成（…已按真实状态纠正…）」的卡。
// 为什么在**发送边界**统一拦，而不是去追每个产生者：写终态的路径有两条
// （`patchStillNote` 的就地替换、以及两处"追加纠正块"），追加的基底又来自落盘副本，
// 组合方式不止一种。**在 `sendTextRaw`/`editTextRaw` 这两个出口一次性保证**，
// 比追每条产生路径更可靠 —— 与当初修"截断截坏标签"是同一个思路。
// 纯函数，便于行为测试。
const RUNNING_MARKERS = [/<blockquote>⏳ 执行中…<\/blockquote>/g, /⏳ 仍在执行中（已[^）]*）/g]
const TERMINAL_RE = /(✅ 已完成|✅ 成功|❌ 失败|⚠️ 完成)/
// ⚠️ 必须**跳过代码块**（`<pre>…</pre>` / `<code>…</code>`）—— 那里印着工具的输入/输出
// **数据**，而数据里完全可能出现同名标记（R1022 实测：一张卡的正文就是我自己的巡检输出，
// 里面印着「⏳ 出现次数: 1 | ✅ 出现次数: 1」；另一张印着我写的测试文件）。
// 不跳过就会把**用户要看的输出**删掉 —— 那比"多显示一个状态"严重得多。
// 这是今晚第 10 次"关键词撞上工具输入文本"型陷阱（R973 栽过一次，我没吸取）。
const CODE_BLOCK_RE = /<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/g
const stripOutsideCode = (text: string, fn: (seg: string) => string): string => {
  let out = ""
  let last = 0
  CODE_BLOCK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CODE_BLOCK_RE.exec(text)) !== null) {
    out += fn(text.slice(last, m.index)) + m[0]
    last = m.index + m[0].length
  }
  out += fn(text.slice(last))
  return out
}
export const dropStaleRunning = (text: string): string => {
  if (!text || !TERMINAL_RE.test(text)) return text
  const out = stripOutsideCode(text, (seg) => {
    let s2 = seg
    for (const re of RUNNING_MARKERS) s2 = s2.replace(re, "")
    return s2
  })
  // 删完可能留下连续空行，压成两个换行（不引入手工裁剪的边界问题）
  return out.replace(/\n{3,}/g, "\n\n").trim()
}

// 纠正文案的**唯一**出处。此前有两份（`patchStillNote` 内联 + 启动回扫内联），
// 措辞还差一个"一直"字 —— 两份知识迟早分叉（同 HTML 配平那次教训）。
export const stillNoteMsg = (status: string, mins: number): string =>
  status === "completed"
    ? `✅ 已完成（此卡片之前显示“执行中”，已按会话真实状态纠正；卡住约 ${mins} 分钟）`
    : `❌ 失败（此卡片之前显示“执行中”，已按会话真实状态纠正；卡住约 ${mins} 分钟）`

export const patchStillNote = (text: string, status: string, mins: number): string | null => {
  if (!text) return null
  // 两种锚点：① 看门狗自己的"仍在执行中（已 N 分钟）"；② 事件路径发的"⏳ 执行中…"块引用。
  // 认 ② 是本轮的关键 —— 它才是绝大多数卡片上真实存在的锚点。
  if (!STILL_NOTE_RE.test(text) && !EVENT_RUNNING_RE.test(text)) return null
  const msg = stillNoteMsg(status, mins)
  // ⚠️ 两处替换都必须在**代码块之外**做（R1023 的教训，R1024 补齐同类）：
  // 工具的输入/输出就印在 <pre><code> 里，而数据里完全可能出现这两个标记的字面量 ——
  // 实测我自己的卡片就印着「⏳ 仍在执行中（已 N 分钟）」这类文本。
  // 全局 replace 会**把用户要看的输出改掉**，那比"多显示一个状态"严重得多。
  if (STILL_NOTE_RE.test(text)) {
    return stripOutsideCode(text, (seg) => seg.replace(new RegExp(STILL_NOTE_RE.source, "g"), msg))
  }
  // 事件路径的锚点连整个 blockquote 一起换掉，保持原有视觉结构（引用块 + 状态）
  return stripOutsideCode(text, (seg) =>
    seg.replace(new RegExp(EVENT_RUNNING_RE.source, "g"), `<blockquote>${msg}</blockquote>`),
  )
}
