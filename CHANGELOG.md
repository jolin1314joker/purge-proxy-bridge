# Changelog

## 2.2.0

多上游：一次覆盖，按模型分流。DSH 的 provider 只能持有一个 baseURL，所以「不同模型走不同中转站」只能在代理侧完成。

- **新增**：**覆盖 / 还原** 两个动作。覆盖用 `configEditor.edit` 把每个 provider 的 `baseURL` 改成 `http://127.0.0.1:8790`，同时写入内部路由头 `headers["x-relay-route"] = <providerId>`；覆盖前记录原始地址，还原时写回并删掉路由头。覆盖后若代理未在监听会顺手拉起，避免 baseURL 指过来却全线 `ECONNREFUSED`。
- **新增**：**模型 · 上游对照表**（面板下方，按 provider 分组）。每个模型一行：模型 id、当前生效的上游地址（输入框可直接改，Enter 保存 / Esc 取消）、删除按钮（二次确认）；组头显示 displayName、provider id、api 协议、`baseURL 已指向代理` 标记与当前 baseURL。DSH 里已经没有的模型标 `DSH 已无`，映射表里没有的标 `未记录`。
- **新增**：**上游解析链**：路由头 → 路径前缀 `/<provider>/…` → 请求体 `model` 名（同名模型用 API 协议消歧）→ 默认上游兜底。全部落空返回 `503 upstream not configured`。路由头不转发给上游。
- **新增**：`/relay-bridge/models` 路由，动作 `set-upstream` / `delete-model` / `refresh`；`/relay-bridge/proxy` 增加 `cover` / `uncover`（可带 `providers: []` 只处理指定 provider）。
- **新增**：删除模型会同步从 profile 的 `llm-pi-ai.providers` 里移除；删掉某 provider 的最后一个模型时整条 provider 一并删除，并检查是否有 entry（如 `agent-default-model`）还指着它，是则返回 `warning`。
- **变更**：检测从 3 项变 4 项，新增 **baseURL 覆盖**：发现哪个 provider 的 baseURL 不是本代理就自动改写回去，并在详情里列出被改的 provider id。
- **变更**：`upstream` 从「唯一上游」降为「默认上游（兜底）」；改端口才重启代理，改上游不再重启。
- **修复**：`providers` 在 live 配置里是 schemastery 的 volatile 包装且被冻结，写回时现在先深拷贝成纯对象（此前覆盖会抛 `Cannot assign to read only property`）。
- **修复**：`normalizeUpstream` 不再吞掉上游地址里的路径前缀（`https://host/v1` 会保留 `/v1` 并按前缀拼接转发路径）。

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
