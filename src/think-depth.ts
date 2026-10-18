/**
 * 「思考深度」选择 = 宿主模型的 **variant（reasoningEffort）** 的纯函数（供单测钉死）。
 *
 * 来源：用户 2026-10-18 新指令「TG桥增加选择思考深度选项」。
 *
 * 为什么抽成纯模块（与 compact-notice.ts 同因）：按钮/文案里混着**宿主给的**未知值，而
 * 这类"把未知当已知"的历史事故正出自本文件族（compact-notice.ts 头注：未知被当成 0B 报给用户）。
 * 这里的两条实测约束（2026-10-18 直连宿主核对）：
 *   1. `GET /api/model` 每个模型的 `variants` **各不相同**：
 *      deepseek-v4.1-flash-free → [low, high, max]（各自 `settings.reasoningEffort`）；
 *      其它模型有 none/minimal/low/medium/high/xhigh/max。⇒ 不能写死一张表。
 *   2. `POST /api/session/{id}/model` 对 variant **不做校验**：
 *      实测 `variant:"zzz"` → HTTP 204，且 `GET` 回读真的变成 `"zzz"`。⇒ 宿主不会替我们挡错，
 *      UI 只能给**清单里的**值；显示端遇到清单外的值必须**如实**说"未列出"，不能假装认识。
 *
 * 另：会话当前 variant 常为 `"default"`，而它**不在** `/api/model` 的 variants 清单里
 * （清单只列可选档位）⇒ 本模块把 `default` 作为第一档显式补上（= 不指定 reasoningEffort）。
 */

export type ThinkVariant = { id: string; effort?: string }

/** 宿主默认档（不指定 reasoningEffort）。 */
export const THINK_DEFAULT = "default"

/** HTML 转义：宿主以 parse_mode=HTML 发送；裸角括号曾把 /model 文案打成 400（见 modelMenuText）。 */
const esc = (s: string): string => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** 档位中文名。**只映射确有语义的档**；未知 id 原样输出（不编、不猜）。 */
const LABELS: Record<string, string> = {
  default: "默认（不指定）",
  none: "关",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
}

/**
 * 宿主模型条目（`GET /api/model` 的一项，或已归一化的 ModelEntry）→ 档位清单。
 *
 * 兼容三种实测/可能形状：`"high"`（纯字符串）、`{id,settings:{reasoningEffort}}`（实测）、
 * `{id,reasoningEffort|effort}`（等价写法）。按 id 去重保序；`default` 恒排第一。
 */
export const variantListOf = (m: unknown): ThinkVariant[] => {
  const raw = (m as any)?.variants
  const src = Array.isArray(raw) ? raw : Array.isArray(m) ? m : []
  const out: ThinkVariant[] = [{ id: THINK_DEFAULT }]
  const seen = new Set<string>([THINK_DEFAULT])
  for (const it of src) {
    const id = String((typeof it === "string" ? it : (it?.id ?? "")) ?? "").trim()
    if (!id || seen.has(id)) continue
    const effort = String(it?.settings?.reasoningEffort ?? it?.reasoningEffort ?? it?.effort ?? id).trim()
    seen.add(id)
    out.push({ id, effort })
  }
  return out
}

/** 档位显示名：已知档给中文，未知档原样（并标注"未列出"由调用方决定，见 thinkMenuText）。 */
export const thinkLabel = (v: ThinkVariant): string => LABELS[v.id] ?? v.id

/** 清单里是否有这个 id（用于显示端判断"宿主未列出的值"）。 */
export const thinkKnown = (id: string, variants: ThinkVariant[]): boolean => variants.some((v) => v.id === id)

/**
 * 用户输入 → 档位。接受：id（大小写不敏感）、中文/英文标签、`默认`。
 * 认不出来**返回 null**（宁可"没改"，也不要猜方向 —— 宿主不校验，猜错会静默写坏会话档位）。
 */
export const resolveThinkLevel = (arg: string, variants: ThinkVariant[]): ThinkVariant | null => {
  const a = String(arg ?? "").trim().toLowerCase()
  if (!a) return null
  const byId = variants.find((v) => v.id.toLowerCase() === a)
  if (byId) return byId
  // 标签反查（中文名 / 英文 id 的展示名）
  const byLabel = variants.find((v) => thinkLabel(v).toLowerCase() === a)
  if (byLabel) return byLabel
  if (a === "默认" || a === "缺省") return variants.find((v) => v.id === THINK_DEFAULT) ?? { id: THINK_DEFAULT }
  return null
}

/**
 * 选择器按钮（纯函数）。每档一行 `thk:set:<下标>`；当前档前缀 ✅；底部「刷新/关闭」。
 * callback_data 全为短编码（<20 字节，Telegram 上限 64）。
 */
export const buildThinkKeyboard = (variants: ThinkVariant[], cur: string): unknown[][] => {
  const rows: unknown[][] = variants.map((v, i) => {
    const on = v.id === cur
    const label = `${on ? "✅ " : ""}${thinkLabel(v)}${v.id === THINK_DEFAULT ? "" : `（${v.id}）`}`
    return [{ text: label.slice(0, 60), callback_data: `thk:set:${i}` }]
  })
  rows.push([
    { text: "🔄 刷新", callback_data: "thk:refresh" },
    { text: "✖️ 关闭", callback_data: "thk:close" },
  ])
  return rows
}

/**
 * 选择器文案（HTML 安全）。`cur` 若不在清单里（如被外部写成 `zzz`），**如实**标注 ——
 * 宿主 POST 不校验，所以"清单外的当前值"是真会出现的状态，不能显示成正常档位。
 */
export const thinkMenuText = (cur: string, variants: ThinkVariant[], modelLabel: string): string => {
  const known = thinkKnown(cur, variants)
  const curLine = known
    ? `当前：<b>${esc(thinkLabel({ id: cur }))}</b>（${esc(cur)}）`
    : `当前：<b>${esc(cur || "未知")}</b> ⚠️ 宿主清单里没有这一档（可能被外部写入）`
  return [
    "<b>🧠 思考深度</b>",
    `模型：<b>${esc(modelLabel || "未知")}</b>`,
    curLine,
    `共 ${variants.length} 档。点档位切换（下次生成生效）；也可发 /think &lt;档位&gt;（如 low / 高 / max）。`,
  ].join("\n")
}
