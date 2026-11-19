/**
 * R2692（运营者：「分模块化设计…不改表现」）：Telegram HTML 文本处理的唯一实现。
 *
 * 这些规则此前散在 tg-bridge 的模块级与插件闭包里，同一份“标签知识”被发送、
 * 编辑、卡片三条路径共用；抽成纯函数后可脱离网络/插件单测。
 *
 * 边界：不碰 Telegram I/O、不记日志、不读状态；除“截断/切分”本身外无副作用。
 * 输出与抽取前逐字节一致（含 UTF-16 代理对、实体边界、`<pre>` 收尾规则）。
 */

export const htmlEsc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * HTML 标签配平（模块级、可测）。
 *
 * 为什么需要：截断可能把 `<pre><code>…` 切断，助手正文里也可能带落单的 `</code>`；
 * 两者都会让 Telegram 400，而旧行为是**退化成纯文本**（格式全丢 + 每次记一条 error）。
 * 这里在发送前做栈式修复：删掉无匹配的闭合标签、补上缺失的闭合标签。
 * 只处理我们自己会生成的标签（b/pre/code/blockquote），其余原样保留。
 */
export const balanceHtmlTags = (input: string): string => {
  let out = String(input ?? "")
  if (!out.includes("<")) return out
  // R1010：`<i>` 必须一起处理。缺口是**真的** —— 看门狗页脚（L750 的"内容取自会话记录"）
  // 与 ctx 后缀的说明文字都用 <i>，而正文一旦在这类行中间被截断，<i> 就是落单的。
  const TAGS = ["b", "i", "pre", "code", "blockquote"]
  const tokenRe = /<(\/?)(b|i|pre|code|blockquote)(?:\s[^>]*)?>/g
  for (const tag of TAGS) {
    let guard = 0
    for (;;) {
      const idx = out.lastIndexOf(`</${tag}>`)
      if (idx < 0 || guard++ > 64) break
      const before = out.slice(0, idx)
      const opens = (before.match(new RegExp(`<${tag}(?:[ >])`, "g")) || []).length
      const closesBefore = (before.match(new RegExp(`</${tag}>`, "g")) || []).length
      if (opens > closesBefore) break // 这一处有对应开标签，不是落单的
      out = out.slice(0, idx) + out.slice(idx + tag.length + 3)
    }
  }
  const stack: string[] = []
  let mm: RegExpExecArray | null
  tokenRe.lastIndex = 0
  while ((mm = tokenRe.exec(out)) !== null) {
    const name = mm[2] as string
    if (mm[1] === "/") {
      const at = stack.lastIndexOf(name)
      if (at >= 0) stack.splice(at, 1)
    } else {
      stack.push(name)
    }
  }
  for (let i = stack.length - 1; i >= 0; i--) out += `</${stack[i]}>`
  return out
}

/**
 * `splitHtmlChunks` 定长切片的安全切点：保证 `[i, cut)` 不落在标签 `<...>` 或实体 `&...;` 中间。
 *
 * 为什么必须有：R1064 的定长切片按 `i += max` 硬切，切点可能落在标签/实体内部：
 *  · 片尾 `<b`（无 `>`）：`validateHtmlText` **不报**（它的标签正则要 `>`），若 Telegram 报 400，
 *    因该片含 `<` 会走"剥标签重发纯文本"降级 → 丢格式（不丢消息）。
 *  · 片尾 `&am`/`&`（无 `;`）：`validateHtmlText` 报"实体不完整"，而若该片**不含 `<`**，
 *    发送层的 400 降级分支（`status===400 && chunks[i].includes("<")`）**不触发** →
 *    `noteDrop` 并**整片丢弃** → 用户看到"消息发送不完整"（正是 R1064 要修的病症）。
 * 与 `truncateAt` 同策略：回退到最近的 `<`/`&` 之前，余下字符留给下一片，不丢内容。
 */
export const safeHtmlCut = (line: string, i: number, max: number): number => {
  let end = Math.min(i + max, line.length)
  if (end >= line.length) return end
  const lt = line.lastIndexOf("<", end - 1)
  const gt = line.lastIndexOf(">", end - 1)
  if (lt > gt) end = lt
  const amp = line.lastIndexOf("&", end - 1)
  const semi = line.lastIndexOf(";", end - 1)
  if (amp > semi) end = amp
  if (end <= i) end = Math.min(i + max, line.length) // 兜底：保证切片循环前进
  // R343：UTF-16 安全 —— 切点若落在代理对中间（前一半高代理、后一半低代理），两块会各自
  // 渲染成「U+FFFD」。把低代理一起带上（end+1，最多超出 max 1 个单元；PUSH_MAX=3800 远小于 TG
  // 4096 上限，安全），保证代理对永不被劈开。
  if (end > i && end < line.length) {
    const prev = line.charCodeAt(end - 1)
    const next = line.charCodeAt(end)
    if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end += 1
  }
  return end
}

