/**
 * tabular：TG 消息里的等宽表格绘制（用户 2026-09-28 新增需求）。
 *
 * Telegram 正文用比例字体，普通文本对齐全看命；而**代码块（``` 围栏）恒定等宽**，
 * box-drawing 字符（─ │ ┌ ┐ └ ┘ ┬ ┤ ├ ┴ ┼）在等宽字体下按一个 cell 对齐。
 * 所以本模块产出的表格一律：左对齐单元格 + 等宽边框 + 外层 ``` 围栏。
 *
 * 纯函数、零依赖 —— 单测可以直接 import 钉行为，不必起桥。
 */

export type TableOpts = {
  /** 单元格左右内边距（默认 1 空格）。 */
  padding?: number
  /** 单列宽上限：超过则截断加 `…`（默认 24）；wrap:true 时改为宽度贡献封顶、内容不丢。 */
  maxCell?: number
  /**
   * 整表总宽上限（可视宽度，含边框与内边距；默认 42）。TG 窄客户端（手机竖屏）
   * 代码块超宽会折行、把边框折碎——所以表格必须**整体窄**，超了就优先收窄最宽的列。
   */
  maxTotal?: number
  /**
   * R1715（用户真实指令「还是应该用等宽字符更好看，再搭配上格内自动换行匹配手机TG」）：
   * 超长单元格**自动换行成多行**而非截断丢内容（默认 false=截断，保持 R1505 既有行为）。
   * 代码围栏保证等宽；格内按列宽换行 → 行总宽始终 ≤ maxTotal，手机端不再横溢/丢内容。
   */
  wrap?: boolean
  /** wrap:true 时单个单元格最大行数（超出后末行补 `…` 截断，防止长文本撑爆消息；默认 6）。 */
  wrapCap?: number
  /** 是否包 ``` 代码围栏（默认 true；mdTableToHtml 已外用 <pre> 包裹时传 false）。 */
  fence?: boolean
}

/** 单格宽度（取显示宽度：两列宽 CJK 按 2 计，制表符按键计 1）。 */
export const cellWidth = (s: string): number => {
  let w = 0
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0) ?? 0
    // CJK 统一表意/兼容/扩展、日文假名、谚文 → 宽度 2
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    w += wide ? 2 : 1
  }
  return w
}

/** 按可视宽度做左对齐补齐（不够的补空格，超过不截断——由调用方先截）。 */
const padTo = (s: string, width: number): string => {
  const gap = width - cellWidth(s)
  return gap > 0 ? s + " ".repeat(gap) : s
}

const truncateTo = (s: string, max: number): string => {
  const src = String(s)
  if (cellWidth(src) <= max) return src
  let cut = ""
  let w = 0
  for (const ch of src) {
    const cw = cellWidth(ch)
    if (w + cw > Math.max(1, max - 1)) break
    cut += ch
    w += cw
  }
  return cut + "…"
}

/**
 * 画一张用等宽字符的对齐表格，包进 ``` 代码围栏。
 *
 * @param headers 表头（至少 1 列；空表头行也可传入空数组 → 无表头）。
 * @param rows    数据行（每行列数按表头对齐；不足补空、多余忽略）。
 */
