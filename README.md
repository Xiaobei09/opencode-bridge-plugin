# OpenCode Bridge Plugin (sanitized)

TG↔Opencode 桥接插件源码（脱敏发布版），版本受控。

## 组成

| 文件 | 说明 |
|---|---|
| `src/tg-bridge.ts` | 桥主逻辑：长轮询、注入、发送、看门狗、队列卡、proto 镜像 |
| `src/auto-continue.ts` | 自动循环：evaluate/注入闸/租约/熔断 |
| `src/tg-bridge-v2.ts` | 插件装载入口（bot 配置与 env 读取） |
| `src/_v2compat.ts` | 兼容层 |

## 脱敏声明

- 所有 Bot token / API key 均从环境变量读取，**源码不含任何密钥**（发布前已扫描 + 断言双保险）。
- 服务器内部路径 `/root/...` 已替换为 `REDACTED_ROOT/...`。
- 会话/消息内部 id、部署细节均不在本仓库出现。

## 版本控制

- 每次功能变更合入后，将脱敏副本同步提交到本仓库。
- Tag 规则：`v<日期>-<轮次>`（例：`v20260927-r1089`）。