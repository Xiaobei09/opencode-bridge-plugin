/**
 * 自动循环（auto-continue）V2 装载入口。
 *
 * v2lib/auto-continue.ts 保持 V1 形态（AutoContinuePlugin = async ({client}) => ({event,...})），
 * 这里用 _v2compat.ts 的 v2Bridge 适配器包成 V2 插件（{id, setup}）：
 *   - setup 里构建 V1 形态 client，跑工厂拿到 {event} 钩子
 *   - event 钩子订阅映射到 V1 事件（message.updated / session.idle 等）
 */
import { v2Bridge } from "REDACTED_ROOT/.opencode/v2lib/_v2compat.ts"
import { AutoContinuePlugin } from "REDACTED_ROOT/.opencode/v2lib/auto-continue.ts"

export default v2Bridge("auto-continue", (client) =>
  AutoContinuePlugin({ client } as any)
)