export const renderTgTable = (headers: string[], rows: string[][], opts: TableOpts = {}): string => {
  const pad = opts.padding ?? 1
  const maxCell = opts.maxCell ?? 24
  const maxTotal = opts.maxTotal ?? 42
  const wrap = Boolean(opts.wrap)
  const wrapCap = Math.max(1, Math.round(opts.wrapCap ?? 6))
  const fence = opts.fence !== false
  const colCount = Math.max((headers?.length ?? 0), ...(rows ?? []).map((r) => r?.length ?? 0), 1)
  // 内容规范化：wrap 模式保留全文（交给 wrapCell 折行）；否则按 maxCell 截断（R1505 行为）。
  const norm = (cell: string | undefined): string => (wrap ? String(cell ?? "") : truncateTo(cell ?? "", maxCell))
  // 宽度贡献：wrap 模式下长内容也最多贡献 maxCell（过宽会让表格撑爆，交给换行消化）。
  const widthContribution = (s: string): number => (wrap ? Math.min(cellWidth(s), Math.max(1, maxCell)) : cellWidth(s))
  const header = (headers ?? []).slice(0, colCount)
  const cols: string[] = header.map((h) => norm(h))
  const rawLines: string[][] = [
    ...(header.length > 0 ? [cols] : []),
    ...(rows ?? []).map((r) => new Array(colCount).fill(undefined).map((_, i) => norm(r[i]))),
  ]
  const widths: number[] = new Array(colCount).fill(0)
  for (const row of rawLines) for (let i = 0; i < colCount; i++) widths[i] = Math.max(widths[i], widthContribution(row[i] ?? ""))

  // R1508：整表总宽超过上限 → 优先收窄最宽的列（保住窄列/表头可读）。
  const innerTotal = (ws: number[]): number => ws.reduce((a, b) => a + b, 0) + colCount * 2 * pad + colCount + 1
  if (innerTotal(widths) > maxTotal) {
    const budget = maxTotal - (colCount * 2 * pad + colCount + 1)
    let excess = innerTotal(widths) - maxTotal
    // R1721：给每列一个「可用下限」。原先下限是 3（第 1 轮）→ 1（第 2 轮），
    // 实测最后一列被压到 5 可视宽，长 URL 只能碎成 6 行 `htt`/`ps:`/`//a`。
    // 列太窄不只难看，还让 wrapCell 的词感知换行失效（整词都放不下 → 退化为硬切）。
    // 下限取 `minColFloor`（默认 8，约 4 个汉字/16 个拉丁字符），保证词级断行可用。
    const maxFloor = Math.max(1, Math.floor(budget / Math.max(1, colCount)))
    const minColFloor = Math.min(8, maxFloor)
    const order = widths.map((_, i) => i).sort((a, b) => widths[b] - widths[a])
    for (const i of order) {
      if (excess <= 0) break
      const cut = Math.min(excess, widths[i] - minColFloor) // 每列至少留 minColFloor 可视宽
      if (cut > 0) {
        widths[i] -= cut
        excess -= cut
      }
    }
    if (excess > 0) {
      // 预算不够放下所有下限：按列宽从大到小继续压到硬下限 1（纯省略号）
      for (const i of order) {
        if (excess <= 0) break
        const cut = Math.min(excess, widths[i] - 1)
        if (cut > 0) {
          widths[i] -= cut
          excess -= cut
        }
      }
    }
    // 截断模式（默认）：按收窄后的列宽重截，保住单行结构（R1505 行为）。
    // wrap 模式：不截内容 —— 超出列宽的文本交给 wrapCell 折行，总宽已由收窄保证。
    if (!wrap) for (let r = 0; r < rawLines.length; r++) for (let c = 0; c < colCount; c++) rawLines[r][c] = truncateTo(rawLines[r][c], Math.max(1, widths[c]))
  }
  const lines = rawLines
  const noHeaderLines = lines.length // 含表头时为全部行
  const dataStart = header.length > 0 ? 1 : 0
  const inner = (cells: string[]): string =>
    "│" + cells.map((c, i) => " ".repeat(pad) + padTo(c, widths[i]) + " ".repeat(pad)).join("│") + "│"
  const sep = (left: string, mid: string, right: string): string =>
    left + widths.map((w) => "─".repeat(w + pad * 2)).join(mid) + right
  // R1715：格内自动换行 —— 单元格按列宽折成多行（CJK 可视宽度感知），整行画成多子行。
  //
  // R1721 Bug B：原实现逐字符断行，把拉丁词/URL 切成碎片（实测 `` `ta ``/`bul`/`ts``），
  // 手机端几乎不可读。改为**词感知**：
  //   * CJK / 全角 / 表情：逐字可断（中文排版本就可以任意断行）；
  //   * 拉丁字母、数字，以及 URL/标识符里的 `.` `_` `-` `/` `:` `?` `=` `&` `%` `#` `@` `+`
  //     —— 归为**不可断整体**（同一个 token），只在空格/标点处断；
  //   * 空格是断点，且断行后不保留行尾空格（避免等宽块里出现尾随空白）。
  // 单个 token 自身就宽于列宽（超长 URL）时 unavoidable → 退化为逐字符切，
  // 但仍优先在 token 内「尽量晚断」，并在超出 wrapCap 时补 `…` 提示截断。
  const isWideish = (ch: string): boolean => cellWidth(ch) >= 2
  const isSpaceCh = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\u3000"
  // 词内字符：字母/数字/常见 URL 与标识符符号 —— 这些相邻时属于同一个不可断 token。
  const isWordChar = (ch: string): boolean => {
    if (isSpaceCh(ch)) return false
    if (isWideish(ch)) return false // CJK/全角/表情：单独成 token（可断）
    return /[A-Za-z0-9._\-\/:?=&#%@+~^$|\\[\]{}<>,;!'"`]/.test(ch)
  }
  /** 把单元格文本切成「不可断 token」序列（空格单独成 token，便于断行时丢弃）。 */
  const tokenize = (src: string): string[] => {
    const toks: string[] = []
    let cur = ""
    let curKind = "" // "word" | "cjk" | "space" | "other"
    const kindOf = (ch: string): string => {
      if (isSpaceCh(ch)) return "space"
      if (isWideish(ch)) return "cjk"
      if (isWordChar(ch)) return "word"
      return "other"
    }
    const flushCur = (): void => {
      if (cur !== "") {
        toks.push(cur)
        cur = ""
      }
    }
    for (const ch of src) {
      const k = kindOf(ch)
      // word/cjk 各自聚合；space 与 other 一律单独成 token。
      if (k === curKind && (k === "word" || k === "cjk")) {
        cur += ch
      } else {
        flushCur()
        cur = ch
        curKind = k
      }
    }
    flushCur()
    return toks
  }
  const wrapCell = (raw: string, w: number): string[] => {
    const src = String(raw ?? "")
    if (cellWidth(src) <= w) return [src]
    const limit = Math.max(1, w)
    const toks = tokenize(src)
    const chunks: string[] = []
    let cur = ""
    let cw = 0
    const pushLine = (): void => {
      let trimmed = cur.replace(/[ \t\u3000]+$/, "")
      if (trimmed === "") trimmed = " "
      chunks.push(trimmed)
      cur = ""
      cw = 0
    }
    for (const tok of toks) {
      const tw = cellWidth(tok)
      if (cw > 0 && cw + tw > limit) {
        // 行尾是空格且下一 token 放得下 → 优先在空格处断（行尾空格已被 pushLine 裁掉）。
        pushLine()
      }
      if (tw > limit) {
        // 单 token 超宽（超长 URL/长串）：逐字符硬切，至少保证列宽不被突破。
        for (const ch of tok) {
          const wch = cellWidth(ch)
          if (cw > 0 && cw + wch > limit) pushLine()
          cur += ch
          cw += wch
        }
        continue
      }
      cur += tok
      cw += tw
    }
    if (cur !== "" || chunks.length === 0) pushLine()
    if (chunks.length <= wrapCap) return chunks
    const out = chunks.slice(0, wrapCap)
    out[wrapCap - 1] = truncateTo(`${out[wrapCap - 1] ?? ""}…`, limit)
    return out
  }
  const pushRowBlock = (cells: string[]): void => {
    const chunked = cells.map((c, i) => wrapCell(c, widths[i] ?? 0))
    const n = Math.max(1, ...chunked.map((x) => x.length))
    for (let li = 0; li < n; li++) {
      out.push(inner(chunked.map((x) => x[li] ?? "")))
    }
  }
  const out: string[] = []
  out.push(sep("┌", "┬", "┐"))
  if (header.length > 0) {
    pushRowBlock(lines[0])
    out.push(sep("├", "┼", "┤"))
  }
  for (let r = dataStart; r < noHeaderLines; r++) {
    pushRowBlock(lines[r])
    if (r < noHeaderLines - 1) out.push(sep("├", "┼", "┤"))
  }
  out.push(sep("└", "┴", "┘"))
  return fence ? "```\n" + out.join("\n") + "\n```" : out.join("\n")
}

/**
 * 键值列表（用户 2026-09-29 设计反馈）：「配置项 → 值」清单不用框线表格，
 * 用标题 + ━ 分隔线 + 对齐的关键值行——无竖线边框、窄屏折行更自然。
 * 代码围栏内恒等宽，对齐才成立。纯函数、零依赖。
 *
 * 对齐方式二选一：
 * - `tabAlign:false`（默认）：键空格补齐到键宽 + gap 个空格 → 值列固定。
 * - `tabAlign:true`（用户 R1510 指令「使用tab对齐」）：键先补齐到「8 的倍数 −1」
 *   可视列，再紧跟单个 `\t`。值落在 8 的倍数列；TG 各客户端 tab-stop 常见 4 或 8，
 *   对二者该落点一致（4 的倍数 ∩ 8 的倍数 = 8 的倍数），且避开「正好停在 tab stop
 *   上」的边缘歧义。
 */
export type KvListOpts = {
  /** 标题行（可空，输出在分隔线上方）。 */
  title?: string
  /** 键与值之间的最小空格数（默认 4；tabAlign 时忽略）。 */
  gap?: number
  /** 键列固定可视宽度（缺省=按最长键自动对齐）。 */
  keyWidth?: number
  /** 用制表符对齐（默认 false=空格对齐）。 */
  tabAlign?: boolean
}

export const renderKvList = (pairs: Array<readonly [string, string]>, opts: KvListOpts = {}): string => {
  const gap = opts.gap ?? 4
  const tabAlign = Boolean(opts.tabAlign)
  let kw = 0
  for (const [k] of pairs) kw = Math.max(kw, cellWidth(String(k)))
  if (Number.isFinite(opts.keyWidth)) kw = Math.max(kw, Math.max(1, Math.round(opts.keyWidth as number)))
  // tab 对齐的落点列：>kw 的最小 8 的倍数（对 4/8 tab-stop 客户端一致）。
  const tabCol = Math.ceil((kw + 1) / 8) * 8
  const lines: string[] = []
  if (opts.title) lines.push(opts.title)
  // 分隔线略宽于键列（tab 对齐时盖到落点列），覆盖「键+空档」起始区即可。
  lines.push("━".repeat((tabAlign ? tabCol : kw) + gap + 4))
  for (const [k, v] of pairs) {
    const key = String(k)
    lines.push(tabAlign ? padTo(key, tabCol - 1) + "\t" + String(v) : padTo(key, kw) + " ".repeat(gap) + String(v))
  }
  return "```\n" + lines.join("\n") + "\n```"
}