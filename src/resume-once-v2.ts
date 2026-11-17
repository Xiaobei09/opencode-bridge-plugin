/**
 * Option C 装载入口：CI 重启后一次性接回被中断的回合。
 *
 * 与 auto-continue 分开注册（独立插件 id `resume-once`）：
 *   · 只有 workflow 显式设置 RESUME_ONCE_SIDS 时才启用；
 *   · 每次 CI run 最多注入一次，认领文件在 $RUNNER_TEMP；
 *   · 自动循环还开着时默认跳过，避免双重注入。
 */
import { v2Bridge } from "../v2lib/_v2compat.ts"
import { ResumeOncePlugin } from "../v2lib/resume-once.ts"

export default v2Bridge("resume-once", (client) =>
  ResumeOncePlugin({ client } as any)
)
