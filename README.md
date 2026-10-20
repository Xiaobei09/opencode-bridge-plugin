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
| `src/think-depth.ts` | 「思考深度」选择（宿主 variant / reasoningEffort 的纯函数判据 + 菜单文案） |
| `src/loop-guard.ts` | 循环「自动停止守卫」（检测到问题 / 网页搜索请求即停） |
| `src/proxy-switch.ts` | 「切节点锁定」：provider 网络错误时经 mihomo 外部控制接口锁定/解锁节点（含锁定生效确认、质量巡检与**外部手动锁定尊重**） |
| `src/tabular.ts` | TG 等宽表格 / 键值列表渲染（纯函数，状态与诊断消息对齐用） |
| `src/shell-promo.ts` | shell 结果晋升为后台任务卡的判据与文案 |
| `src/abort-classify.ts` | 中止原因分类（用户中止 / 超时 / 宿主错误）与遥测字段 |
| `src/inbound-silence.ts` | 入站静默判定（决定是否需要应答） |
| `src/turn-end-note.ts` | 轮末「AI 主动结束输出」短提示文案 |
| `src/bg-hint.ts` | shell 后台运行提示卡（新鲜度判据 + 文案） |
| `install.sh` | 一键安装：`REDACTED_ROOT` → `$HOME` 并铺到标准目录（可直接使用） |

## 使用方法

本仓库为**脱敏源码**，安装即用：

```bash
git clone https://github.com/Xiaobei09/opencode-bridge-plugin.git
cd opencode-bridge-plugin
bash install.sh
```

`install.sh` 会：模块（非 `*-v2.ts`）→ `~/.opencode/v2lib/` 与 `~/.config/opencode/v2lib/`（入口的相对 import 依赖后者）；两个入口 → `~/.config/opencode/plugins/`；并把路径占位符 `REDACTED_ROOT` 替换为本机 `$HOME`。装完重启 `opencode serve`（或 `touch ~/.config/opencode/plugins/tg-bridge-v2.ts` 触发热重载）生效。

- 依赖：opencode（V2 插件宿主）。
- Bot 配置：`~/.config/opencode/tg-bots.json`（每 Bot 一条：id + 各自的 token env 文件路径）；token 只放 env 文件，本仓库不含任何密钥。
- 测试：`bun test tests/`（需 [bun](https://bun.sh)；单测面向纯函数/判据，随源码快照）。

## 运行注意（R617）

- **网页搜索**：宿主 `websearch` 工具可能被取消（实测返回 `Web search cancelled`）；fallback 用 `webfetch https://lite.duckduckgo.com/lite/?q=<urlencoded>`，已实测 200/真实结果。桥本身不代理 websearch，不要把它当搜索 provider。
- **出站图片**：桥当前只有入站 `msg.photo` 分支，没有 `sendPhoto` / `sendDocument`；agent 生成的图不会自动发到 TG。若需要，显式文件发送是 backlog。
- **菜单/乱码**：文本截断走 UTF-16 安全路径；根菜单 4×2，回调完整性有 `tests/menu-root.test.ts`；`bun` 不在当前 CI PATH 时测试未执行（静态审计，不等于运行通过）。

## 脱敏声明

- 所有 Bot token / API key 均从环境变量读取，**源码不含任何密钥**（发布前已扫描 + 断言双保险）。
- 服务器内部路径已替换为 `REDACTED_ROOT/...`（源码中仅保留 `process.env.HOME ?? "/root"` 这类**通用 HOME 兜底字面量**；`install.sh` 完成占位还原）。
- 真实会话/消息 id 已替换为 `ses_sanitizedNN` / `msg_sanitizedNN` 占位（合成测试 id 保留）；部署细节不在本仓库出现。

## 版本控制

- 每次功能变更合入后，将脱敏副本同步提交到本仓库。
- Tag 规则：`v<日期>-<轮次>`（例：`v20260927-r1089`）。
