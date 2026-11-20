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
 *
 * R2778：增加 sendDocument 的 multipart 发送。文档内容不落盘，直接以 Blob 上传；
 * 仍复用主/备通道与 429 记账（由 tg-send 注入的 body 标记触发，见 TG_DOCUMENT_FIELD）。
 */
import type { TelegramResult } from "./tg-transport"

/** 单次 Bot API 调用的硬超时；与抽取前桥内联的 15s 相同。 */
export const TG_API_TIMEOUT_MS = 15_000

/** 文档上传单独放宽：几 MB 的会话记录在慢网络下 15s 不够。 */
export const TG_DOCUMENT_TIMEOUT_MS = 60_000

/** 内部 body 字段：桥用普通 JSON body 传文档，HTTP 层在此切成 multipart。 */
export const TG_DOCUMENT_FIELD = "__tgDocument"

export type TelegramDocument = {
  filename: string
  mime?: string
  content: Uint8Array | ArrayBuffer | string
}

const parseTelegramResponse = async (res: Response): Promise<TelegramResult> => {
  // 先读成文本再解析：错误体是 JSON 时不能先 res.json() 再 res.text()（body 已消费，
  // 旧实现因此在非 JSON 错误上永远拿不到正文）。对 2xx 非 JSON 的行为保持不变。
  let text = ""
  try {
    text = await res.text()
  } catch {
    text = ""
  }
  let j: any = null
  try {
    j = text ? JSON.parse(text) : null
  } catch {
    j = null
  }
  if (res.ok) {
    const id = Number(j?.result?.message_id)
    return { ok: true, id: Number.isFinite(id) ? id : undefined }
  }
  let desc = j ? String(j?.description ?? "") : ""
  let retryAfter = 0
  const ra = Number(j?.parameters?.retry_after)
  if (Number.isFinite(ra) && ra > 0) retryAfter = ra
  if (!desc) desc = text.slice(0, 200)
  if (!retryAfter) {
    const m = /retry after (\d+)/i.exec(desc)
    if (m) retryAfter = Number(m[1])
  }
  return { ok: false, status: res.status, desc: desc.slice(0, 200), retryAfter }
}

const isTelegramDocument = (v: unknown): v is TelegramDocument => {
  if (!v || typeof v !== "object") return false
  const d = v as TelegramDocument
  return typeof d.filename === "string" && d.filename.length > 0 && d.content !== undefined
}

const postDocument = async (
  base: string,
  method: string,
  body: Record<string, unknown>,
  doc: TelegramDocument,
): Promise<TelegramResult> => {
  const form = new FormData()
  for (const [k, v] of Object.entries(body)) {
    if (k === TG_DOCUMENT_FIELD || v === undefined || v === null) continue
    form.set(k, typeof v === "string" ? v : String(v))
  }
  const content = typeof doc.content === "string" ? new TextEncoder().encode(doc.content) : doc.content
  form.set("document", new Blob([content as any], { type: doc.mime || "application/octet-stream" }), doc.filename)
  const res = await fetch(`${base}/${method}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(TG_DOCUMENT_TIMEOUT_MS),
  })
  return parseTelegramResponse(res)
}

export const callTelegramApi = async (
  base: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramResult> => {
  const doc = method === "sendDocument" ? body?.[TG_DOCUMENT_FIELD] : undefined
  if (isTelegramDocument(doc)) {
    return postDocument(base, method, body, doc)
  }
  const res = await fetch(`${base}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TG_API_TIMEOUT_MS),
  })
  return parseTelegramResponse(res)
}
