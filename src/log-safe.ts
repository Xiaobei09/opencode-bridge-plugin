/**
 * R2696（运营者：「代码的复用情况如何，精简，整理，优化，模块融合」）：
 * 日志安全的唯一纯函数层 —— 控制字符、凭据、会话/消息 ID。
 *
 * 此前这三条规则分散在 tg-bridge（redactSecrets / stripLogControls）、
 * _v2compat（shrinkLogIds）与 auto-continue（内联控制字符正则）里：
 * 任何一处新增凭据形态或 ID 前缀，另一条日志路径就继续泄漏。
 * 上收后，各调用点保留**自己的组合与截断长度**，输出逐字节不变。
 *
 * 边界：只做字符串变换，不读环境/状态、不碰 I/O、不记日志。
 */

/**
 * R1873：任何进日志的文本都必须是单行（`\n`/控制字符 → 空格），
 * 否则外部文本可撕裂/伪造日志行。
 */
export const stripLogControls = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, " ")

/**
 * R2883：UTF-16 安全截断。裸 `slice(0,n)` 若切在 emoji 等代理对中间，会留下
 * 孤立代理字符；JSON→Telegram 会渲染成 U+FFFD，严重时整条消息 400。
 * 切点前一字符是高位代理（D800-DBFF）时回退 1，保证代理对完整。
 * `safeTail` 是对应的尾部截断：起点是低位代理（DC00-DFFF）时前移 1。
 */
export const safeCut = (s: string, max: number): string => {
  const n = Math.max(0, Math.floor(Number(max) || 0))
  if (s.length <= n) return s
  let end = n
  if (end > 0) {
    const code = s.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end -= 1
  }
  return s.slice(0, end)
}

export const safeTail = (s: string, max: number): string => {
  const n = Math.max(0, Math.floor(Number(max) || 0))
  if (s.length <= n) return s
  let start = s.length - n
  const code = s.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start += 1
  return s.slice(start)
}

/**
 * 凭据脱敏：Telegram 的调用形如 https://api.telegram.org/bot<TOKEN>/sendMessage，
 * 只要任何一条日志带上 URL（fetch 异常、错误对象、调试打印），token 就落盘了。
 * R1886：形态扩到 provider 侧 —— 宿主/provider 的原样错误文本经 sanitizeLog(err) 进日志，
 * 而 /errors 与 /logs 会把日志回显到会话窗口；误伤控制：sk- 需 >=12 位且 \b 夹住、
 * query 密钥参数须带 ?/& 前缀、只抹值保留参数名。当前无线上泄漏证据（命中 0）。
 */
export const redactSecrets = (s: string): string =>
  s
    .replace(/\/bot\d{5,}:[A-Za-z0-9_-]{8,}/g, "/bot<redacted>")
    .replace(/\bbot\d{5,}:[A-Za-z0-9_-]{8,}\b/g, "bot<redacted>")
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "<redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "<redacted>")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/g, "$1 <redacted>")
    .replace(/([?&](?:api_key|apikey|access_token|token|key)=)[^&\s"'<>]{6,}/gi, "$1<redacted>")

/**
 * R2668: public CI Actions logs are world-readable. Session/message ids are not
 * credentials, but they let anyone correlate a public log line with the private
 * session DB. Keep a short prefix for correlation and drop the rest.
 *
 * The regex intentionally requires at least 5 chars after the `ses_`/`msg_`
 * prefix so an already-shortened id (`ses_e2ac…`) is left untouched.
 */
export const shrinkLogIds = (s: string): string =>
  s
    .replace(/\bses_[A-Za-z0-9_-]{5,}/g, (m) => `${m.slice(0, 8)}…`)
    .replace(/\bmsg_[A-Za-z0-9_-]{5,}/g, (m) => `${m.slice(0, 8)}…`)
