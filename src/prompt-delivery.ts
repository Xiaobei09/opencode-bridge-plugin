/**
 * R2660（运营者：「自动注入有时机问题：有时候还在输出就注入 / 停止很久后才注入」）：
 * 注入请求的可选字段（投递时机 + 是否恢复执行）与旧宿主降级序列。
 *
 * ## 为什么必须单独成模块
 * `_v2compat.promptAsync` 是 v1 形状的适配层。历史上它**刻意只转发了正文和 metadata**，
 * 把调用方显式写的 `delivery:"queue"` / `resume:true` 丢掉了 —— 而宿主对这两个字段的
 * 默认值是 `delivery:"steer"`（立即插进正在跑的回合，见二进制里的 `f.delivery??"steer"`）。
 * 于是：
 *   · 闸门只要有几秒误判，ROUND_PROMPT 就会被 steer 进正在输出的回合（用户看到“还在
 *     输出就注入”）；
 *   · 队列投递（queue）本应等回合结束再落盘，却被当成 steer，先落成 user 消息。
 *
 * 现在原样透传；只有宿主以**形状错误**拒绝时，才按「丢 metadata → 丢时机 → 纯文本」
 * 逐级降级。降级顺序刻意把 delivery 放在 metadata 前面：metadata 只影响合成消息识别，
 * 丢了顶多识别退化；delivery/resume 丢了会直接改变注入时机。
 *
 * 停在这里而不是把 payload 拼装散在 `_v2compat` 里：纯函数可单测，回归不用等生产。
 */
export type PromptDelivery = "queue" | "steer"

export const isPromptDelivery = (v: unknown): v is PromptDelivery => v === "queue" || v === "steer"

/**
 * 宿主对「不认识的字段 / 形状不符」的报错。只对这类错误做降级重试：
 * 网络/超时类错误可能已经**被受理**，重试会重复注入（比丢一次注入更难查）。
 */
export const isPromptShapeError = (err: unknown): boolean =>
  /missing\s*key|missingkey|schemaerror|schema|unexpected\s*key|unknown\s*key|unrecognized|invalid\s*(input|payload|argument)|not\s*allowed/i.test(
    String((err as any)?.message ?? err ?? ""),
  )

export interface PromptPayloadInput {
  sessionID: string
  text: string
  metadata?: Record<string, unknown>
  delivery?: PromptDelivery
  resume?: boolean
}

/**
 * 从「信息最全」到「最保守」的尝试序列：
 *   1. metadata + delivery + resume（正常宿主）
 *   2. delivery + resume（旧宿主不认 metadata）
 *   3. metadata（宿主不认时机字段；至少保住合成标记）
 *   4. 纯 {sessionID,text}（最老宿主）
 * 去重后返回；调用方只在前一次被 `isPromptShapeError` 拒绝时试下一个。
 */
export const promptPayloads = (i: PromptPayloadInput): Array<Record<string, unknown>> => {
  const base: Record<string, unknown> = { sessionID: i.sessionID, text: i.text }
  const hasMeta = !!i.metadata && typeof i.metadata === "object"
  const hasDelivery = isPromptDelivery(i.delivery)
  const hasResume = typeof i.resume === "boolean"
  const out: Array<Record<string, unknown>> = []
  const push = (p: Record<string, unknown>) => {
    if (!out.some((x) => JSON.stringify(x) === JSON.stringify(p))) out.push(p)
  }
  const full: Record<string, unknown> = { ...base }
  if (hasMeta) full.metadata = i.metadata
  if (hasDelivery) full.delivery = i.delivery
  if (hasResume) full.resume = i.resume
  push(full)
  if (hasMeta) {
    const timing: Record<string, unknown> = { ...base }
    if (hasDelivery) timing.delivery = i.delivery
    if (hasResume) timing.resume = i.resume
    push(timing)
  }
  if (hasMeta && (hasDelivery || hasResume)) push({ ...base, metadata: i.metadata })
  push(base)
  return out
}
