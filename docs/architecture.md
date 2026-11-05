# 机制说明

本文补充 README 里没展开的实现边界：改写的确切范围、转发细节、以及在出问题时应如何定位。

## 1. 请求链路上的位置

```
dsh-system-prompt      组装 sections（purge 可能重排/注入）
      │
dsh-llm-pi-ai          splitSystemPrompt()：system 字段 + leading system 消息 → 一个 systemPrompt
      │
pi-ai                  anthropic-messages：params.system = [{type:"text", text, cache_control?}]
      │                openai-completions：messages[0] = {role:"system"|"developer"}
      │
@anthropic-ai/sdk      fetch(url, { method:"POST", body: JSON.stringify(params), headers })
      │
      ▼
★ 本插件（127.0.0.1:8790）   ← 唯一改写点，同时是唯一的上游选择点
      │
      ▼
API 中转站 A / B / C（丢弃 system 的地方）
```

关键事实：**`system` 在离开 DSH 时是完好的**。判断方法很直接 —— 看 `usage.input_tokens` 对 system 长度是否敏感。不敏感即说明文本没进入上游上下文。

另一个关键事实：**DSH 的 provider 只能持有一个 `baseURL`**（pi-ai 两个适配器都只用 `model.baseUrl` 建 client）。所以"不同模型走不同中转站"这件事在 DSH 里无法靠配置表达，只能由这层代理在收到请求后按路由特征分流 —— 见第 3.5 节。

## 2. 改写边界

只针对两种协议形态：

| 形态 | 触发条件 | 动作 |
| --- | --- | --- |
| Anthropic | body 有顶层 `system`（string 或 block 数组） | 摊平 → 插入首条 `user.content` 前 → `move` 时 `delete body.system` |
| OpenAI | `messages` 以 `role: "system" \| "developer"` 开头 | 合并文本 → prepend 到首条 `user` → `move` 时删除这些前导消息 |

显式**不改写**：

- 方法不是 `POST`
- body 非 JSON 或解析失败
- 没有可折叠内容（改完与改前等价）
- Google `systemInstruction` 形态（未做折叠，避免误改）
- 代理路径上主机不匹配的请求照样转发，但不改写

### Anthropic 的三个细节

1. **`tool_result` 排序**：Anthropic 要求 `tool_result` 块位于 `content` 最前。若首条 `user` 的 content 以 `tool_result` 开头，system 文本插到这些块之后，否则整条请求会被上游 400。
2. **`cache_control`**：system 若为 block 数组，摊平时保留**最后一个** `cache_control`，把它挂在新插入的文本块上 —— 缓存断点位置与原来语义一致。
3. **深拷贝**：宿主传下来的对象是冻结的（`deepFreeze`），改写全部在深拷贝上进行，改不动就抛错，绝不污染原对象。

### `move` 与 `copy`

- `move`（默认）：折叠后删除顶层 `system`。上游只看到 user 里那一份。
- `copy`：保留顶层 `system`。用于对照实验（同一请求，验证"是 system 丢失还是别的原因"）。**不要长期用** —— 提示会送两遍。

## 3. 转发细节

```
client ──▶ proxy ──▶ upstream（按路由解析选出）
            │
            ├─ readAll(req, 64MB 上限)
            ├─ resolveRoute(): 路由头 → 路径前缀 → 请求体 model → 默认上游
            ├─ rewriteRequestBody()
            ├─ 删除 host / connection / content-length / accept-encoding / x-relay-route
            ├─ 按新 body 重设 content-length
            ├─ https.request({ hostname, path: joinUpstream(upstream, pathname, search), method, headers })
            ├─ upstreamRes.pipe(res)      // 状态码与响应头原样透传，SSE 不缓冲
            ├─ upstream 超时 600s
            └─ res.on("close") → 未写完则 destroy 上游
```

- **不做**：重试、缓存、响应重写、header 注入（除 `host`/`content-length` 这类必须重算的）。
- `x-api-key` / `authorization` 原样透传；内部路由头 `x-relay-route` 一律剥掉。
- 上游连接错误时，如果响应头还没发出去就 `502`；已开始写响应则直接销毁 socket，避免半截 JSON 被当成完整响应解析。

### 3.5 多上游解析

```
routing.json ──┐
               ├─▶ resolveRoute(state, {provider, model, pathname})
profile 配置 ──┘        │
                        ├─ 1. 请求头 x-relay-route: <providerId>
                        ├─ 2. 路径前缀 /<providerId>/rest
                        ├─ 3. 请求体 model 名（同名时按 api 协议消歧）
                        ├─ 4. state.runtime.upstream（默认上游兜底）
                        └─ 5. 全空 → 503 upstream not configured
```

`routing.json`（`~/.dsh/api-relay-bridge/routing.json`）由三处写入：**覆盖**记录 `original` 并置 `covered: true`；**改上游**写模型级 `upstream` 且 `source: "manual"`；**删模型**删掉该键。它同时是面板对照表与检测「baseURL 覆盖」的数据源。

