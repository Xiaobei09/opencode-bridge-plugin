# OpenCode Bridge Plugin (sanitized)

TG↔Opencode 桥接插件源码（脱敏发布版），版本受控。

## 组成

| 文件 | 说明 |
|---|---|
| `src/tg-bridge.ts` | 桥主逻辑：长轮询、注入、发送、看门狗、队列卡、proto 镜像 |
| `src/auto-continue.ts` | 自动循环：evaluate/注入闸/租约/熔断 |
| `src/tg-bridge-v2.ts` | 插件装载入口（bot 配置与 env 读取） |
| `src/auto-continue-v2.ts` | 自动循环装载入口（V1 插件经 _v2compat 包成 V2） |
| `src/_v2compat.ts` | 兼容层 |
| `src/bg-mode.ts` | 「转后台」能力：原生后台子代理的提升（promote）与整体自动配置 |
| `src/bg-watch.ts` | 插件层「shell 跑超 N 秒强制转后台」的合规实现 |
| `src/compact-notice.ts` | 「上下文已压缩」通知的文案判据（纯函数） |
| `src/loop-guard.ts` | 循环「自动停止守卫」（检测到问题 / 网页搜索请求即停） |
| `src/tabular.ts` | TG 等宽表格 / 键值列表渲染（纯函数，状态与诊断消息对齐用） |
| `src/shell-promo.ts` | shell 结果晋升为后台任务卡的判据与文案 |
| `src/abort-classify.ts` | 中止原因分类（用户中止 / 超时 / 宿主错误）与遥测字段 |
| `src/inbound-silence.ts` | 入站静默判定（决定是否需要应答） |
| `src/turn-end-note.ts` | 轮末「AI 主动结束输出」短提示文案 |
| `src/bg-hint.ts` | shell 后台运行提示卡（新鲜度判据 + 文案） |

## 脱敏声明

- 所有 Bot token / API key 均从环境变量读取，**源码不含任何密钥**（发布前已扫描 + 断言双保险）。
- 服务器内部路径 `/root/...` 已替换为 `REDACTED_ROOT/...`（源码中仅保留 `process.env.HOME ?? "/root"` 这类**通用 HOME 兜底字面量**，非部署专用路径）。
- 会话/消息内部 id、部署细节均不在本仓库出现。

## 版本控制

- 每次功能变更合入后，将脱敏副本同步提交到本仓库。
- Tag 规则：`v<日期>-<轮次>`（例：`v20260927-r1089`）。