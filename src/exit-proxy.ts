/**
 * R942：出口代理状态（**只读**）。
 *
 * 背景：opencode 的 zen 免费额度按**客户端出口 IP**计。一个长跑的 CI runner 迟早把
 * 额度用光，之后每次 provider 调用都会报 "Free usage limit reached. Connect a
 * provider or subscribe to OpenCode Go to keep going, or switch models."。
 *
 * 旧方案（R941 force-resolve + mihomo 切节点）改的是 **DNS 解析结果**（/etc/hosts
 * 指到另一个 Cloudflare 边缘 IP）或**代理节点**，而源站看到的客户端 IP 并没有变，
 * 额度照样被同一份额度卡住；副作用是 runner 需要可写 /etc/hosts、还需要一套节点切换器。
 *
 * 新方案（CI 侧，.github/scripts/select-proxy.sh）：每轮 CI 从公开代理池里挑一个**真正
 * 的正向代理**，用 HTTP_PROXY/HTTPS_PROXY 注入 opencode 进程（opencode v2 是 Bun
 * 二进制，fetch 认 http_proxy/https_proxy/no_proxy，https 走 CONNECT 隧道），
 * provider 流量因此从**另一个出口 IP** 出去。本模块只负责把这份状态读出来给人看。
 *
 * 重要事实（实测）：**Bun 在进程启动时解析一次代理**，运行期改 process.env 不会换隧道
 * （改完再发请求，请求仍走旧代理）。所以出口代理**只能按轮换**：本轮结束 → workflow
 * relay 起新 run → 新 run 重新挑代理。桥里的"换出口"动作就是"结束本轮"。
 */
import { readFileSync } from "node:fs"

export interface ExitProxyState {
  /** 形如 "1.2.3.4:8080"（不含 scheme） */
  proxy: string
  /** 目前只有 "http"（Bun 不支持 SOCKS：UnsupportedProxyProtocol） */
  scheme: string
  /** 代理的出口 IP（provider 看到的客户端 IP） */
  egress_ip: string
  /** runner 直连出口 IP（额度被耗尽的那一个） */
  direct_ip: string
  /** 探测时延（秒，字符串） */
  latency_s: string
  /** 选取来源描述 */
  source: string
  /** ISO 时间戳 */
  picked_at: string
}

export const EXIT_PROXY_STATE_PATH = `REDACTED_ROOT/.config/opencode/exit-proxy.json`

const asStr = (v: unknown, d = ""): string => (typeof v === "string" ? v : d)

/** 读状态文件；不存在/坏了都返回 null（绝不抛）。 */
export const readExitProxy = (): ExitProxyState | null => {
  try {
    const j = JSON.parse(readFileSync(EXIT_PROXY_STATE_PATH, "utf8")) as any
    const proxy = asStr(j?.proxy).trim()
    if (!proxy) return null
    return {
      proxy,
      scheme: asStr(j?.scheme, "http") || "http",
      egress_ip: asStr(j?.egress_ip),
      direct_ip: asStr(j?.direct_ip),
      latency_s: asStr(j?.latency_s),
      source: asStr(j?.source),
      picked_at: asStr(j?.picked_at),
    }
  } catch {
    return null
  }
}

/** 进程里生效的代理环境（Bun 认这组变量）。 */
export const readExitProxyEnv = (): { httpProxy: string; httpsProxy: string; noProxy: string } => ({
  httpProxy: asStr(process.env.HTTP_PROXY ?? process.env.http_proxy),
  httpsProxy: asStr(process.env.HTTPS_PROXY ?? process.env.https_proxy),
  noProxy: asStr(process.env.NO_PROXY ?? process.env.no_proxy),
})

/** 本轮是否真的走代理（状态文件与进程环境要一致才算）。 */
export const isExitProxyActive = (): boolean => {
  const st = readExitProxy()
  const env = readExitProxyEnv()
  if (!st) return false
  const want = `${st.scheme || "http"}://${st.proxy}`
  return env.httpsProxy === want || env.httpProxy === want
}

/** 一行摘要（写日志/面板用；不含任何密钥）。 */
export const exitProxySummary = (): string => {
  const st = readExitProxy()
  if (!st) {
    const env = readExitProxyEnv()
    if (!env.httpsProxy && !env.httpProxy) return "exit proxy: none (direct connection)"
    return `exit proxy: ${env.httpsProxy || env.httpProxy} (no state file)`
  }
  const bits = [`exit proxy: ${st.scheme}://${st.proxy}`]
  if (st.egress_ip) bits.push(`egress=${st.egress_ip}`)
  if (st.direct_ip) bits.push(`direct=${st.direct_ip}`)
  if (st.latency_s) bits.push(`latency=${st.latency_s}s`)
  return bits.join(" ")
}

/** 面板（多行，给 TG 的 /proxy 用）。 */
export const exitProxyPanel = (): string[] => {
  const st = readExitProxy()
  const env = readExitProxyEnv()
  const lines: string[] = []
  if (!st) {
    lines.push("出口代理：无（直连）")
    if (env.httpsProxy || env.httpProxy) {
      lines.push(`进程代理变量：${env.httpsProxy || env.httpProxy}（状态文件缺失）`)
    }
    lines.push("说明：本轮 CI 没有挑到可用代理，provider 流量走 runner 自身出口 IP。")
    lines.push("提示：额度耗尽时下一轮会重新挑选（见 select-proxy.sh）。")
    return lines
  }
  lines.push(`出口代理：${st.scheme}://${st.proxy}`)
  lines.push(`出口 IP：${st.egress_ip || "?"}（provider 看到的客户端 IP）`)
  lines.push(`直连 IP：${st.direct_ip || "?"}（额度被耗尽的那个）`)
  if (st.latency_s) lines.push(`探测时延：${st.latency_s}s`)
  if (st.picked_at) lines.push(`挑选时间：${st.picked_at}`)
  if (st.source) lines.push(`来源：${st.source}`)
  lines.push(`生效中：${isExitProxyActive() ? "是" : "否（状态与进程环境不一致）"}`)
  lines.push("")
  lines.push("说明：出口代理**按轮换**——本轮内不能换（Bun 在进程启动时解析一次代理）。")
  lines.push("额度耗尽或代理失效时，本轮会结束并由 workflow relay 起新 run，新 run 重新挑选出口 IP。")
  return lines
}