为什么必须要路由头：pi-ai 的 `anthropic-messages` 与 `openai-completions` 两个适配器都只用 `model.baseUrl` 建 client（`dist/api/anthropic-messages.js` 的 `baseURL: model.baseUrl`、`dist/api/openai-completions.js` 的 `new OpenAI({baseURL: model.baseUrl})`），也就是说**一个 provider 内的所有模型共享同一个 baseURL**。要在「同一 provider 的不同模型走不同站」上分流，只能在代理侧按请求特征判定。`profile.headers` 会被 `requestHeaders()` 合并进真实 HTTP 请求，所以它是可靠的信道。

## 4. 两层改写为什么不会打架

正常情况下 `baseURL` 指向 `127.0.0.1:8790`，请求根本不经过 `globalThis.fetch` 的 `targets` 分支（主机是 `127.0.0.1`，不在 `targets` 里），所以 fetch 兜底不会二次改写。

只有"某个 provider 忘了改 baseURL、直连中转站"时，兜底才接手。这时它做的事情与代理完全一致，且用同一个 `Symbol.for()` 单例做引用计数，HMR 重复 `apply()` 不会叠加包装。

## 5. 失败模式

| 环节 | 失败表现 | 处理 |
| --- | --- | --- |
| 端口绑定 | `EADDRINUSE`，记录到 `proxy.lastError` | 面板换端口，再点一次「覆盖」让 baseURL 跟上 |
| 读不到 DSH providers | `routing.dsh.ok = false`，对照表为空 | 检查 `llm-pi-ai` 是否装了 / 配置是否可读；`dsh.error` 里是原始原因 |
| 写回被拒 | `Config field "..." is not volatile` | 该字段不可写。`providers` 整体是 volatile 的，出现这条说明改的不是这个插件该改的路径 |
| 写回抛只读对象 | `Cannot assign to read only property` | 2.2.0 已修（`deepPlain` 深拷贝 live 表）；如果复现，说明又出现了绕过 `rawProvidersOf` 的写路径 |
| 读取请求体 | 超 64MB 或连接中断 | 不转发，销毁连接（这类请求本来就不可能成功） |
| JSON 解析 | 非 JSON body | 原样转发，计数 `skips` |
| 改写异常 | 任何 throw | 原样转发，计数 `failures`，写 `warn` 日志 |
| 路由解析不到上游 | 响应 `503 upstream not configured` | 在对照表里给该模型填上游，或配一个默认上游 |
| 上游 DNS/TLS | `https.request` 的 `error` | 响应头未发出时 502；已发出时销毁 |
| 上游慢 | 600s 超时 | 销毁上游，客户端收到连接中断 |
| 客户端提前断开 | `res` 触发 `close` | 立即 `destroy` 上游，释放连接 |

## 6. 自检四项

`runCheck()` 依次做四件事，`listen` 失败会把后续步骤标成跳过：

1. **端口在听**：`net.connect(port, 127.0.0.1)`，1.5s 超时。
2. **baseURL 覆盖**：读 live providers，凡 `baseURL` 不是本代理的就**自动改写回去**（走 `configEditor`），详情里列出被改的 provider id。这一项是「检测即修复」。
3. **上游可达**：对默认上游与对照表里**每个**上游并发探测，**任何 HTTP 状态码都算可达**（404 也说明 TLS 与 DNS 通了）；详情用 ` ｜ ` 串起来。
4. **改写管线**：真的向 `/__proxy/selftest` 发一条 HTTP 请求，让代理进程自己跑一次 `rewriteRequestBody`，返回 `{ok, systemRemoved, systemChars, firstUserChars}`。

第 4 步不碰真实上游、不发真实 key，所以可以随时点。

## 7. 与 DSH 生命周期

- `apply(ctx, config)` 里用 `ctx.effect(() => { ... return disposer })` 注册，插件卸载或 HMR 时：停代理、清路由、恢复 `globalThis.fetch`（如果仍是我们那一层）。
- 进程级状态挂在 `Symbol.for("dsh.api-relay-bridge.state")` 上，引用计数归零才真正释放。
- bundle 列表只在 DSH 启动时读取，**改 `package.json` 后必须完全重启桌面应用**。改 `index.js` / `client.js` 需要让宿主重新 import：在 profile 模式下 `dsh-hmr` 盯 profile 的 `cordis.patch.yml`（`root: []` 不含插件目录），改动该文件会触发 `reconcileProfile()` → `recomposeProfile`，插件随之重新加载。
- **profile 的 `node_modules/<包名>` 是 pnpm 复制出来的实体，不是指回 `~/.dsh/plugins/` 的链接** —— 改完仓库里的文件必须 `cp` 到 profile 目录（或重装），否则跑的还是旧代码。
