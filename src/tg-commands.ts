// R2705：命令注册表 + 命令 token 纯解析从 tg-bridge 上收。
// 只收敛“命令叫什么、帮助怎么写”这类静态数据；实际处理分支仍在桥内。
// 目的：命令名、别名、帮助列表、已知命令集合不再各写一份（漏登记会静默变成未知命令）。
// R1823：群聊命令的 @botname 后缀剥离（纯函数）。Telegram 在群聊会把命令改写成 `/cmd@BotName`；
// 各命令块的参数切片按 "/cmd " 前缀做，带 @ 后缀时前缀失配 → 参数被吞空（/use、/watch、/alias）
// 或错位（/sendto 把 "botname" 当成会话名）。只剥离**紧跟在首个命令 token 后**的 @后缀：
// 对普通文本、已含空格的命令、以及参数里出现的 @ 均零影响（正则要求 @ 紧跟命令 token、中间不能有空格）。
export const stripCmdBotSuffix = (text: string): string =>
  text.replace(/^(\/[A-Za-z0-9_]+)@[A-Za-z0-9_]+/, "$1")

// R1830：取「命令 token 之后的参数」的通用纯函数，取代各块硬编码的 `text.startsWith("/cmd ")` 切片。
// 动机（R1823 同一缺陷类的**残余分支**）：命令名经 CMD_ALIAS 归一（/u→use）、且 stripCmdBotSuffix 已剥 @suffix 后，
// 文本可能仍是 `/u 3`；此时按 `/use ` 切片得到空串 → `/u 3` 静默退化成"看当前目标"，`/r 10` 退化成默认 5。
// 规则：去首部空白 → 必须 `/` 开头 → 跳过第一个非空白 token（命令名）→ 返回其余（保留内部空格）。
// 对普通文本、无参命令、参数内 @ 均零副作用。
export const commandArg = (text: string): string => {
  const t = String(text ?? "").trimStart()
  if (!t.startsWith("/")) return ""
  const m = /^\/[^\s]+/.exec(t)
  return m ? t.slice(m[0].length).trim() : ""
}

// R1846：命令 token 归一（小写）。Telegram **原样投递**用户键入的大小写（只有菜单自动补全才是小写），
// 而命令名恒为小写。旧实现 cmd 不做 toLowerCase：`/Menu`、`/USE`、`/U` 既不命中任何命令块，
// 也不在 KNOWN_CMDS 内 → 被回成「❓ 未知命令 /Menu」（用户明明敲的是正确命令），且永远走不到
// 真实处理。此处在**入口**统一归一，别名表 CMD_ALIAS（键本就小写）随之自然命中。
export const normalizeCmd = (text: string): string => {
  const t = String(text ?? "")
  if (!t.startsWith("/")) return ""
  return t.slice(1).split(/[\s@]/)[0].toLowerCase()
}

/** 命令别名（入口 normalizeCmd 后归一，键恒小写）。 */
export const CMD_ALIAS: Record<string, string> = { u: "use", s: "sessions", r: "replay", q: "quiet", l: "loud" }

/**
 * 已知命令集合（未知命令回执的唯一判据）。
 * 新增命令时必须同步加入，否则用户看到「未知命令」；tg-commands 测试会核对帮助列表。
 */
export const KNOWN_CMDS: ReadonlySet<string> = new Set(["menu", "memu", "watch", "unwatch", "help", "start", "sessions", "use", "clear", "tgping", "ping", "tgpingall", "pingall", "status", "replay", "reload", "export", "compaction", "digest", "queue", "version", "info", "quiet", "loud", "stop", "compact", "new", "fork", "think", "revert", "migrate", "sendto", "raw", "drops", "undo", "retry", "recents", "alias", "loop", "pause", "resume", "flush", "drop", "dropq", "inject", "owner", "offset", "logs", "errors", "whoami", "stripall", "selfmute", "healcards", "cnotice", "ctxnotice", "quotatail", "quotarecent", "rollover429", "cardops", "addbot", "addbots", "botname", "botdesc", "autoguard", "background", "model", "proxy", "config"])

