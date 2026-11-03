# Changelog

## 2.1.0

去具体化，变成一个可以公开的通用工具。

- **改名**：包名与插件 id 统一为 `dsh-api-relay-bridge`，展示名「API 中转站桥」，侧栏标签「中转站桥」（旧包名不再提供）。
- **移除**：代码、配置、文档里所有具体中转站的域名与名称；`upstream` 默认改为空字符串，由使用者在面板或配置里填。
- **移除**：`targets` 的默认值（原为某个固定域名），现默认 `[]`，即 fetch 兜底默认关闭。
- **变更**：面板路由统一为 `/relay-bridge/*`；状态目录改到 `~/.dsh/api-relay-bridge/`；探测哨兵主机同步改名。
- **新增**：上游未配置时的明确行为 —— 不自动监听、转发返回 `503 upstream not configured`、检测第二行显示"未配置上游地址"。

## 2.0.0

真正的本地 HTTP 代理，不再是 fetch 包装。

- **新增**：`http.createServer` 监听 `127.0.0.1:8790`，把请求体里的顶层 `system` 折叠进首条 `user` 后转发到上游；SSE 逐块 pipe，不缓冲。
- **新增**：面板改名「代理桥」，增加 **检测 / 启用 / 停止** 三个动作，以及代理状态、检测结果、转发统计、监听设置、最近改写记录五张卡片。
- **新增**：`/__proxy/status`、`/__proxy/selftest` 两个代理内部端点；面板四条路由 `status / proxy / config / reset`。
- **新增**：`runCheck()` 三段式自检（端口在听 → 上游可达 → 改写管线正常），不消耗模型额度。
- **新增**：配置项 `port` / `upstream`；面板保存的覆盖写入 `~/.dsh/<plugin>/config.json`。
- **保留**：`globalThis.fetch` 兜底改写（只对命中 `targets` 且绕过代理的请求生效），以及脱链/被包裹状态探测。
- **变更**：`enabled` 不再阻止安装，只门控监听。

## 1.1.1

- **修复**：`installed` 徽标在 `dsh-experimental-inspector` 二次包装 `globalThis.fetch` 后误报为 `false`。改为哨兵探测（`PROBE_URL` + 30s 缓存），状态分 `top` / `shadowed` / `detached` / `missing` 四态。
- **变更**：面板徽标文案由 position 驱动，并增加悬停说明。

## 1.1.0

- **新增**：客户端半边，左侧栏面板 + `main` 面板页；2s 轮询状态，开关拨杆、统计磁贴、目标主机编辑、最近改写记录。
- **新增**：`enabled` 可在运行时切换（包装器内门控，不再需要重启）。
- **新增**：运行时覆盖持久化。
- **新增**：三条面板路由 `GET .../status`、`POST .../config`、`POST .../reset`。

## 1.0.0

首个可用版本：包装 `globalThis.fetch`，把 Anthropic 顶层 `system` 折叠进首条 `user`（跳过前导 `tool_result`，保留最后一个 `cache_control`），并支持 OpenAI 的 leading `system` / `developer` 消息；改写失败一律原样放行。

实测（同一把 key、同一模型路由）：插件前 `input_tokens=34` 且 system 无效；插件后 `input_tokens=47` 且 system 生效。

## 0.x

内部原型：确认 `dsh-llm-pi-ai` 的 `splitSystemPrompt()` 确实把 system 写进请求体，问题出在中转侧丢弃，而非 DSH 组装。
