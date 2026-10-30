# OpenCode Bridge Plugin (sanitized)

TG↔Opencode 桥接插件源码（脱敏发布版），版本受控。

## 组成

| 文件 | 说明 |
|---|---|
| `src/tg-bridge.ts` | 桥主逻辑：长轮询、注入、发送、看门狗、队列卡、proto 镜像 |
| `src/auto-continue.ts` | 自动循环：evaluate/注入闸/租约/熔断；`exit-proxy` 全局 2 连错策略 |
| `src/tg-bridge-v2.ts` | 插件装载入口（bot 配置与 env 读取） |
| `src/auto-continue-v2.ts` | 自动循环装载入口（V1 插件经 _v2compat 包成 V2） |
| `src/_v2compat.ts` | 兼容层 |
| `src/bg-mode.ts` | 「转后台」能力：原生后台子代理的提升（promote）与整体自动配置 |
| `src/bg-watch.ts` | 插件层「shell 跑超 N 秒强制转后台」的合规实现 |
| `src/compact-notice.ts` | 「上下文已压缩」通知的文案判据（纯函数） |
| `src/think-depth.ts` | 「思考深度」选择（宿主 variant / reasoningEffort 的纯函数判据 + 菜单文案） |
| `src/loop-guard.ts` | 循环「自动停止守卫」（检测到问题 / 网页搜索请求即停） |
| `src/exit-proxy.ts` | 本轮出口代理状态（direct/relay 汇总，只读；换轮由 CI 的 egress 选择器负责） |
| `src/tabular.ts` | TG 等宽表格 / 键值列表渲染（纯函数，状态与诊断消息对齐用） |
| `src/shell-promo.ts` | shell 结果晋升为后台任务卡的判据与文案 |
| `src/abort-classify.ts` | 中止原因分类（用户中止 / 超时 / 宿主错误）与遥测字段 |
| `src/inbound-silence.ts` | 入站静默判定（决定是否需要应答） |
| `src/turn-end-note.ts` | 轮末「AI 主动结束输出」短提示文案 |
| `src/bg-hint.ts` | shell 后台运行提示卡（新鲜度判据 + 文案） |
| `install.sh` | 一键安装：`REDACTED_ROOT` → `$HOME` 并铺到标准目录（可直接使用） |
| `add-bots.sh` | 批量/幂等注册多个 bot：一次校验并合并 JSON，不改桥代码 |

## 使用方法

本仓库为**脱敏源码**，安装即用：

```bash
git clone https://github.com/Xiaobei09/opencode-bridge-plugin.git
cd opencode-bridge-plugin
bash install.sh
```

`install.sh` 会：模块（非 `*-v2.ts`）→ `~/.opencode/v2lib/` 与 `~/.config/opencode/v2lib/`（入口的相对 import 依赖后者）；两个入口 → `~/.config/opencode/plugins/`；并把路径占位符 `REDACTED_ROOT` 替换为本机 `$HOME`。装完重启 `opencode serve`（或 `touch ~/.config/opencode/plugins/tg-bridge-v2.ts` 触发热重载）生效。

- 依赖：opencode（V2 插件宿主）。
- Bot 配置：`~/.config/opencode/tg-bots.json`（每 Bot 一条：稳定内部 `id` + token env 文件路径；用户可见名用 `label`，推荐直接写 `@username`）；token 只放 env 文件，本仓库不含任何密钥。
- **批量接入多个 Bot（不需要改代码）**：`tg-bridge-v2.ts` 的 `readRegistry()` 会动态读取 `bots[]`，`setup()` 对每个条目建立实例，没有 3 个上限。先为每个 bot 准备 env 文件（含非空 `TG_BOT_TOKEN`），再一次性提交一个 JSON：
  ```bash
  cp examples/tg-bots.batch.example.json /tmp/new-bots.json
  # 可放任意 N 条；username 可直接代替 id，label 会自动成为 @username
  bash add-bots.sh --file /tmp/new-bots.json --dry-run
  bash add-bots.sh --file /tmp/new-bots.json --reload
  ```
  `add-bots.sh` 会校验 id/username/env/token、按 id 幂等 upsert、原子写入 `tg-bots.json`（mode 600），输出只显示 `token=set(len=N)`，不打印 token；`--reload` 只 touch 插件入口触发重载。`id` 用小写字母/数字/`_`/`-`，env 路径支持 `~`。`username` 缺省时用 `id` 生成内部 id，`label` 自动为 `@username`。
  输入条目也可以直接给 `token`（脚本会写 `~/.config/opencode/tg-bot<id>.env`，mode 600）：
  ```json
  {"bots":[{"id":"bot8","token":"123456:ABC…","label":"@my_bot8"}]}
  ```
