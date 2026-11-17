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
export const KNOWN_CMDS: ReadonlySet<string> = new Set(["menu", "memu", "watch", "unwatch", "help", "start", "sessions", "use", "clear", "tgping", "ping", "replay", "reload", "compaction", "digest", "queue", "version", "info", "quiet", "loud", "stop", "compact", "new", "fork", "think", "revert", "migrate", "sendto", "raw", "drops", "undo", "retry", "recents", "alias", "loop", "pause", "resume", "flush", "drop", "dropq", "inject", "owner", "offset", "logs", "errors", "whoami", "stripall", "selfmute", "healcards", "cnotice", "quotatail", "quotarecent", "rollover429", "addbot", "addbots", "botname", "botdesc", "autoguard", "background", "model", "proxy", "config"])

export const HELP_TEXT = [
  "📚 [tg-bridge] 可用命令",
  "【会话管理】",
  "· /help — 显示本列表",
  "· /loop on — 本会话加入自动继续（会话级；Bot 级开关见 /loop start|stop）",
  "· /loop off — 本会话退出自动继续（其它会话不受影响）",
  "· /addbot <token> [chatId] [标签] — 登记一个新机器人（登记后需你手动把它拉进会话）",
  "· /addbots <token1> <token2> … — 一条消息批量登记多个机器人（免改代码；token 各不同）",
  "· /sessions — 列出会话，带 [切换] 按钮（别名 /s；之后直接回序号也可选）",
  "  (⭐前台=GUI当前 · ◎活跃=10分钟内有输出 · 📌钉选)",
  "· /use [序号|名称|前缀|ID] — 钉选会话（如：/use 3；别名 /u；空参看当前）",
  "· /recents — 最近 5 个会话",
  "· /alias [名] [会话] — 别名（/alias 列出；/alias del [名] 删除）",
  "· /clear — 取消钉选，跟随前台",
  "· /info — 当前目标会话详情",
  "· /new [标题] — 新建会话",
  "· /fork [消息ID] — 复制当前会话历史到新会话并切换（空=完整历史）",
  "· /revert — 列出最近输入，回退到某次输入之前（默认同时还原文件）",
  "· /revert <序号|msg_…> [nofiles] — 暂存回退；nofiles 只回退对话",
  "· /revert undo — 撤销暂存回退；/revert commit — 立即永久删除回退点及之后",
  "· /migrate — 新会话＋最近摘要（保留上下文，一点切换；/compact 不适合时用）",
  "· /sendto [会话] [文本] — 临时发到指定会话，不改钉选",
  "【历史与重放】",
  "· /replay [N] — 重发最近 N 条（默认 5，不推进标记；别名 /r）",
  "· /reload [N] — 同上，默认 5 条",
  "· /compaction — 推送最近一次压缩摘要",
  "【推送控制】",
  "· /quiet — 推送过滤+压缩设置菜单（别名 /q；/loud 只恢复推送）",
  "· /loud — 恢复全部推送（别名 /l）",
  "· /cnotice [on|off] — 压缩通知开关（「🗜 上下文已压缩」卡片是否发送；默认发；菜单「📣 推送」里也有开关）",
  "· /watch [会话] — 附加镜像该会话（只发最终回复正文，标题带会话名）",
  "· /unwatch [会话] — 取消附加镜像（不带参数=全部取消）",
  "【应答与独立】",
  "· /selfmute [on|off] — 本 Bot 是否只答命令（默认开启应答；每 Bot 独立，互不影响）",
  "· /menu — 打开按钮控制台（推荐入口，所有功能都能点）",
  "· /healcards — 按真实状态纠正卡在“执行中”的工具卡",
  "【运行控制】",
  "· /stop — 停自动循环＋中断当前回合（/loop start 恢复）",
  "· /undo — 只中断当前回合（不停循环；等同卡片 ⏹ 按钮）",
  "· /retry — 重发上一次注入（回复机器人消息发“重来”同效）",
  "· /loop [start|stop|status|simple|full|custom <文本>|mode] — Bot 级自动循环开关（默认一直跑；会话级用 /loop on|off）；simple=每轮只注入“继续”，full=完整模板，custom=自定义文案（支持 {{base}}/{{last_user}}/{{hint}}，/loop custom 查看/设置），mode=在已启用模式间轮切（全局，菜单「🔁 循环 › 每轮注入」里也有按钮）",
  "· /autoguard [on|off|status|problem on|off|web on|off] — 自动停止守卫（检测到问题/网页搜索请求即停循环；菜单「🔁 循环」里也有开关）",
  "· /background [auto on|off|status] — 转后台（把阻塞中的同步子代理转后台；/background 立刻提升，整体自动配置用 auto）",
  "· /model [模型名|id] — 选择模型（无参=打开选择列表；点按钮或 /model <名称> 切换当前会话模型，下次生成生效）",
  "· /think [档位] — 选择思考深度（模型 variant/reasoningEffort；无参=打开档位列表，档位随模型不同：如 default/low/高/max；只接受清单内的值）",
  "· /proxy [next|list] — 出口代理（本轮 provider 流量走的代理；/proxy next = 结束本轮换新出口，新一轮重挑代理）",
  "· /quotatail [auto|off] — 额度尾恢复（跨 CI 一次性续跑：仅换出口后恢复 quota 尾条；不受 /loop off 限制，等待中的 429 换会话也不挡，按过 ⏹ 的会话除外；菜单「🔁 循环/🌐 代理」里也有按钮）",
  "· /rollover429 [on|off|now] — 连续 2 次 429 后是否自动新建会话、切换并注入续跑提示；now=立即人工触发（先停旧回合；每 Bot 独立；菜单「🔁 循环」里也有按钮）",
  "· /quotarecent — 最近一次额度尾恢复记录",
  "· /botname [名称] — 查看/设置 Bot 显示名（空参只读；自动改名为当前会话）",
  "· /botdesc [小字] — 查看/设置 Bot 小字简介（空参只读；自动改为会话短号）",
  "· /compact — 手动触发压缩",
  "· /digest — 推送最近 10 条动态",
  "· /queue — 置顶查看注入队列+未发送队列",
  "· /stripall — 清掉所有旧回复按钮（最新一条保留）",
  "· /pause — 暂停实时推送（命令仍响应）",
  "· /resume — 恢复实时推送",
  "· /flush — 强制发送队列+继续注入",
  "· /drop — 丢弃队列",
  "· /dropq — 丢弃置顶注入队列",
  "· /inject [now|idle] — 注入时机（立即插入/完成插入）",
  "· /raw [文本] — 纯文本注入（不解析命令）",
  "· 直接发文字 — 进入置顶注入队列（串行注入，逐条提示）",
  "· 超长消息自动分段发送（≥3800 字拆多条，不再截断）",
  "· 询问事项手机可直接回复（数字/文字/按钮）",
  "【诊断】",
  "· /tgping（或 /ping tg）— 诊断信息",
  "· /version — 插件版本",
  "· /drops — 最近发送失败记录",
  "· /owner — poll owner 状态",
  "· /offset — 当前 offset",
  "· /logs [N] — tap 日志尾",
  "· /errors [N] — 最近错误",
  "· /whoami — 当前 chat 与目标",
  "━━━━━━━━━━━━━━━",
  "💬 直接发任意文本 → 注入到前台/已钉会话",
  "（长按机器人消息再回复，可带上引用上下文）",
  "（回合无正文结束提示 ◻️ 自然停止）",
].join("\n")
