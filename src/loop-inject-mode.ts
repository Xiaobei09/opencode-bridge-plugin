/**
 * R2659（运营者原文：「添加简单模式，只注入“继续”」）/ R2663（运营者：「增加一个
 * 自动循环注入信息自定义模式」）：自动循环每轮注入的**文案模式**。
 *
 * 三种模式：
 *   · full  （默认，保持既有行为）：
 *       ROUND_PROMPT / RECOVER_PROMPT + lastUserSection + AUTO_INJECT_HINT
 *   · simple（简单模式）：
 *       只发两个字「继续」。不附上次用户内容，也不附自动注入提示。
 *   · custom（自定义模式，R2663）：
 *       发用户保存的文案。支持占位符：
 *         `{{base}}`      = 当前轮次的默认提示词（ROUND/RECOVER 正文）
 *         `{{last_user}}` = 最近一条真实用户内容摘录（取不到则为空）
 *         `{{hint}}`      = 自动注入提示（纯文本，不带前导空行）
 *       没有占位符时原样发送；替换后为空则退回完整模板（绝不发空消息）。
 *
 * 为什么单独一个文件而不是塞进 loop-ctl.json：
 *   后者是**自动循环总闸**（读取侧只认 stopped/sids），语义不同；混在一起会让
 *   「停循环」和「换注入文案」互相覆盖。本文件只存 mode + custom，读写都很小。
 *
 * 为什么带 metadata：
 *   简单模式正文只有「继续」、自定义文案更是任意文本，与真实用户输入**无法从
 *   文本上区分**。宿主会把 `metadata` 持久化到 user 消息行里（实测
 *   `POST /api/session/{id}/prompt` 的 `{"metadata":{"loopInject":"simple"}}`
 *   在 message.metadata 原样保留），所以注入时带上标记，识别侧（tg-bridge 抢前台、
 *   auto-continue 回退合成消息、lastRealUserExcerpt）以 metadata 为准；真实用户
 *   输入同样的文本不会被误判。
 *
 * 默认 full：读不到/文件损坏时都退回完整模板，不改变既有部署行为。旧文件只有
 * `{mode, ts}`（没有 custom）仍然可读；写模式时保留已保存的自定义文案。
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { safeCut } from "./log-safe"
import { AUTO_INJECT_HINT } from "./turn-end-note"

export type LoopInjectMode = "full" | "simple" | "custom"

export const SIMPLE_CONTINUE_TEXT = "继续"
export const LOOP_INJECT_META_KEY = "loopInject"
/** R2659 遗留值：只用于旧文件/旧测试的精确识别，新代码判断合成消息请用 isLoopInjectMeta。 */
export const LOOP_INJECT_META_VALUE = "simple"
export const LOOP_INJECT_CUSTOM_META_VALUE = "custom"
export const LOOP_INJECT_CUSTOM_MAX = 4000
export const LOOP_INJECT_MODE_PATH = `REDACTED_ROOT/.config/opencode/loop-inject-mode.json`

/** 自定义文案占位符（文档/提示与实现共用一份，避免说明漂移）。 */
export const LOOP_INJECT_PLACEHOLDERS = [
  ["{{base}}", "当前轮次默认提示词"],
  ["{{last_user}}", "最近一条真实用户内容摘录"],
  ["{{hint}}", "自动注入提示"],
] as const

export type LoopInjectConfig = { mode: LoopInjectMode; custom: string }

/** 自定义文案归一：统一换行、去首尾空白、限长。空文本表示「没有自定义文案」。 */
export const normalizeLoopInjectCustom = (text: unknown): string => {
  const t = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .trim()
  return safeCut(t, LOOP_INJECT_CUSTOM_MAX)
}

const readRawConfig = (): LoopInjectConfig => {
  try {
    const j = JSON.parse(readFileSync(LOOP_INJECT_MODE_PATH, "utf8")) as any
    const custom = normalizeLoopInjectCustom(j?.custom)
    const rawMode: LoopInjectMode = j?.mode === "simple" || j?.mode === "custom" ? j.mode : "full"
    // 不变量：mode=custom 必须真的有文案，否则按完整模板执行（避免空注入）。
    const mode: LoopInjectMode = rawMode === "custom" && !custom ? "full" : rawMode
    return { mode, custom }
  } catch {
    return { mode: "full", custom: "" }
  }
}

/** 当前注入模式。每次调用现读（注入间隔 ≥90s，读一个小 JSON 的代价可忽略），
 *  这样在 TG 菜单里切换后下一轮立即生效，无需重启。 */
export const readLoopInjectMode = (): LoopInjectMode => readRawConfig().mode

/** 当前自定义文案（未设置为空串）。 */
export const readLoopInjectCustom = (): string => readRawConfig().custom

/** 模式 + 自定义文案一次读出（菜单渲染用，避免两次读盘拿到不一致快照）。 */
export const readLoopInjectConfig = (): LoopInjectConfig => readRawConfig()