- **三种免改代码的接入口**（任选其一，可混用）：
  1. TG 里发 `/addbots <token1> <token2> …`：一条消息批量登记，逐个回执；token 会自动从聊天里删除（仍建议随后 revoke 旧的）。
  2. CI secret `TG_BOTS_EXTRA`：JSON 数组（`[{"id","token","label"...}]`），每次启动自动落盘并合并注册表。
  3. 直接放 `~/.config/opencode/tg-bot<id>.env`：入口的 `readRegistry()` 自动发现，无需注册表。
- **同一个 token 只能有一个轮询者**：`/addbot`、`add-bots.sh`、restore 与入口 `readRegistry()` 都会按 token 去重；重复 token 会被拒绝/停用并记 `duplicate token`，否则两个实例抢 `getUpdates`（409），后一个 Bot 永远收不到消息。
- **显示名**：桥的菜单、循环命令回执和循环状态卡统一用 `label`（`@username`）；内部状态文件/租约仍用稳定 `id`，因此改名不会丢会话绑定。循环状态卡显示当前会话、**会话状态**、推送状态、外发队列和注入队列；卡片每 60s 自动刷新并显示刷新时间，token 无效被跳过的 Bot 会以「离线」标注，不再整轮停在旧值。
- **AI 改标题**：循环页与置顶循环状态卡提供「✍️ AI 改标题」按钮。桥调用宿主 `POST /api/session/{id}/generate` 根据当前会话上下文生成标题，再用 `PATCH /api/session/{id}` 落库；自动保留 `[LOOP]` / `[LOOP:OFF]` 循环标记，模型返回的引号/Markdown/解释行会被清洗。
- 测试：`bun test tests/`（需 [bun](https://bun.sh)；单测面向纯函数/判据，随源码快照）。当前 **204 tests 全 PASS**（含 AI 标题清洗、菜单按钮与 completed-dead 回归）。

## 运行注意（R617）

- **网页搜索**：宿主 `websearch` 工具**可能可用也可能被取消**（R619 曾实测 `Web search cancelled`；R2517/2026-10-30 实测可用并返回真实结果）。被取消时 fallback 用 `webfetch https://www.bing.com/search?q=<urlencoded>`；`lite.duckduckgo.com` 可能返回 202 challenge，不能作为唯一 fallback。桥本身不代理 websearch，不要把它当搜索 provider。
- **出站图片**：桥当前只有入站 `msg.photo` 分支，没有 `sendPhoto` / `sendDocument`；agent 生成的图不会自动发到 TG。若需要，显式文件发送是 backlog。
- **菜单/乱码**：文本截断走 UTF-16 安全路径；根菜单 4×2，sys 页 9×2+返回（R619 移除与“我是谁”重叠的“属主记录”菜单按钮，`/owner` 命令仍保留）；回调完整性有 `tests/menu-root.test.ts`；R623 用 bun 1.4.3 跑 **194 tests 全 PASS**（新增 r2236 completed dead-turn 回归 2 条）。
- **R619 脱敏修复**：`src/tg-bridge.ts` 的 inject-card 路径和 `src/tg-bridge-v2.ts` 的 `tg-chats${sfx}` 状态路径曾因脱敏把反引号改成双引号，导致语法错误/字面量路径；已修为模板字面量，并新增 `tests/sanitized-template.test.ts`。

## 脱敏声明

- 所有 Bot token / API key 均从环境变量读取，**源码不含任何密钥**（发布前已扫描 + 断言双保险）。
- 服务器内部路径已替换为 `REDACTED_ROOT/...`（源码中仅保留 `process.env.HOME ?? "/root"` 这类**通用 HOME 兜底字面量**；`install.sh` 完成占位还原）。
- 真实会话/消息 id 已替换为 `ses_sanitizedNN` / `msg_sanitizedNN` 占位（合成测试 id 保留）；部署细节不在本仓库出现。

## 版本控制

- 每次功能变更合入后，将脱敏副本同步提交到本仓库。
- Tag 规则：`v<日期>-<轮次>`（例：`v20260927-r1089`）。
