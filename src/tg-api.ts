/**
 * R2690（运营者：「分模块化设计…不改表现」）：Telegram Bot API 的 HTTP 客户端层。
 *
 * 从 tg-bridge.ts 的 callTelegram 抽出。此前“怎么发一个 API 调用、怎么读回包”与
 * “主/备通道怎么选、闸门怎么记、何时写共享标记”混在同一个闭包里：
 *   · POST / 超时 / 2xx 解析 / 错误体解析可以直接对着真 HTTP 服务器测；
 *   · 通道编排要碰 floodGate、日志与 bot-flood.json，属于桥的组合根。
 * 本模块只做前者，且**不产生业务副作用**：sendMessage 成功后的 latest-message
 * 记账仍由桥在拿到结果后执行。
 *
 * 输出与抽取前逐字节一致：
 *   · 2xx 且 JSON 可解析 → message_id 有限才给 id；解析失败仍视为成功；
 *   · 非 2xx → description 优先 JSON，其次 retry_after 参数，最后正文前 200 字；
 *   · description 里的 "retry after N" 作为 retry_after 兜底；
 *   · 网络异常不在这里吞掉 —— 抛给调用方，由通道编排统一转成 status 0。
 */
import type { TelegramResult } from "./tg-transport"

/** 单次 Bot API 调用的硬超时；与抽取前桥内联的 15s 相同。 */
export const TG_API_TIMEOUT_MS = 15_000

export const callTelegramApi = async (
  base: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramResult> => {
  const res = await fetch(`${base}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TG_API_TIMEOUT_MS),
  })
  if (res.ok) {
    try {
      const j = (await res.json()) as any
      const id = Number(j?.result?.message_id)
      return { ok: true, id: Number.isFinite(id) ? id : undefined }
    } catch {
      return { ok: true }
    }
  }
  let desc = ""
  let retryAfter = 0
  try {
    const j = (await res.json()) as any
    desc = String(j?.description ?? "")
    const ra = Number(j?.parameters?.retry_after)
    if (Number.isFinite(ra) && ra > 0) retryAfter = ra
  } catch {
    desc = ""
  }
  if (!desc) {
    try { desc = (await res.text()).slice(0, 200) } catch { desc = "" }
  }
  if (!retryAfter) {
    const m = /retry after (\d+)/i.exec(desc)
    if (m) retryAfter = Number(m[1])
  }
  return { ok: false, status: res.status, desc: desc.slice(0, 200), retryAfter }
}
