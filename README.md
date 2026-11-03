# purge-proxy-bridge · API 中转站桥

在 **DSH（DeepSeek Harness）** 与 **API 中转站**之间架一层本地 HTTP 代理：把请求顶层的 `system` 折叠进第一条 `user` 消息，再把 `system` 置空，让上游真正"看见"系统提示。左侧栏附带一个「中转站桥」面板，提供 **检测 / 启用 / 停止** 三个动作与实时转发统计。

> 搭配 [dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge) 使用：purge 负责把系统提示组装并注入进 DSH，本插件负责让这段系统提示穿过会丢弃它的中转。**详见[第 4 节](#4-与-dsh-purge-的关系必读)。**

- 版本：`2.1.0`
- 宿主：DSH `0.2.x`（在 `0.2.1-rc.5` 上开发并实测）
- 依赖：无。纯 ESM，只用 Node 内建模块（`node:http` / `node:https` / `node:net` / `node:fs` / `node:os` / `node:path`）
- 不含任何具体中转站的域名：上游地址由使用者在面板或配置里填

---

## 目录

1. [为什么会需要这个插件](#1-为什么会需要这个插件)
2. [它做了什么](#2-它做了什么)
3. [原理](#3-原理)
4. [与 dsh-purge 的关系（必读）](#4-与-dsh-purge-的关系必读)
5. [安装到 DSH](#5-安装到-dsh)
6. [使用](#6-使用)
7. [配置参考](#7-配置参考)
8. [本地 HTTP 接口](#8-本地-http-接口)
9. [故障排查](#9-故障排查)
10. [安全与隐私](#10-安全与隐私)
11. [开发与目录结构](#11-开发与目录结构)
12. [上传前检查](#12-上传前检查)
13. [许可](#13-许可)

---

## 1. 为什么会需要这个插件

DSH 发给模型的请求体里，系统提示是**独立字段**：Anthropic 协议是顶层 `system`，OpenAI 协议是 `messages[0]` 里的 `role: "system"`。

部分 API 中转站在转发时会**丢掉这个字段**，而且不报错：HTTP 200、回复正常，只是模型完全不知道你写了什么系统提示。

判断方法很直接 —— 看 `usage.input_tokens` 对 system 长度是否敏感。不敏感，说明这段文本在中转处就被丢弃了，既没进上下文也没进计费：

| 请求形态（同一把 key、同一端点、同一模型） | `usage.input_tokens` | 模型是否遵循 system |
| --- | --- | --- |
| 短 system（23 字） | **34** | 否 |
| 长 system（2000+ 字） | **34** | 否 |
| 完全不带 system | **34** | 否 |
| system 内容塞进第一条 user | **47** | **是** |

更麻烦的是这**不是全站行为，而是按模型路由不同**：

- 某些路由（如部分 DeepSeek 系列模型）丢 system；
- 同站点、同一把 key 的某些路由（如部分 Claude 系列模型）system 正常送达。

所以你不能简单地"换个 provider"了事，也不能靠"把提示写得更长"绕过 —— 只能把 `system` 换个位置送到模型面前。

一个直观的对照（system 指令是"回答只能是一个词：青竹"，插件前 / 插件后各发一次）：

```
插件前  input=34   →  "好的，请问你想了解什么？"          ← 完全没看到 system
插件后  input=47   →  "青竹"                              ← system 生效
```

---

## 2. 它做了什么

```
DSH 进程                                   本机                     公网
┌──────────────────┐   ① 请求     ┌────────────────────┐   ② 转发   ┌────────────┐
│ llm-pi-ai adapter│ ───────────▶ │ 127.0.0.1:8790     │ ─────────▶ │ API 中转站 │
│  params.system   │              │ 中转站桥：折叠     │            │            │
│  messages[...]   │ ◀─────────── │ system 后转发      │ ◀───────── │            │
└──────────────────┘   ④ SSE      └────────────────────┘   ③ SSE     └────────────┘
```

1. DSH 把 provider 的 `baseURL` 指向 `http://127.0.0.1:8790`（本插件的监听地址），而不是直接指向中转站。
2. 代理收到请求，**只在**"目标是 POST + body 是 JSON"时才改写：
   - 顶层 `system`（字符串或 block 数组）摊平成纯文本；
   - 插入到**第一条 `user` 消息**的 `content` 最前面（如果有前导 `tool_result` 块，插入点会跳过它们 —— Anthropic 要求 `tool_result` 必须排在 content 最前）；
   - `mode: "move"` 时删掉顶层 `system` 字段（`mode: "copy"` 保留，用于对照实验）。
3. 改好的请求转发给你配置的上游，响应以流的方式原样 pipe 回来 —— SSE 逐块透传，不缓冲、不改写、不打断。
4. 客户端断开时立即销毁上游连接，不留下悬挂的长连接。

同时保留一层 **fetch 兜底**：如果某个 provider 绕过代理直连 `targets` 里列出的主机，插件会在 `globalThis.fetch` 上做同样的改写。正常走代理时这层不会重复改写；`targets` 默认为空，即默认关闭。

---

## 3. 原理

### 3.1 DSH 的 system 是怎么进到请求体里的

```
dsh-system-prompt  组装 sections（含 purge 注入的内容）
        │
        ▼
dsh-llm-pi-ai  splitSystemPrompt()
   ├─ system 字段 + 所有 leading role="system" 消息 → 合并成 systemPrompt
   └─ messages 从第一条非 system 消息开始
        │
        ▼
pi-ai anthropic-messages
   params.system = [{ type: "text", text: <合并后的文本>, cache_control? }]
```

也就是说：**请求体本身是带 system 的**。链路上没有任何一方把它删掉 —— 是中转站在接收后丢弃。这也解释了为什么修法只能落在"出站请求体"这一层，改 DSH 内部任何一处都没用。

### 3.2 为什么是独立代理，而不是改宿主代码或改 purge

| 方案 | 问题 |
| --- | --- |
| 改 purge 插件 | purge 是别人的项目，混入传输层逻辑会让它无法跟着上游更新；且 purge 的一次 apply 会覆盖手工改动 |
| 改 `dsh-llm-pi-ai` | 属于宿主代码，升级即失效；`profileOptions()` 也不传自定义 `fetch` |
| 监听 `llm/stream` 事件改写 | LOOP 构造的 `options` 与 `options.messages` 都是 **deep-frozen**，只能读不能写 |
| 包装 `globalThis.fetch` | 可行，但 `dsh-experimental-inspector` 会在之后再包一层（`Object.defineProperty`），导致"到底谁在最外层"无法确定；且只对走 `fetch` 的客户端生效 |
| **本地 HTTP 代理 + `baseURL` 改指向** | 与 DSH 内部实现完全解耦；协议层透明；可独立启停、可检测、可观测 ← 采用 |

fetch 兜底仍然保留，但它只作为"漏网请求"的兜底，不再是主路径。

### 3.3 改写规则细节

**Anthropic（顶层 `system`）**

```jsonc
// 改写前
{
  "model": "...",
  "system": [{ "type": "text", "text": "回答只能是一个词：青竹", "cache_control": {...} }],
  "messages": [{ "role": "user", "content": "你好" }]
}

// 改写后（mode: "move"）
{
  "model": "...",
  "messages": [
    { "role": "user", "content": [
        { "type": "text", "text": "回答只能是一个词：青竹" },
        { "type": "text", "text": "你好" }
    ]}
  ]
}
```

- `system` 若为 block 数组，按顺序摊平，只保留**最后一个** `cache_control`（缓存断点跟着走）。
- 首条 `user` 的 `content` 是字符串时，转成 block 数组再插入。
- 首条 `user` 的 `content` 以 `tool_result` 开头时，插入点后移到 `tool_result` 之后。
- 不存在 `user` 消息时（极少见），补一条 `user` 承载 system 文本。
- 所有改写都在**深拷贝**上做，绝不修改宿主传入的冻结对象。

**OpenAI 协议（`messages[0]` 是 system/developer）**：把所有前导 `role: "system" | "developer"` 消息的文本合并，prepend 到第一条 `user` 前；`move` 模式删掉这些前导消息。

**不动的东西**：GET/HEAD 请求、非 JSON body、没有可折叠内容（改完与改前等价）的请求、Google 的 `systemInstruction` 形态。

### 3.4 失败即放行

代理和 fetch 兜底都在 `try/catch` 里，任何异常（JSON 解析失败、上游 DNS 失败、写响应时对端已断开）都只增加计数并原样放行请求。**这个插件永远不会成为你请求失败的原因** —— 唯一例外是它根本没有配置上游（此时会明确返回 `503 upstream not configured`）。

---

## 4. 与 dsh-purge 的关系（必读）

本插件只解决"**送达**"，不解决"**内容**"。系统提示是谁写的、写了什么、放在 system 的哪个位置 —— 那是 [dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge) 的职责。

| | [dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge) | 本插件 |
| --- | --- | --- |
| 层次 | 提示词装配 / 指令层级清洗 | 传输层请求体改写 |
| 动作 | 打补丁调整 system-prompt 组装顺序、注入 `~/.dsh/prompt-inject.md`、覆盖 section 顺序（如把 `dsh-breach*` 提到最前）、关闭 harness 身份前缀 | 把已经组装好的 `system` 折叠进首条 user，清空 `system` |
| 单独使用的后果 | system 组装正确，但中转站的某些路由收不到 → 白写 | 送达正常，但 system 里没有你的内容 → 送了个空 |

**所以两者是串联的**：

```
prompt-inject.md / purge 的 section 排序
        │  组装
        ▼
DSH system 字段  ──▶  中转站桥（折叠）  ──▶  API 中转站  ──▶  模型
```

建议安装顺序：**先装 purge（把 system 内容准备好），再装本插件（把它送出去）**。只装本插件也能工作，但 system 里只有 DSH 默认内容。

如果你的 purge 版本会输出 **leading system 消息**（而不是请求级 `system` 字段），本插件同样处理 —— `splitSystemPrompt` 之后两者都会变成同一个顶层 `system`，代理看到的是同一种形态。

---

## 5. 安装到 DSH

### 5.1 前置条件

- DSH 桌面版 `0.2.x`
- Node.js ≥ 20（仅用于跑自检；插件本身跟着 DSH 进程跑）
- 已安装 [dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge)（推荐）

插件通过 DSH 的 **profile bundle** 机制加载：`~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里列上包名，包自身声明 `dsh.bundle.patch` 指到一个 cordis patch 文件。本仓库的 `package.json` 已经写好了这两处。

### 5.2 步骤（Windows）

假设 profile 是默认的 `desktop`。

```powershell
# 1) 把仓库放到插件目录（目录不存在就先建）
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\plugins" | Out-Null
cd $env:USERPROFILE\.dsh\plugins
git clone https://github.com/<you>/dsh-api-relay-bridge.git

# 2) 让 profile 能解析到这个包（Junction）
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-api-relay-bridge" `
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-api-relay-bridge"
```

然后编辑 `C:\Users\<you>\.dsh\profiles\desktop\package.json`：

```jsonc
{
  "dependencies": {
    // ……原有依赖……
    "dsh-api-relay-bridge": "file:../../plugins/dsh-api-relay-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ……原有 bundle……
        "dsh-api-relay-bridge"
      ]
    }
  }
}
```

### 5.3 步骤（macOS / Linux）

```bash
cd ~/.dsh/plugins
git clone https://github.com/<you>/dsh-api-relay-bridge.git
ln -s ~/.dsh/plugins/dsh-api-relay-bridge \
      ~/.dsh/profiles/desktop/node_modules/dsh-api-relay-bridge
```

`package.json` 的改动同上。

> 也可以跳过软链，直接把 `dependencies` 写成 `"dsh-api-relay-bridge": "github:<you>/dsh-api-relay-bridge"`，由 DSH 的包管理器安装。两种方式加载效果相同；软链的好处是改代码后重启即生效，不用重装。

### 5.4 填上游地址

上游地址**不写进仓库**，安装后填一次即可。两种方式，二选一：

**A. 面板里填**（推荐）

重启 DSH → 左侧栏「中转站桥」→「监听设置」里填 `https://你的中转站域名` → 保存。写入 `~/.dsh/api-relay-bridge/config.json`。

**B. 配置文件里填**

```json
{
  "enabled": true,
  "mode": "move",
  "port": 8790,
  "upstream": "https://你的中转站域名",
  "targets": [],
  "audit": true,
  "verbose": false
}
```

保存到 `~/.dsh/api-relay-bridge/config.json`（`DSH_HOME` 不是 `~/.dsh` 时按实际目录），然后重启 DSH。

也可以在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: dsh-api-relay-bridge
  config:
    upstream: https://你的中转站域名
```

### 5.5 把 provider 的 baseURL 指向代理

编辑 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/desktop/cordis.patch.yml`），把你用到的 provider 的 `baseURL` 从中转站直连改成代理：

```yaml
- id: llm-pi-ai
  config:
    providers:
      v:
        displayName: DeepSeek V4.1 Flash
        api: anthropic-messages
        apiKeyEnv: V_API_KEY
        baseURL: http://127.0.0.1:8790      # ← 原来是中转站直连地址
        models:
          - id: DeepSeek-V4.1-Flash
            name: DeepSeek-V4.1-Flash
            input: [text]
            reasoningEfforts:
              off: null
              max: max
```

`examples/cordis.patch.yml` 里有一份可直接抄的片段。

> 想先验证再切换？先不改 baseURL，只开代理（上游填对即可），用第 8 节的 `/__proxy/selftest` 确认改写逻辑正常，再切 provider。

### 5.6 重启 DSH

bundle 列表只在启动时读取，**没有文件监听** —— 改完必须完全退出并重新打开 DSH 桌面应用（不是刷新页面）。重启后左侧栏应出现「中转站桥」。

---

## 6. 使用

### 6.1 面板

左侧栏点「中转站桥」：

- **顶部徽标**：`代理运行中` / `代理运行中 · 检测异常` / `代理已停止`
- **三个按钮**
  - **检测**：跑三行自检 —— 端口在听、上游可达、改写管线正常（不发真实模型请求，也不消耗额度）
  - **启用**：拉起监听（端口被占用时会在"最近错误"里说明）
  - **停止**：关掉监听并把状态写盘；此时 provider 指向 8790 会连不上，记得一起处理
- **代理状态卡**：监听地址、上游、改写方式、最近错误
- **检测结果卡**：三行 `通过 / 失败` + 明细
- **转发统计**：转发请求 / 改写次数 / 转发错误（可清空）
- **监听设置**：端口、上游输入框 + 保存（改端口或上游会自动重启代理）
- **最近改写记录**：最近 30 条，含时间、主机、system 字符数、改写方式、通道（`proxy` / `fetch`）

面板每 2 秒轮询一次状态；正在编辑输入框时不会被打断。

### 6.2 推荐自检流程

1. 面板 → **检测** → 三行全绿。
2. 面板 → **转发统计** 应保持 0（检测不产生转发）。
3. 在对话里发一句话，观察 **转发请求** 与 **改写次数** 同时 +1 —— 说明请求确实走了代理且被改写。
4. 如果你在 system 里放了可判别的指令（例如"回答只能是一个词：青竹"），模型应当直接照做。

### 6.3 命令行

```bash
# 代理状态（含 listening / port / stats / 最近错误）
curl -s http://127.0.0.1:<DSH_WEB_PORT>/relay-bridge/status | jq .proxy

# 只测改写管线（不打真实上游）
curl -s http://127.0.0.1:8790/__proxy/selftest | jq .

# 启停
curl -s -X POST http://127.0.0.1:<DSH_WEB_PORT>/relay-bridge/proxy -d '{"action":"check"}'
curl -s -X POST http://127.0.0.1:<DSH_WEB_PORT>/relay-bridge/proxy -d '{"action":"stop"}'
curl -s -X POST http://127.0.0.1:<DSH_WEB_PORT>/relay-bridge/proxy -d '{"action":"start"}'
```

`8790` 是代理端口；`<DSH_WEB_PORT>` 是 DSH 自己的 Web 端口（每次启动可能不同，从地址栏取）。面板用的就是这些接口，所以也可脚本化。

### 6.4 卸载

1. 面板 → **停止**
2. 从 `package.json` 的 `dsh.profile.bundles` 与 `dependencies` 里删掉 `dsh-api-relay-bridge`
3. 删除 `node_modules` 下的 Junction / symlink 与插件目录
4. 把 provider 的 `baseURL` 改回中转站地址
5. 可选：删掉 `~/.dsh/api-relay-bridge/`（配置与审计）
6. 重启 DSH

---

## 7. 配置参考

配置来源按优先级从低到高：

1. 本仓库 `cordis.patch.yml`（bundle 默认值）
2. profile 的 `cordis.patch.yml` 里 `- id: dsh-api-relay-bridge` / `config:` 覆盖层
3. 面板保存的运行时覆盖：`~/.dsh/api-relay-bridge/config.json`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 启动时是否自动拉起代理（上游为空时会跳过启动并提示）。面板「启用/停止」会写回 `config.json` |
| `mode` | `"move"` | `move` = 折叠后删除顶层 `system`；`copy` = 保留（对照实验用，会让上游收到两份提示） |
| `port` | `8790` | 监听端口，范围 1024–65535。provider 的 `baseURL` 必须与之一致 |
| `upstream` | `""` | 上游基址，如 `https://your-relay.example.com`。**必填**，为空时代理不启动、转发返回 503 |
| `targets` | `[]` | 需要改写的主机（等值或子域匹配）。只影响 fetch 兜底，默认不启用 |
| `audit` | `true` | 是否把改写元数据写进审计文件 |
| `auditPath` | `~/.dsh/api-relay-bridge/audit.jsonl` | 审计文件路径 |
| `verbose` | `false` | 打开后每次改写打一条 `info` 日志 |

审计内容是**元数据**，不含请求正文：

```json
{"at":"2026-11-03T14:13:02.113Z","via":"proxy","host":"relay.example.com","path":"/v1/messages","mode":"move","systemChars":4213,"firstUserChars":18}
```

---

## 8. 本地 HTTP 接口

面板用的就是这几个（同源、无需鉴权，因为只监听在回环地址）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/relay-bridge/status` | 完整状态：`plugin` / `version` / `proxy` / `check` / `fallback` / `recent` |
| `POST` | `/relay-bridge/proxy` | `{"action":"start"\|"stop"\|"check"}` |
| `POST` | `/relay-bridge/config` | 局部更新配置，如 `{"port":8791}` 或 `{"upstream":"https://..."}`；改端口/上游会重启代理 |
| `POST` | `/relay-bridge/reset` | 清零统计与最近记录 |

代理自身的两个内部端点（直接打到代理端口，不会转发出去）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/__proxy/status` | `{listening, port, upstream, mode, stats, lastError}` |
| `GET` | `/__proxy/selftest` | 在代理进程内跑一条样例请求，返回 `{ok, systemRemoved, systemChars, firstUserChars, mode}` |

**除这两个前缀外，代理端口上的任何请求都会被转发到 `upstream`。**

---

## 9. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 左侧栏没有「中转站桥」 | bundle 没加载。检查 profile `package.json` 的 `dsh.profile.bundles` 是否含包名、`node_modules` 下链接是否有效，然后**完全重启** DSH。启动日志里的 `skippedBundles` 会写明失败原因 |
| 面板显示「代理已停止」，提示未配置上游 | 去「监听设置」填上游地址并保存，再点「启用」 |
| 对话报 `503 upstream not configured` | 同上：`upstream` 为空 |
| 面板显示「代理已停止」，对话报连接错误 | provider 的 `baseURL` 指向 8790 但代理没起来。点「启用」，或把 `enabled` 设回 `true` 后重启 |
| 启用时报 `EADDRINUSE` | 8790 被占。面板「监听设置」换端口，同时改 provider `baseURL` |
| 检测第一行失败、第二三行跳过 | 端口没在听（代理未启动或刚崩溃），先「启用」再「检测」 |
| 检测第二行失败 | 上游不可达（网络 / 代理 / DNS）。代理仍会尝试转发，但请求会失败 |
| 转发统计在涨、改写次数为 0 | 请求体里没有可折叠的 `system`（provider 可能用了别的协议）。用 `verbose: true` 看日志 |
| `fallback.installed` 为 `false` | fetch 兜底不在最外层（`dsh-experimental-inspector` 会再包一层）。**不影响代理路径**，可忽略；`targets` 为空时它本就不启用 |
| 模型还是不听 system | 先确认 `systemChars` 是否 > 0（面板或审计文件）；为 0 说明 system 里本来就没内容 —— 那是 purge / 提示词侧的问题，见第 4 节 |
| 长回复被截断 | 上游超时是 600s；如果确实超过，改代理改用例或缩短输出 |
| 用了 `mode: "copy"` 后模型行为怪异 | `copy` 会把提示送两遍（顶层 `system` + user 里各一份），仅供对照。改回 `move` |

---

## 10. 安全与隐私

- 代理**只监听 `127.0.0.1`**，不对外暴露；不校验来源，因为同机任何进程本来就能读到你的 key。
- 不改写、不记录请求正文。审计文件只写主机、路径、字符数这类元数据。
- `x-api-key` / `authorization` 等头**原样透传**，插件不解析、不落盘、不打印。
- 唯一的出站目标是你配置的 `upstream`；`targets` 只决定 fetch 兜底是否改写，不会新增外连。
- 代理是透明转发：它不重试、不缓存、不重排响应，也不改变状态码与响应头（除了按 body 长度重设 `content-length`）。
- 仓库里没有任何具体中转站的域名或凭据 —— 上游地址只存在于你自己的 `~/.dsh/api-relay-bridge/config.json`。

---

## 11. 开发与目录结构

```
dsh-api-relay-bridge/
├── index.js            # 宿主半边：代理、改写、路由、配置（约 1270 行，无依赖）
├── client.js           # 客户端半边：左侧栏面板（window.__ModuleLoader__.load 形态）
├── cordis.patch.yml    # bundle patch：把插件插进 cordis 树，带默认 config
├── package.json        # dsh.bundle.patch + dsh.client 声明
├── docs/
│   └── architecture.md # 更细的机制说明：改写边界、流式转发、失败模式
└── examples/
    └── cordis.patch.yml # provider baseURL 指向代理的示例片段
```

两个半边：

- **宿主半边**（`index.js`）导出 `apply(ctx, config)`、`name`、`version`、`inject = []`，另导出 `rewriteRequestBody(text, mode)` 供自检直接调用。它用 `ctx.effect` 注册监听与路由，插件卸载时自动停代理、清路由、恢复 fetch。
- **客户端半边**（`client.js`）用 `window.__ModuleLoader__.load({ id, factory })`，`factory` 返回 `{ name, inject: ["slots"], apply(ctx) }`，在 `sidebar.panellist` 与 `main` 两个插槽各注册一次，`id`/`key` 都是 `api-relay-bridge`。

语法检查：

```bash
node --check index.js && node --check client.js
```

自检（不依赖测试框架）：

```bash
# 改写逻辑本身
node -e "import('./index.js').then(m=>{
  const body = JSON.stringify({system:'SYS',messages:[{role:'user',content:'HI'}]});
  console.log(JSON.parse(m.rewriteRequestBody(body,'move')));
})"
```

> 版本兼容：`package.json` **刻意不写** `engines` / `peerDependencies` —— DSH 的 `evaluatePluginCompatibility` 会据此判定插件是否兼容，写了反而需要 `compatibility.json` 精确豁免。

---

## 12. 上传前检查

这份目录已经可以直接 `git init` 上传。上传前把下面几处占位符换成你自己的：

1. README 第 5.2 / 5.3 节里的 `<you>` —— 换成你的 GitHub 用户名（决定 `git clone` 的地址）。
2. `package.json` 可选补三个字段：
   ```json
   "repository": { "type": "git", "url": "https://github.com/<you>/dsh-api-relay-bridge.git" },
   "homepage": "https://github.com/<you>/dsh-api-relay-bridge#readme",
   "author": "<you>"
   ```
3. 想打 tag 的话：

```bash
git init
git add .
git commit -m "feat: API 中转站桥 v2.1.0 —— 本地代理把 system 折叠进首条 user"
git tag v2.1.0
git remote add origin https://github.com/<you>/dsh-api-relay-bridge.git
git push -u origin main --tags
```

Release 说明可以直接从 [`CHANGELOG.md`](./CHANGELOG.md) 的 `2.1.0` 段复制。

> 想让别人能在 DSH 插件市场里一键装：往你的市场 `index.json` 里加一条指向本仓库的条目即可；不发布也不影响手动安装。

## 13. 许可

MIT，见 [LICENSE](./LICENSE)。