const writeRawConfig = (mode: LoopInjectMode, custom: string): boolean => {
  const payload = JSON.stringify({ mode, custom, ts: Date.now() })
  const tmp = `${LOOP_INJECT_MODE_PATH}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 })
    renameSync(tmp, LOOP_INJECT_MODE_PATH)
    return true
  } catch {
    try {
      writeFileSync(LOOP_INJECT_MODE_PATH, payload, { encoding: "utf8", mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
}

/** 写模式（原子：临时文件 + rename）。保留已保存的自定义文案。
 *  请求 custom 但尚无文案时退回 full —— 不写下「选自定义却没有内容」的死状态。 */
export const writeLoopInjectMode = (mode: LoopInjectMode): boolean => {
  const cur = readRawConfig()
  const next: LoopInjectMode = mode === "custom" ? (cur.custom ? "custom" : "full") : mode
  return writeRawConfig(next, cur.custom)
}

/** 保存自定义文案并切到自定义模式。空文案拒绝写入（返回 false，调用方如实回报）。 */
export const writeLoopInjectCustom = (text: string): boolean => {
  const custom = normalizeLoopInjectCustom(text)
  if (!custom) return false
  return writeRawConfig("custom", custom)
}

/** 精确匹配「继续」（允许首尾空白）。`继续吧` / `继续处理` / `继续。` 都不算。 */
export const isSimpleContinueText = (text: string): boolean =>
  String(text ?? "").trim() === SIMPLE_CONTINUE_TEXT

/** 注入侧写的合成标记：`{ loopInject: <任意非空字符串> }`。宿主把 metadata 原样
 *  存进 user 消息的 info/metadata；读取兼容 v1 `{info:{metadata}}` 与 v2 `{metadata}`。
 *  R2663：从「只认 simple」泛化为「认任意 loop inject 标记」——custom 文案可以是
 *  任意文本，只靠文本前缀无法识别，漏掉就会被当真实用户消息。 */
export const isLoopInjectMeta = (meta: unknown): boolean => {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false
  const v = (meta as any)[LOOP_INJECT_META_KEY]
  return typeof v === "string" && v.length > 0
}

/** R2659 语义保留：只认 `{loopInject:"simple"}`（旧测试/旧调用方使用）。 */
export const isSimpleInjectMeta = (meta: unknown): boolean =>
  !!meta && typeof meta === "object" && (meta as any)[LOOP_INJECT_META_KEY] === LOOP_INJECT_META_VALUE

/** 从一条消息行（v1 `{info,parts}` / v2 `{metadata,content}`）取注入标记。 */
export const rowHasLoopInjectMeta = (row: unknown): boolean => {
  const r: any = row
  return isLoopInjectMeta(r?.info?.metadata ?? r?.metadata)
}

/** R2659 语义保留：只认 simple 行。 */
export const rowHasSimpleInjectMeta = (row: unknown): boolean => {
  const r: any = row
  return isSimpleInjectMeta(r?.info?.metadata ?? r?.metadata)
}

/** 该模式注入时应带的 metadata（full 依赖文本前缀识别，不带标记）。 */
export const loopInjectMetaForMode = (mode: LoopInjectMode): Record<string, string> | undefined =>
  mode === "simple"
    ? { [LOOP_INJECT_META_KEY]: LOOP_INJECT_META_VALUE }
    : mode === "custom"
      ? { [LOOP_INJECT_META_KEY]: LOOP_INJECT_CUSTOM_META_VALUE }
      : undefined

/** 菜单/状态文案里的模式名。 */
export const loopInjectModeLabel = (mode: LoopInjectMode): string =>
  mode === "simple" ? "简单（只发“继续”）" : mode === "custom" ? "自定义文案" : "完整模板"

/** 根页/按钮的短名。 */
export const loopInjectModeShortLabel = (mode: LoopInjectMode): string =>
  mode === "simple" ? "简单" : mode === "custom" ? "自定义" : "完整"

/** 单行预览（命令回执/菜单用），超长截断并折叠空白。 */
export const loopInjectCustomPreview = (text: unknown, max = 80): string => {
  const t = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
  const cut = safeCut(t, max)
  return cut.length < t.length ? `${cut}…` : t
}

/**
 * 组合本轮注入文本（纯函数，便于单测）。full 与既有行为逐字节一致：
 *   没有上次用户内容时 = base + hint；有则 = base + "\n\n" + 摘录 + hint。
 * custom 的占位符替换使用**去首尾空白**后的摘录，避免模板里出现多余空行。
 */
export const composeLoopInjectText = (
  mode: LoopInjectMode,
  input: { base: string; lastUser?: string; custom?: string; hint?: string },
): string => {
  const base = String(input.base ?? "")
  const hint = input.hint ?? AUTO_INJECT_HINT
  const lastUser = String(input.lastUser ?? "").trim()
  const lastUserBlock = lastUser ? `\n\n${lastUser}` : ""
  if (mode === "simple") return SIMPLE_CONTINUE_TEXT
  if (mode === "custom") {
    const custom = normalizeLoopInjectCustom(input.custom)
    if (custom) {
      const out = custom
        .replaceAll("{{base}}", base)
        .replaceAll("{{last_user}}", lastUser)
        .replaceAll("{{hint}}", hint.trim())
      // 模板可能只由「取不到的占位符」组成（如只有 {{last_user}}）→ 不能发空消息。
      if (out.trim()) return out
    }
  }
  return `${base}${lastUserBlock}${hint}`
}
