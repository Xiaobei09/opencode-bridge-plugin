// R2721：/loop 的注入文案子命令（custom / full / simple / mode）从桥内上收。
// 只处理“每轮注入什么”，循环启停与逐会话状态仍留在桥内；解析与读写复用
// loop-inject-mode 的单一实现。
import type { LoopInjectMode } from "./loop-inject-mode"

export type LoopInjectDeps = {
  readMode: () => LoopInjectMode
  readCustom: () => string
  writeMode: (mode: LoopInjectMode) => boolean
  writeCustom: (text: string) => boolean
  modeLabel: (mode: LoopInjectMode) => string
  customPreview: (text: unknown, max?: number) => string
  placeholders: Array<[string, string]>
  customMax: number
  htmlEsc: (s: string) => string
  reply: (chatID: string, text: string) => Promise<void>
}

export type LoopInjectRunArgs = {
  chatID: string
  /** `/loop` 之后的原始参数（保留大小写与空白，用于 custom 文案）。 */
  arg: string
}

export const createLoopInjectCommands = (deps: LoopInjectDeps) => {
  const { readMode, readCustom, writeMode, writeCustom, modeLabel, customPreview, placeholders, customMax, htmlEsc, reply } = deps

  const run = async ({ chatID, arg: rawArg }: LoopInjectRunArgs): Promise<boolean> => {
    const arg = String(rawArg ?? "").trim().toLowerCase()
    //   /loop custom <文本> = 保存并启用；/loop custom on = 启用已保存；
    //   /loop custom = 只查看；/loop full|simple = 切换且保留自定义文案；
    //   /loop mode = 在已启用模式间轮切（有自定义文案时包含 custom）。
    const customArg = /^custom(?:\s+|$)/i.test(rawArg) ? rawArg.replace(/^custom\s*/i, "").trim() : null
    const isModeSwitch = arg === "simple" || arg === "full" || arg === "mode" || arg === "inject" || arg === "injectmode"
    if (customArg === null && !isModeSwitch) return false

    if (customArg !== null) {
      const saved = readCustom()
      if (!customArg) {
        const cur = readMode()
        await reply(
          chatID,
          `💉 自定义注入文案` +
            (saved
              ? `（当前${cur === "custom" ? "启用中" : "未启用"}，${saved.length} 字）：\n<pre>${htmlEsc(saved)}</pre>`
              : "：当前未设置。") +
            `\n\n用法：\n` +
            `· /loop custom 你的文案 → 保存并启用\n` +
            `· /loop custom on → 启用已保存文案\n` +
            `· /loop full 或 /loop simple → 切换模式（保留已保存文案）\n` +
            `占位符：${placeholders.map(([k, v]) => `${k}=${v}`).join("；")}\n` +
            `无占位符 = 原样发送；长度上限 ${customMax} 字。`,
        )
        return true
      }
      if (customArg.toLowerCase() === "on") {
        if (!saved) {
          await reply(chatID, "⚠️ 尚未保存自定义文案：先发 /loop custom 你的文案")
          return true
        }
        const ok = writeMode("custom")
        await reply(
          chatID,
          `💉 续跑文案 → <b>自定义</b> · 已启用（${saved.length} 字） · 全局（下一轮生效）` +
            (ok ? "" : "\n⚠️ 写入失败：检查文件权限"),
        )
        return true
      }
      const ok = writeCustom(customArg)
      await reply(
        chatID,
        ok
          ? `💉 已保存并启用自定义文案（${customArg.length} 字）\n` +
            `<code>${htmlEsc(customPreview(customArg, 160))}</code>\n` +
            `占位符：${placeholders.map(([k, v]) => `${k}=${v}`).join("；")} · 全局（下一轮生效）`
          : "⚠️ 自定义文案写入失败（空文案或文件权限问题）",
      )
      return true
    }

    const cur = readMode()
    const hasCustom = Boolean(readCustom())
    const next: LoopInjectMode =
      arg === "simple"
        ? "simple"
        : arg === "full"
          ? "full"
          : cur === "full"
            ? "simple"
            : cur === "simple"
              ? hasCustom
                ? "custom"
                : "full"
              : "full"
    const ok = writeMode(next)
    // R2759（运营者「继续缩短」）：模式切换只回一行（自定义文案另起一行显示内容），
    // 去掉 [tg-bridge] 前缀与重复的「三个 Bot 共用」解释；/loop custom 的用法页保持完整。
    await reply(
      chatID,
      `💉 续跑文案 → <b>${modeLabel(next)}</b>` +
        (next === "custom" ? `\n文案：<code>${htmlEsc(customPreview(readCustom(), 120))}</code>` : "") +
        ` · 全局（下一轮生效）` +
        (ok ? "" : "\n⚠️ 写入失败：检查文件权限"),
    )
    return true
  }

  return { run }
}
