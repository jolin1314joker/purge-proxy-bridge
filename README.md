# purge-proxy-bridge
服务于dsh-purge，在 DSH 与 API中转 之间架一层本地 HTTP 代理：把请求顶层的 `system` 折叠进第一条 `user` 消息，再把 `system` 置空，让上游真正"看见"系统提示。