export const validateHtmlText = (text: string): string | null => {
  const t = String(text ?? "")
  // 1) 标签配对（只关心 b/i/s/u/code/pre/a/blockquote）
  const stack: string[] = []
  const re = /<\/?([a-zA-Z]+)(\s[^>]*)?>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) {
    const raw = m[0]
    const name = (m[1] ?? "").toLowerCase()
    if (raw.startsWith("</")) {
      const top = stack.pop()
      if (top !== name) return `标签错位: </${name}> 对应的是 <${top ?? "无"}>`
    } else if (!raw.endsWith("/>")) {
      stack.push(name)
    }
  }
  if (stack.length > 0) return `标签未闭合: <${stack.join(">, <")}>`
  // 2) 实体完整性（截断的 &xxx; 是 400 高发原因）
  const badAmp = /&(?!(amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);)[^\s<]{0,8}/.exec(t)
  if (badAmp) return `实体不完整: ${JSON.stringify(badAmp[0])}`
  return null
}

/**
 * R2692：按上限截断正文；优先行/句/空格边界，并把切点处的 HTML 补齐。
 * 返回 `[截断后的文本, 是否发生截断]`。
 */
export const truncateAt = (text: string, max: number): [string, boolean] => {
  if (text.length <= max) return [text, false]
  let cut = text.slice(0, max)
  const br = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "), cut.lastIndexOf("。"))
  if (br > max * 0.6) cut = cut.slice(0, br + 1)
  else {
    const sp = cut.lastIndexOf(" ")
    if (sp > max * 0.6) cut = cut.slice(0, sp + 1)
  }
  while (cut.length > 0) {
    const c = cut[cut.length - 1]
    if (c === "<" || c === "&" || (cut.length > 3 && cut.slice(-4) === "</pre")) {
      cut = cut.slice(0, cut.length - 1)
      continue
    }
    const amp = cut.lastIndexOf("&")
    if (amp > cut.length - 10 && cut.slice(amp).includes(";") === false) cut = cut.slice(0, amp)
    break
  }
  let end = cut.lastIndexOf("</pre>")
  if (end >= 0 && end > cut.length - 40) cut = cut.slice(0, end)
  const brk = cut.indexOf("<pre>")
  if (brk >= 0 && brk > cut.length - 20) cut = cut.slice(0, brk)
  // 兜底：上面两条只处理"`<pre>` 离末尾很近"的情况，而实测那张坏卡的
  // `<blockquote><pre><code>` 起点离末尾很远 → 两条都不触发，开标签被留在正文里。
  // 无论上面怎么处理，最后都按**实际未闭合的标签栈**补齐（balanceHtmlTags 是唯一实现）。
  // 用**唯一**的那个配平实现（balanceHtmlTags），不要在这里另写一份：
  // R1010 教训 —— 我曾在这里另写了一个"只补不删"的简化版，于是同一个文件里
  // 出现两份标签知识：简化版不认 <i>、也不删落单闭标签，两份迟早分叉。
  return [balanceHtmlTags(cut), true]
}
// R1064：超长文本切分（按行边界，尽量不从中劈开；HTML 标签交给每段 balanceHtmlTags 配平）。

/**
 * R2692：按行边界把超长正文切成多段；过长的单行用 safeHtmlCut 定长切。
 * 每段的标签配平由调用方（发送前）统一做。
 */
export const splitHtmlChunks = (text: string, max: number): string[] => {
  const chunks: string[] = []
  let cur = ""
  const push = (): void => {
    if (cur.trim()) chunks.push(cur)
    cur = ""
  }
  for (const ln of text.split("\n")) {
    if (ln.length > max) {
      push()
      for (let i = 0; i < ln.length; ) {
        const end = safeHtmlCut(ln, i, max)
        chunks.push(ln.slice(i, end))
        i = end
      }
      continue
    }
    if (cur && cur.length + 1 + ln.length > max) push()
    cur = cur ? `${cur}\n${ln}` : ln
  }
  push()
  return chunks
}
