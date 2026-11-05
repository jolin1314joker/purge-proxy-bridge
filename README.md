# purge-proxy-bridge · API 中转站桥

在 **DSH（DeepSeek Harness）** 与 **API 中转站**之间架一层本地 HTTP 代理：把请求顶层的 `system` 折叠进第一条 `user` 消息，再把 `system` 置空，让上游真正"看见"系统提示。左侧栏附带一个「中转站桥」面板，提供 **检测 / 覆盖 / 还原 / 启用 / 停止** 动作、实时转发统计，以及一张**模型 · 上游对照表**（多 provider、多中转站时按模型自动分流）。

> 搭配 [dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge) 使用：purge 负责把系统提示组装并注入进 DSH，本插件负责让这段系统提示穿过会丢弃它的中转。**详见[第 4 节](#4-与-dsh-purge-的关系必读)。**

- 版本：`2.2.0`
- 宿主：DSH `0.2.x`（在 `0.2.1-rc.5` 上开发并实测）
- 依赖：无。纯 ESM，只用 Node 内建模块（`node:http` / `node:https` / `node:net` / `node:fs` / `node:os` / `node:path`）
- 不含任何具体中转站的域名：上游地址由使用者在面板或配置里填

---

## 目录

0. [快速开始](#0-快速开始)
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

## 0. 快速开始

### 0.1 2.2.0 有什么新的

| | 2.1.0 | 2.2.0 |
| --- | --- | --- |
| 改 baseURL | 手改 `cordis.patch.yml` | 面板点 **覆盖**，一键全改，点 **还原** 复原 |
| 上游数量 | 全体共用一个 | 每个模型一个，按 **路由头 / 路径前缀 / 模型名** 自动分流 |
| 面板 | 状态 + 三项自检 | 多一张 **模型 · 上游对照表**（改地址、删模型，删除同步 DSH 设置） |
| 检测 | 三项 | 四项，新增 **baseURL 覆盖**（不合格会自动改回来） |

细节见 [`CHANGELOG.md`](./CHANGELOG.md) 的 `2.2.0` 段。

### 0.2 最短安装路径

```powershell
# 1) 克隆到插件目录（目录不存在就先建）
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.dsh\plugins" | Out-Null
cd $env:USERPROFILE\.dsh\plugins
git clone https://github.com/<you>/purge-proxy-bridge.git dsh-api-relay-bridge

# 2) 让 profile 能解析到它
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-api-relay-bridge" `
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-api-relay-bridge"
```

然后在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里加一行 `"dsh-api-relay-bridge"`，完全重启 DSH，左侧栏点「中转站桥」→ **覆盖** → 在对照表里逐模型填上游。详细步骤见[第 5 节](#5-安装到-dsh)。

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
│  params.system   │              │ 中转站桥：选上游 + │            │  A / B / C │
│  messages[...]   │ ◀─────────── │ 折叠 system 后转发 │ ◀───────── │            │
└──────────────────┘   ④ SSE      └────────────────────┘   ③ SSE     └────────────┘
```

1. DSH 把**所有** provider 的 `baseURL` 指向 `http://127.0.0.1:8790`（本插件的监听地址），而不是直接指向各个中转站 —— 面板上的「覆盖」按钮一步完成。
2. 代理收到请求，先**选上游**：路由头 `x-relay-route` → 路径前缀 `/<provider>/…` → 请求体 `model` 名 → 默认上游兜底。于是 provider `relay-a` 下的 `DeepSeek-V4.1-Flash` 走 A 站，provider `relay-b` 下的 `gpt-6-astra` 走 B 站，即使两边模型同名也互不干扰。
3. 然后**只在**"目标是 POST + body 是 JSON"时才改写：
   - 顶层 `system`（字符串或 block 数组）摊平成纯文本；
   - 插入到**第一条 `user` 消息**的 `content` 最前面（如果有前导 `tool_result` 块，插入点会跳过它们 —— Anthropic 要求 `tool_result` 必须排在 content 最前）；
   - `mode: "move"` 时删掉顶层 `system` 字段（`mode: "copy"` 保留，用于对照实验）。
4. 改好的请求转发到选中的上游，响应以流的方式原样 pipe 回来 —— SSE 逐块透传，不缓冲、不改写、不打断。
5. 客户端断开时立即销毁上游连接，不留下悬挂的长连接。

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
git clone https://github.com/<you>/purge-proxy-bridge.git dsh-api-relay-bridge

# 2) 让 profile 能解析到这个包（Junction）
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-api-relay-bridge" `
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-api-relay-bridge"
```

然后编辑 `C:\Users\<你的 Windows 用户名>\.dsh\profiles\desktop\package.json`：

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
git clone https://github.com/<you>/purge-proxy-bridge.git dsh-api-relay-bridge
ln -s ~/.dsh/plugins/dsh-api-relay-bridge \
      ~/.dsh/profiles/desktop/node_modules/dsh-api-relay-bridge
```

`package.json` 的改动同上。

> 也可以跳过软链，直接把 `dependencies` 写成 `"dsh-api-relay-bridge": "github:<you>/purge-proxy-bridge"`，由 DSH 的包管理器安装。两种方式加载效果相同；软链的好处是改代码后重启即生效，不用重装。

### 5.4 填上游地址

上游地址**不写进仓库**，安装后填一次即可。两种方式，二选一：

**A. 面板里填**（推荐）

重启 DSH → 左侧栏「中转站桥」→「监听设置」里填默认上游 → 保存；再到下面的「模型 · 上游对照表」里，把每个模型要走的站填上。写入 `~/.dsh/api-relay-bridge/config.json` 与 `routing.json`。

**B. 配置文件里填**

```json
{
  "enabled": true,
  "mode": "move",
  "port": 8790,
  "upstream": "https://你的默认中转站域名",
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
    upstream: https://你的默认中转站域名
```

### 5.5 把 provider 的 baseURL 指向代理

面板上点 **覆盖** 就行：插件会用 DSH 的 `configEditor` 把你所有 provider 的 `baseURL` 改成 `http://127.0.0.1:8790`，同时给每个 provider 写一个内部路由头 `headers["x-relay-route"] = <providerId>`，并把原始地址记进 `~/.dsh/api-relay-bridge/routing.json`。点 **还原** 会写回原始地址并清掉路由头。

> 路由头是关键：DSH 的 provider 只能有一个 `baseURL`，代理靠这个头知道当前请求属于哪个 provider —— 于是两个 provider 下同名的 `gpt-6-astra` 也不会串台。这个头在转发前会被剥掉，上游看不到。

也可以手改 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/desktop/cordis.patch.yml`），把你用到的 provider 的 `baseURL` 从中转站直连改成代理：

```yaml
- id: llm-pi-ai
  config:
    providers:
      v:
        displayName: DeepSeek V4.1 Flash
        api: anthropic-messages
        apiKeyEnv: V_API_KEY
        baseURL: http://127.0.0.1:8790      # ← 原来是中转站直连地址
        headers:
          x-relay-route: v                  # ← 让代理认得出是哪个 provider
        models:
          - id: DeepSeek-V4.1-Flash
            name: DeepSeek-V4.1-Flash
            input: [text]
            reasoningEfforts:
              off: null
              max: max
```

不写路由头也能用：代理会退化成按请求体里的 `model` 名去映射表里找上游（同名模型时才需要路由头消歧）。

`examples/cordis.patch.yml` 里有一份可直接抄的片段。

> 想先验证再切换？先不改 baseURL，只开代理（上游填对即可），用第 8 节的 `/__proxy/selftest` 确认改写逻辑正常，再切 provider。

### 5.6 多上游：不同模型走不同中转站

覆盖之后，面板下方的 **模型 · 上游对照表** 就是分流表：

| provider | model | 上游 |
| --- | --- | --- |
| `relay-a`（A 站 · Anthropic 协议） | `DeepSeek-V4.1-Flash` | `https://relay-a.example.com` |
| `relay-b`（B 站 · OpenAI 协议） | `gpt-6-astra` | `https://relay-b.example.com` |

（provider key、模型名、上游域名都换成你自己的 —— 这里只示意这张表的形状。）

- 每行右边的输入框就是该模型的上游地址，改完按 **Enter** 保存（**Esc** 取消）；留空表示回到 provider 原始地址。
- **删除** 会二次确认，然后**同时**从 DSH 模型设置（`llm-pi-ai.providers`）里移除这个模型 —— 插件映射表和 DSH 配置不会脱节。
- 请求到达时，代理按 **路由头 → 路径前缀 `/<provider>/…` → 请求体 `model` 名 → 默认上游兜底** 的顺序解析目标；都不命中返回 `503 upstream not configured`。
- 「监听设置」里的默认上游只是兜底，日常分流靠上面这张表。

### 5.7 重启 DSH

bundle 列表只在启动时读取，**没有文件监听** —— 改完必须完全退出并重新打开 DSH 桌面应用（不是刷新页面）。重启后左侧栏应出现「中转站桥」。

### 5.8 从 2.1.0 升级到 2.2.0

2.1.0 只有「一个上游 + 三个动作」。换掉文件之后还要重新点一次「覆盖」，因为路由头是 2.2.0 才有的：

1. 更新插件目录（`git pull`，或把新文件拷进去）。用 Junction / symlink 装的此时代码已经生效；**但如果你 profile 下的 `node_modules/<包名>/` 是包管理器复制出来的实体而不是链接，记得再同步一次**，否则跑的仍是旧代码。
2. 完全重启 DSH。
3. 面板点 **覆盖**：这次除了改 `baseURL`，还会给每个 provider 写 `x-relay-route` 头，并生成 `~/.dsh/api-relay-bridge/routing.json`（2.1.0 只有 `config.json`）。
4. 原来 `config.json` 里的 `upstream` 会被当作**默认上游**继续用，不用改；要逐模型分流就去「模型 · 上游对照表」里改。
5. 各 provider 的原始地址现在被分别记下来，**还原**时各回各家 —— 不再假设所有 provider 共用一个上游。

> 一句话区别：2.1.0 的 `upstream` 是唯一出站目标；2.2.0 之后它只是兜底，日常按对照表走。

---

## 6. 使用

### 6.1 面板

左侧栏点「中转站桥」（面板标题是 `API 中转站桥`）：

- **顶部徽标**：`代理运行中` / `代理运行中 · 检测异常` / `代理已停止`
- **按钮行**
  - **检测**：跑四项自检 —— `代理端口`（端口在听）、`baseURL 覆盖`（发现哪个 provider 没指向代理会自动改回来）、`上游可达`（映射表里每个上游都并发探一次）、`改写管线`（不发真实模型请求，也不消耗额度）
  - **覆盖**：把所有 provider 的 `baseURL` 改成代理地址并写路由头；代理没在跑会顺手拉起
  - **还原**：写回各 provider 的原始地址并清掉路由头
  - **启用 / 停止**：手动控制监听
- **代理状态卡**：监听地址、默认上游、当前路由（最近一次请求走了哪个 provider / 模型 / 上游）、改写方式、最近错误
- **检测结果卡**：四行 `通过 / 失败` + 明细
- **转发统计**：转发请求 / 改写次数 / 转发错误（可清空）
- **监听设置**：端口 + 默认上游（改端口会重启代理；上游只是兜底，分流看对照表）
- **模型 · 上游对照表**：按 provider 分组，逐模型显示当前上游，可改、可删、可刷新；标题旁显示「N 个」与「M / N provider 已覆盖」。卡片右上还有「刷新」和「全部覆盖」两个快捷动作。改上游按 **Enter** 保存、**Esc** 取消，留空表示回到 provider 原始地址；删模型要再点一次「确认删除」，同时会从 DSH 模型设置里移除
- **最近改写记录**：最近 30 条，含时间、`provider / model → 上游主机`、system 字符数、改写方式、通道（`proxy` / `fetch`）

面板每 2 秒轮询一次状态；正在编辑输入框时不会被打断。

### 6.2 推荐自检流程

1. 面板 → **覆盖**（或先手动改 baseURL）→ 徽标变 `代理运行中`。
2. 面板 → **检测** → 四项全绿；「baseURL 覆盖」这一行会告诉你有没有 provider 被漏掉（并自动修正）。
3. 面板 → **转发统计** 应保持 0（检测不产生转发）。
4. 切一个模型发一句话，观察对照表底下的 **转发请求** 与 **改写次数** 同时 +1，且「当前路由」显示的就是这个模型的 provider 与上游 —— 说明分流生效。
5. 如果你在 system 里放了可判别的指令（例如"回答只能是一个词：青竹"），模型应当直接照做。

### 6.3 命令行

```bash
# 代理状态（含 listening / port / stats / lastRoute / 最近错误）
curl -s http://127.0.0.1:<DSH_WEB_PORT>/relay-bridge/status | jq .proxy

# 模型 ↔ 上游对照表
curl -s http://127.0.0.1:<DSH_WEB_PORT>/relay-bridge/status | jq .routing.rows

# 只测改写管线（不打真实上游）
curl -s http://127.0.0.1:8790/__proxy/selftest | jq .

# 覆盖 / 还原 / 检测 / 启停
curl -s -X POST http://127.0.0.1:<DSH_WEB_PORT>/relay-bridge/proxy -d '{"action":"cover"}'
curl -s -X POST http://127.0.0.1:<DSH_WEB_PORT>/relay-bridge/proxy -d '{"action":"uncover"}'
curl -s -X POST http://127.0.0.1:<DSH_WEB_PORT>/relay-bridge/proxy -d '{"action":"check"}'
curl -s -X POST http://127.0.0.1:<DSH_WEB_PORT>/relay-bridge/proxy -d '{"action":"stop"}'
curl -s -X POST http://127.0.0.1:<DSH_WEB_PORT>/relay-bridge/proxy -d '{"action":"start"}'

# 改某个模型的上游 / 删掉某个模型
curl -s -X POST http://127.0.0.1:<DSH_WEB_PORT>/relay-bridge/models \
  -d '{"action":"set-upstream","provider":"relay-b","model":"gpt-6-astra","upstream":"https://relay-b.example.com"}'
curl -s -X POST http://127.0.0.1:<DSH_WEB_PORT>/relay-bridge/models \
  -d '{"action":"delete-model","provider":"relay-b","model":"gpt-6-astra"}'
```

`8790` 是代理端口；`<DSH_WEB_PORT>` 是 DSH 自己的 Web 端口（每次启动可能不同，从地址栏取）。面板用的就是这些接口，所以也可脚本化。

### 6.4 卸载

1. 面板 → **还原**（把 baseURL 写回原始地址、清掉路由头）
2. 面板 → **停止**
3. 从 `package.json` 的 `dsh.profile.bundles` 与 `dependencies` 里删掉 `dsh-api-relay-bridge`
4. 删除 `node_modules` 下的 Junction / symlink 与插件目录
5. 可选：删掉 `~/.dsh/api-relay-bridge/`（配置、路由表与审计）
6. 重启 DSH

---

## 7. 配置参考

配置来源按优先级从低到高：

1. 本仓库 `cordis.patch.yml`（bundle 默认值）
2. profile 的 `cordis.patch.yml` 里 `- id: dsh-api-relay-bridge` / `config:` 覆盖层
3. 面板保存的运行时覆盖：`~/.dsh/api-relay-bridge/config.json`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 启动时是否自动拉起代理（未配置任何上游且映射表为空时会跳过启动并提示）。面板「启用/停止」会写回 `config.json` |
| `mode` | `"move"` | `move` = 折叠后删除顶层 `system`；`copy` = 保留（对照实验用，会让上游收到两份提示） |
| `port` | `8790` | 监听端口，范围 1024–65535。provider 的 `baseURL` 必须与之一致 |
| `upstream` | `""` | **默认上游**（兜底）。路由头、路径前缀、模型名都没命中时用它。多中转站场景下留空也行 |
| `targets` | `[]` | 需要改写的主机（等值或子域匹配）。只影响 fetch 兜底，默认不启用 |
| `audit` | `true` | 是否把改写元数据写进审计文件 |
| `auditPath` | `~/.dsh/api-relay-bridge/audit.jsonl` | 审计文件路径 |
| `verbose` | `false` | 打开后每次改写打一条 `info` 日志 |

另有一份**运行时路由表** `~/.dsh/api-relay-bridge/routing.json`，由「覆盖 / 对表编辑 / 删模型」自动维护，不需要手改：

```json
{
  "version": 1,
  "updatedAt": "2026-11-05T12:58:00.000Z",
  "providers": {
    "relay-b": {
      "id": "relay-b", "displayName": "B 站 · GPT", "api": "openai-completions",
      "original": "https://relay-b.example.com", "upstream": "https://relay-b.example.com",
      "covered": true,
      "models": {
        "gpt-6-astra": { "id": "gpt-6-astra", "upstream": "https://relay-b.example.com",
                         "original": "https://relay-b.example.com", "source": "original" }
      }
    }
  }
}
```

审计内容是**元数据**，不含请求正文：

```json
{"at":"2026-11-03T14:13:02.113Z","via":"proxy","host":"relay.example.com","path":"/v1/messages","mode":"move","systemChars":4213,"firstUserChars":18}
```

---

## 8. 本地 HTTP 接口

面板用的就是这几个（同源、无需鉴权，因为只监听在回环地址）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/relay-bridge/status` | 完整状态：`plugin` / `version` / `proxy` / `check` / `routing` / `fallback` / `recent` |
| `POST` | `/relay-bridge/proxy` | `{"action":"start"\|"stop"\|"check"}`；`{"action":"cover"\|"uncover"}` 可带 `{"providers":["relay-a"]}` 只处理指定 provider，省略则全部 |
| `POST` | `/relay-bridge/models` | 对照表动作：`{"action":"set-upstream","provider":"relay-b","model":"gpt-6-astra","upstream":"https://relay-b.example.com"}`（`upstream` 为空表示回到原始地址）、`{"action":"delete-model","provider":...,"model":...}`（同步删 DSH 模型设置）、`{"action":"refresh"}` |
| `POST` | `/relay-bridge/config` | 局部更新配置，如 `{"port":8791}` 或 `{"upstream":"https://..."}`；只有改端口才重启代理 |
| `POST` | `/relay-bridge/reset` | 清零统计与最近记录 |

`status` 里的 `routing` 就是对照表的数据源：

```json
{
  "listen": "http://127.0.0.1:8790",
  "header": "x-relay-route",
  "dsh": { "ok": true, "ns": "llm-pi-ai", "source": "configEditor", "error": null },
  "defaults": { "upstream": "" },
  "stats": { "models": 6, "covered": 4, "providers": 4, "uncovered": 0, "mapped": 6 },
  "rows": [
    { "key": "relay-b::gpt-6-astra", "provider": "relay-b", "providerName": "B 站 · GPT",
      "api": "openai-completions", "model": "gpt-6-astra", "modelName": "GPT-6 Astra",
      "baseURL": "http://127.0.0.1:8790", "covered": true,
      "upstream": "https://relay-b.example.com", "original": "https://relay-b.example.com",
      "source": "original", "missing": false }
  ]
}
```

`source` 为 `manual` 表示这一行被手动改过，`original` 表示沿用 provider 原始地址；`stale: true` 表示映射表里还留着但 DSH 里已经没有这个模型。

代理自身的两个内部端点（直接打到代理端口，不会转发出去）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/__proxy/status` | `{listening, port, upstream, defaultUpstream, mode, stats, lastRoute, lastError}` |
| `GET` | `/__proxy/selftest` | 在代理进程内跑一条样例请求，返回 `{ok, systemRemoved, systemChars, firstUserChars, mode}` |

**除这两个前缀外，代理端口上的任何请求都会被按「路由头 → 路径前缀 → 模型名 → 默认上游」解析后转发出去。**

---

## 9. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 左侧栏没有「中转站桥」 | bundle 没加载。检查 profile `package.json` 的 `dsh.profile.bundles` 是否含包名、`node_modules` 下链接是否有效，然后**完全重启** DSH。启动日志里的 `skippedBundles` 会写明失败原因 |
| 面板显示「代理已停止」，对话报连接错误 | provider 的 `baseURL` 指向 8790 但代理没起来。点「覆盖」（会顺手拉起代理），或点「启用」 |
| 对话报 `503 upstream not configured` | 这个模型没有对应上游：确认它出现在对照表里、上游地址不为空，或填一个默认上游兜底 |
| 同名模型走了错的站 | `x-relay-route` 头丢了（手改 baseURL 时漏写）。重新点「覆盖」即可 |
| 检测第一行（端口在听）失败、后三行跳过 | 端口没在听（代理未启动或刚崩溃），先「启用」再「检测」 |
| 检测「baseURL 覆盖」一行显示已自动修正 | 有 provider 被改回了直连，检测把它改回代理。若你确实想让某个 provider 直连，就别点覆盖（也不要再点检测） |
| 检测「上游可达」一行失败 | 该上游不可达（网络 / 代理 / DNS）。代理仍会尝试转发，但请求会失败 |
| 删模型后对话报模型不存在 | 该模型是从 DSH 模型设置里真删了。去 DSH 设置里重新添加，或从 `cordis.patch.yml` 恢复 |
| 启用时报 `EADDRINUSE` | 8790 被占。面板「监听设置」换端口，再点一次「覆盖」让 baseURL 跟上 |
| 转发统计在涨、改写次数为 0 | 请求体里没有可折叠的 `system`（provider 可能用了别的协议）。用 `verbose: true` 看日志 |
| `fallback.installed` 为 `false` | fetch 兜底不在最外层（`dsh-experimental-inspector` 会再包一层）。**不影响代理路径**，可忽略；`targets` 为空时它本就不启用 |
| 模型还是不听 system | 先确认 `systemChars` 是否 > 0（面板或审计文件）；为 0 说明 system 里本来就没内容 —— 那是 purge / 提示词侧的问题，见第 4 节 |
| 长回复被截断 | 上游超时是 600s；如果确实超过，改代理改用例或缩短输出 |
| 用了 `mode: "copy"` 后模型行为怪异 | `copy` 会把提示送两遍（顶层 `system` + user 里各一份），仅供对照。改回 `move` |

---

## 10. 安全与隐私

- 代理**只监听 `127.0.0.1`**，不对外暴露；不校验来源，因为同机任何进程本来就能读到你的 key。
- 不改写、不记录请求正文。审计文件只写主机、路径、字符数这类元数据。
- `x-api-key` / `authorization` 等头**原样透传**，插件不解析、不落盘、不打印；内部路由头 `x-relay-route` 在转发前被剥掉，不会泄漏给上游。
- 出站目标只有你配置过的上游（默认上游 ∪ 对照表里各模型的上游）；`targets` 只决定 fetch 兜底是否改写，不会新增外连。
- 代理是透明转发：它不重试、不缓存、不重排响应，也不改变状态码与响应头（除了按 body 长度重设 `content-length`）。
- 仓库里没有任何具体中转站的域名或凭据 —— 上游地址只存在于你自己的 `~/.dsh/api-relay-bridge/{config,routing}.json`；覆盖会把原始 baseURL 记进 `routing.json`，还原后可完整复原。

---

## 11. 开发与目录结构

```
purge-proxy-bridge/            # 仓库根；包名仍是 dsh-api-relay-bridge
├── index.js            # 宿主半边：代理、多上游路由、改写、覆盖/还原、配置（2171 行，无依赖）
├── client.js           # 客户端半边：左侧栏面板 + 模型·上游对照表（879 行）
├── cordis.patch.yml    # bundle patch：把插件插进 cordis 树，带默认 config
├── package.json        # dsh.bundle.patch + dsh.client 声明
├── README.md           # 本文件
├── CHANGELOG.md        # 1.0.0 起的逐版本记录
├── LICENSE             # MIT
├── .gitignore
├── .gitattributes      # 统一 LF
├── docs/
│   └── architecture.md # 更细的机制说明：改写边界、多上游解析、失败模式
└── examples/
    └── cordis.patch.yml # provider baseURL 指向代理 + 路由头的示例片段
```

两个半边：

- **宿主半边**（`index.js`）导出 `apply(ctx, config)`、`name`、`version`、`inject = []`，另导出 `rewriteRequestBody(text, mode)` 供自检直接调用。它用 `ctx.effect` 注册监听与路由，插件卸载时自动停代理、清路由、恢复 fetch；通过 `ctx.inject(["configEditor"])` / `ctx.inject(["settings"])` 拿到写 DSH 模型设置的通道。
- **客户端半边**（`client.js`）用 `window.__ModuleLoader__.load({ id, factory })`，`factory` 返回 `{ name, inject: ["slots"], apply(ctx) }`，在 `sidebar.panellist` 与 `main` 两个插槽各注册一次，`id`/`key` 都是 `api-relay-bridge`。

关键机制：**覆盖**用 `configEditor.edit(entry, change)` 改 `llm-pi-ai.providers[<pid>].baseURL` 与 `headers["x-relay-route"]`（这是 profile 配置唯一安全的写入通道，自带文件锁、fiber 重载与失败回滚），原始值记进 `routing.json`；**分流**靠代理读请求头 `x-relay-route` 反查 `routing.json` 里的上游。DSH 的 provider 只有一个 `baseURL`，所以同一个 provider 内的不同模型共享该 provider 的上游记录 —— 要拆开就拆 provider。

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

**改完代码怎么让它生效**（两条都踩过坑）：

| 改的是 | 通道 |
| --- | --- |
| `package.json`（含 `dsh.profile.bundles`） | 只在启动时读 —— **完全退出并重开 DSH 桌面应用** |
| `index.js` / `client.js` | profile 模式下 `dsh-hmr` 盯的是 profile 的 `cordis.patch.yml`（`root: []` 不含插件目录）。改那个文件（哪怕只加一个换行）会触发 `reconcileProfile()` → `recomposeProfile`，插件随即重新 import |

还有一个容易漏的：**profile 下的 `node_modules/<包名>/` 有时是包管理器复制出来的实体目录，不是指回仓库的 Junction**。改了代码却没变化，多半就是踩了这个。先确认两份是不是同一份：

```powershell
$repo = "$env:USERPROFILE\.dsh\plugins\dsh-api-relay-bridge\index.js"
$load = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-api-relay-bridge\index.js"

# 哈希一致 = 内容同步；Junction / 硬链接时天然一致
(Get-FileHash $repo).Hash -eq (Get-FileHash $load).Hash

# 是链接还是副本
(Get-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-api-relay-bridge").LinkType
```

`LinkType` 为 `Junction` / `SymbolicLink` 时改仓库即生效；为空（普通目录）说明是副本，改完要拷过去：

```powershell
Copy-Item "$env:USERPROFILE\.dsh\plugins\dsh-api-relay-bridge\*" `
          "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-api-relay-bridge\" `
          -Recurse -Force -Exclude node_modules,.git
```

> Git 与换行：仓库统一 LF（`.gitattributes` 里 `* text=auto eol=lf`）。Windows 上如果 checkout 出 CRLF，改代码时的 diff 会变成整文件重写。

---

## 12. 上传前检查

这份目录已经可以直接上传。只有一处占位符要换：**`<you>`** → 你的 GitHub 用户名。出现在这些地方：

| 位置 | 用在哪 |
| --- | --- |
| README 5.2（Windows）、5.3（macOS / Linux） | `git clone` 地址 |
| README 0.2 最短安装路径 | 同上 |
| README 12（本节）| 提交命令里的 `origin` |
| `package.json` 的 `repository` / `homepage` / `bugs` / `author` | 可选，见下方说明 |

一次性替换：

```bash
# macOS / Linux
grep -rl '<you>' . --exclude-dir=.git | xargs sed -i 's|<you>|你的用户名|g'
```

```powershell
# Windows
Get-ChildItem -Recurse -File -Exclude *.png,*.jpg |
  Where-Object { $_.FullName -notmatch '\\\.git\\' } |
  ForEach-Object {
    (Get-Content $_.FullName -Raw) -replace '<you>', '你的用户名' |
      Set-Content $_.FullName -NoNewline
  }
```

> `package.json` 目前**不含** `repository` / `homepage` / `bugs` / `author` —— 带着 `<you>` 的非法 URL 会让包元信息解析报错，而占位符只能由你自己填。仓库建好之后再把这几项补上就行：
>
> ```json
> "repository": { "type": "git", "url": "https://github.com/<you>/purge-proxy-bridge.git" },
> "homepage": "https://github.com/<you>/purge-proxy-bridge#readme",
> "bugs": { "url": "https://github.com/<you>/purge-proxy-bridge/issues" },
> "author": "<you>"
> ```

然后：

```bash
git init
git add .
git commit -m "feat: API 中转站桥 v2.2.0 —— 一键覆盖 baseURL，多中转站按模型自动分流"
git branch -M main
git tag v2.2.0
git remote add origin https://github.com/<you>/purge-proxy-bridge.git
git push -u origin main --tags
```

Release 说明直接从 [`CHANGELOG.md`](./CHANGELOG.md) 的 `2.2.0` 段复制即可。

**上传前自查清单**：

- [ ] 没有具体中转站域名 / 品牌名 —— `grep -rniE 'apiox[a]|aihu[b]' .` 应当无输出（`relay-*.example.com` 这类示例地址是故意的；方括号是为了让这行检查自己不匹配）
- [ ] 没有 key / token —— `grep -rniE 'sk-|bearer [a-z0-9]{20,}|api[_-]?key *[:=] *["'"'"'][^"'"'"']{16,}'` 应当无输出
- [ ] `node --check index.js && node --check client.js` 通过
- [ ] `node -e "import('./index.js').then(m=>console.log(m.version))"` 打印 `2.2.0`
- [ ] `package.json` 与 `index.js` 的 `VERSION` 都是 `2.2.0`
- [ ] 仓库里没有 `node_modules/`、`api-relay-bridge/`、`*.jsonl`（`.gitignore` 已挡）
- [ ] 文件是 LF（`.gitattributes` 已挡 CRLF 噪音）

> 想让别人能在 DSH 插件市场里一键装：往你的市场 `index.json` 加一条指向本仓库的条目即可；不发布也不影响手动安装。

## 13. 许可

MIT，见 [LICENSE](./LICENSE)。
