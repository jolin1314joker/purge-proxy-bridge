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
★ 本插件（127.0.0.1:8790）   ← 唯一改写点
      │
      ▼
API 中转站（丢弃 system 的地方）
```

关键事实：**`system` 在离开 DSH 时是完好的**。判断方法很直接 —— 看 `usage.input_tokens` 对 system 长度是否敏感。不敏感即说明文本没进入上游上下文。

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
client ──▶ proxy ──▶ upstream
            │
            ├─ readAll(req, 64MB 上限)
            ├─ rewriteRequestBody()
            ├─ 删除 host / connection / content-length / accept-encoding
            ├─ 按新 body 重设 content-length
            ├─ https.request({ hostname, path: pathname+search, method, headers })
            ├─ upstreamRes.pipe(res)      // 状态码与响应头原样透传，SSE 不缓冲
            ├─ upstream 超时 600s
            └─ res.on("close") → 未写完则 destroy 上游
```

- **不做**：重试、缓存、响应重写、header 注入（除 `host`/`content-length` 这类必须重算的）。
- `x-api-key` / `authorization` 原样透传。
- 上游连接错误时，如果响应头还没发出去就 `502`；已开始写响应则直接销毁 socket，避免半截 JSON 被当成完整响应解析。

## 4. 两层改写为什么不会打架

正常情况下 `baseURL` 指向 `127.0.0.1:8790`，请求根本不经过 `globalThis.fetch` 的 `targets` 分支（主机是 `127.0.0.1`，不在 `targets` 里），所以 fetch 兜底不会二次改写。

只有"某个 provider 忘了改 baseURL、直连中转站"时，兜底才接手。这时它做的事情与代理完全一致，且用同一个 `Symbol.for()` 单例做引用计数，HMR 重复 `apply()` 不会叠加包装。

## 5. 失败模式

| 环节 | 失败表现 | 处理 |
| --- | --- | --- |
| 端口绑定 | `EADDRINUSE`，记录到 `proxy.lastError` | 面板换端口 + 改 provider `baseURL` |
| 读取请求体 | 超 64MB 或连接中断 | 不转发，销毁连接（这类请求本来就不可能成功） |
| JSON 解析 | 非 JSON body | 原样转发，计数 `skips` |
| 改写异常 | 任何 throw | 原样转发，计数 `failures`，写 `warn` 日志 |
| 上游 DNS/TLS | `https.request` 的 `error` | 响应头未发出时 502；已发出时销毁 |
| 上游慢 | 600s 超时 | 销毁上游，客户端收到连接中断 |
| 客户端提前断开 | `res` 触发 `close` | 立即 `destroy` 上游，释放连接 |

## 6. 自检三段式

`runCheck()` 依次做三件事，任何一步失败都会把后续步骤标成跳过：

1. **端口在听**：`net.connect(port, 127.0.0.1)`，1.5s 超时。
2. **上游可达**：`https.get(upstream + "/")`，8s 超时；**任何 HTTP 状态码都算可达**（404 也说明 TLS 与 DNS 通了）。
3. **改写管线**：真的向 `/__proxy/selftest` 发一条 HTTP 请求，让代理进程自己跑一次 `rewriteRequestBody`，返回 `{ok, systemRemoved, systemChars, firstUserChars}`。

第 3 步不碰真实上游、不发真实 key，所以可以随时点。

## 7. 与 DSH 生命周期

- `apply(ctx, config)` 里用 `ctx.effect(() => { ... return disposer })` 注册，插件卸载或 HMR 时：停代理、清路由、恢复 `globalThis.fetch`（如果仍是我们那一层）。
- 进程级状态挂在 `Symbol.for("dsh.api-relay-bridge.state")` 上，引用计数归零才真正释放。
- bundle 列表只在 DSH 启动时读取，**改 `package.json` 后必须完全重启桌面应用**；改 `index.js` / `client.js` 同样需要重启（宿主半边没有热重载路径）。
