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
// R1909 ac reload 验证 08:47:51Z

// reload(content) 1791704862 R2235 failed-compaction-unhold

// reload(R2376 stuck-turn escape) 1791778321
// reload(content) 1792074519 R719b proxy-lock
// reload(content) 1792075471 R720 lock-quality-watch
// reload(content) 1792075941 R720 toctou-cooldown-recheck
// reload(content) 1792076685 R721 lock-watch gen-guard
// reload(content) 1792079432 R722 lock-effective-confirm

// reload(content) 1792126065 R724 compaction-bus-publish

// reload(content) 1792156571 R768 user-lock-respect-guard

// reload(content) 1792157825 R772 own-switch-race-fix

// reload(content) 1792158294 R773 race-skip-recheck