export const HELP_TEXT = [
  "📚 [tg-bridge] 命令",
  "【会话】",
  "· /help — 本列表",
  "· /menu — 按钮控制台（推荐）",
  "· /sessions — 会话列表（别名 /s）",
  "· /recents — 最近会话",
  "· /use [序号|名称|ID] — 固定目标会话（别名 /u；空参=当前）",
  "· /clear — 取消固定，跟随前台",
  "· /info — 当前会话详情",
  "· /alias [名] [会话] — 别名；del 删除",
  "· /new [标题] — 新建会话",
  "· /fork [消息ID] — 复制历史到新会话并切换",
  "· /revert [序号|msg_ID] [nofiles] — 回退输入；/revert undo|commit|list",
  "· /migrate — 新会话 + 最近摘要",
  "· /sendto [会话] [文本] — 临时发送，不改固定目标",
  "【历史】",
  "· /replay [N] — 重发最近 N 条（默认 5，别名 /r）",
  "· /reload [N] — 同上",
  "· /export [分钟] [tg|full] — 导出会话文件（默认模拟 TG；full=完整记录，不截断）",
  "· /compaction — 最近压缩摘要",
  "· /digest — 最近 10 条动态",
  "【推送】",
  "· /quiet — 过滤/压缩菜单（别名 /q）",
  "· /loud — 恢复全部推送（别名 /l）",
  "· /cnotice [on|off] — 压缩通知",
  "· /ctxnotice [on|off] — 上下文占用 40%/60% 提醒",
  "· /watch [会话] — 镜像会话（附加推送）",
  "· /unwatch [会话] — 取消镜像（空=全部）",
  "· /pause — 暂停实时推送",
  "· /resume — 恢复实时推送",
  "· /inject [now|idle] — 立即注入（不等回合）/ 回合后注入\n· /inject diag — 注入诊断（为什么没注入/卡在哪一步）",
  "· /queue — 查看注入/外发队列",
  "· /flush — 强发队列并继续注入",
  "· /drop — 清空外发队列",
  "· /dropq — 清空注入队列",
  "· /raw [文本] — 原样注入",
  "【循环/运行】",
  "· /loop [on|off|start|stop|status|simple|full|custom|mode] — 自动循环",
  "· /stop — 停循环 + 中断回合",
  "· /undo — 只中断回合",
  "· /retry — 重发上次注入",
  "· /compact — 手动压缩",
  "· /autoguard [on|off|status|problem|web] — 问题/搜索即停",
  "· /background [auto|shell|th|status] — 后台设置",
  "· /model [模型] — 模型",
  "· /think [档位] — 思考",
  "· /proxy [next|list] — 代理",
  "· /quotatail [auto|off] — 换出口后补发 429 尾条",
  "· /rollover429 [on|off|now] — 429 自动换会话（每 Bot）",
  "· /cardops [on|off] — 本 Bot 通知与卡片修复（CI/代理/限流/热重载/队列恢复；置顶丢失重钉）；429 提示与错误卡始终发送",
  "· /quotarecent — 最近额度续跑",
  "【Bot/维护】",
  "· /selfmute [on|off] — 只答命令",
  "· /botname [名称] — Bot 名称",
  "· /botdesc [文字] — Bot 简介",
  "· /addbot <token> [chatId] [标签] — 登记机器人",
  "· /addbots <token...> — 批量登记",
  "· /stripall — 清理旧回复按钮",
  "· /healcards — 修复卡住的工具卡",
  "【诊断】",
  "· /status — 状态总览（会话/队列/循环/入站）",
  "· /tgping — 连通性诊断（/ping tg）",
  "· /tgpingall — 全部 Bot 的 TG 连通性（/tgping all）",
  "· /version — 版本",
  "· /config — 配置",
  "· /drops — 发送失败",
  "· /errors [N] — 最近错误",
  "· /logs [N] — 日志尾",
  "· /owner — 入站轮询者状态",
  "· /offset — 入站轮询偏移",
  "· /whoami — 当前身份/目标",
  "━━━━━━━━━━━━━━━",
  "💬 直接发文本 → 注入目标会话",
].join("\n")
