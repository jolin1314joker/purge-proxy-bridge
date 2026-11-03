/**
 * API 中转站桥（宿主半边）。
 *
 * 问题：部分 API 中转站会丢弃 Anthropic 请求顶层的 `system` 字段，system 提示因此
 * 永远到不了模型。做法：在 127.0.0.1 上跑一个本地 HTTP 代理，把 DSH 的 provider
 * baseURL 指过来；代理把 `system` 折叠进第一条 user 消息、再把 system 置空，
 * 然后原样（流式）转发到上游。请求链路上因此多了一跳本机回环，模型侧却能看到
 * 完整提示。
 *
 * 另外保留一个进程内 fetch 兜底改写：当某条 provider 仍然直连上游（例如没改
 * baseURL）时，兜底改写让同一份提示照样生效。
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 插件标识（cordis name）。 */
const PLUGIN = "api-relay-bridge";
/** 插件版本。 */
const VERSION = "2.1.0";
/** 进程级安装状态的 Symbol 键，HMR 重载后仍能找到同一份状态。 */
const STATE_KEY = Symbol.for("dsh.api-relay-bridge.state");
/** 折叠后 system 文本与用户内容之间的分隔符。 */
const SEPARATOR = "\n\n";
/** 面板保留的最近改写记录条数。 */
const RECENT_LIMIT = 30;
/** 面板请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024;
/** 转发请求体上限（大上下文对话可能很大）。 */
const MAX_FORWARD_BYTES = 64 * 1024 * 1024;
/** 默认监听端口。 */
const DEFAULT_PORT = 8790;
/** 默认上游。 */
const DEFAULT_UPSTREAM = "";
/** 哨兵 URL：只被 fetch 兜底识别，用于确认它还挂在 fetch 链上。 */
const PROBE_URL = "http://api-relay-bridge.internal/__probe__";
/** 链路探测结果的缓存时长（毫秒）。 */
const PROBE_TTL_MS = 30_000;
/** 代理自带的内部路由。 */
const PROXY_STATUS_PATH = "/__proxy/status";
const PROXY_SELFTEST_PATH = "/__proxy/selftest";
/** 面板路由。 */
const ROUTE_STATUS = "/relay-bridge/status";
const ROUTE_PROXY = "/relay-bridge/proxy";
const ROUTE_CONFIG = "/relay-bridge/config";
const ROUTE_RESET = "/relay-bridge/reset";

const MODES = new Set(["move", "copy"]);

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/** 解析 DSH 主目录。 */
function resolveDshHome() {
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
	return path.join(os.homedir(), ".dsh");
}

/** 状态目录（配置与审计）。 */
function stateDir() {
	return path.join(resolveDshHome(), "api-relay-bridge");
}

/**
 * 规范化拦截目标：接受主机名、URL 或后缀。
 * @param {unknown} value - 配置值。
 * @returns {string[]} 主机名列表。
 */
function normalizeTargets(value) {
	const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const out = [];
	for (const raw of list) {
		if (typeof raw !== "string") continue;
		const trimmed = raw.trim().toLowerCase();
		if (trimmed.length === 0) continue;
		let host = trimmed;
		if (host.includes("://")) {
			try {
				host = new URL(host).hostname;
			} catch {
				continue;
			}
		}
		host = host.replace(/^\/+|\/+$/g, "").replace(/:\d+$/, "").replace(/^\*\./, "");
		if (host.length === 0) continue;
		if (!out.includes(host)) out.push(host);
	}
	return out;
}

/**
 * 规范化监听端口。
 * @param {unknown} value - 配置值。
 * @returns {number} 端口。
 */
function normalizePort(value) {
	const port = typeof value === "string" ? Number.parseInt(value, 10) : value;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) return DEFAULT_PORT;
	return port;
}

/**
 * 规范化上游地址。
 * @param {unknown} value - 配置值。
 * @returns {string} 形如 https://host 的上游 origin。
 */
function normalizeUpstream(value) {
	const raw = typeof value === "string" ? value.trim() : "";
	if (raw.length === 0) return DEFAULT_UPSTREAM;
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_UPSTREAM;
		return `${url.protocol}//${url.host}`;
	} catch {
		return DEFAULT_UPSTREAM;
	}
}

/**
 * 规范化插件配置。
 * @param {unknown} raw - cordis 传入的 config。
 * @returns {object} 运行配置。
 */
function normalizeConfig(raw) {
	const config = raw && typeof raw === "object" ? raw : {};
	return {
		enabled: config.enabled !== false,
		mode: MODES.has(config.mode) ? config.mode : "move",
		port: normalizePort(config.port),
		upstream: normalizeUpstream(config.upstream),
		targets: normalizeTargets(config.targets),
		audit: config.audit !== false,
		auditPath:
			typeof config.auditPath === "string" && config.auditPath.length > 0
				? config.auditPath
				: path.join(stateDir(), "audit.jsonl"),
		verbose: config.verbose === true,
	};
}

/** 运行期覆盖文件路径。 */
function configFile() {
	return path.join(stateDir(), "config.json");
}

/** 读取面板保存过的覆盖项。 */
function loadOverrides() {
	try {
		const text = fs.readFileSync(configFile(), "utf8");
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object") return {};
		const out = {};
		if (typeof parsed.enabled === "boolean") out.enabled = parsed.enabled;
		if (MODES.has(parsed.mode)) out.mode = parsed.mode;
		if (parsed.port !== undefined) out.port = normalizePort(parsed.port);
		if (typeof parsed.upstream === "string") out.upstream = normalizeUpstream(parsed.upstream);
		if (parsed.targets !== undefined) out.targets = normalizeTargets(parsed.targets);
		if (typeof parsed.audit === "boolean") out.audit = parsed.audit;
		if (typeof parsed.verbose === "boolean") out.verbose = parsed.verbose;
		return out;
	} catch {
		return {};
	}
}

/** 把运行配置里可由面板调整的字段写盘。 */
function saveOverrides(runtime) {
	const dir = stateDir();
	fs.mkdirSync(dir, { recursive: true });
	const payload = {
		enabled: runtime.enabled,
		mode: runtime.mode,
		port: runtime.port,
		upstream: runtime.upstream,
		targets: runtime.targets,
		audit: runtime.audit,
		verbose: runtime.verbose,
	};
	fs.writeFileSync(configFile(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------------ */
/* 请求体改写                                                          */
/* ------------------------------------------------------------------ */

/**
 * 判断目标主机是否在拦截列表内（自身或子域）。
 * @param {string} url - 请求 URL。
 * @param {string[]} targets - 目标主机列表。
 * @returns {boolean} 是否匹配。
 */
function hostMatches(url, targets) {
	let host;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	return targets.some((target) => host === target || host.endsWith(`.${target}`));
}

/**
 * 摊平 Anthropic 的 system 字段（字符串或 block 数组），保留最后一个 cache_control。
 * @param {unknown} system - 请求体顶层 system。
 * @returns {{text: string, cacheControl: object | undefined}} 摊平结果。
 */
function flattenSystem(system) {
	let text = "";
	let cacheControl;
	if (typeof system === "string") {
		text = system;
	} else if (Array.isArray(system)) {
		const parts = [];
		for (const block of system) {
			if (typeof block === "string") {
				parts.push(block);
				continue;
			}
			if (!block || typeof block !== "object") continue;
			if (typeof block.text === "string") parts.push(block.text);
			if (block.cache_control && typeof block.cache_control === "object") cacheControl = block.cache_control;
		}
		text = parts.join(SEPARATOR);
	}
	return { text: text.trim(), cacheControl };
}

/**
 * 把提示文本插到第一条 user 消息的内容前面。
 *
 * 插入点跳过前导的 tool_result 块：Anthropic 要求 tool_result 排在 user 内容最前，
 * 把文本插到它前面会让整条消息失效。
 * @param {Array<object>} messages - 消息数组（会被就地修改）。
 * @param {string} text - 要插入的提示文本。
 * @param {object | undefined} cacheControl - 需要保留的 cache_control。
 * @returns {boolean} 是否插入成功。
 */
function injectAnthropic(messages, text, cacheControl) {
	const block = { type: "text", text, ...(cacheControl ? { cache_control: cacheControl } : {}) };
	for (const message of messages) {
		if (!message || typeof message !== "object" || message.role !== "user") continue;
		if (typeof message.content === "string") {
			message.content = [{ type: "text", text }, { type: "text", text: message.content }];
			return true;
		}
		if (!Array.isArray(message.content)) {
			message.content = [block];
			return true;
		}
		let index = 0;
		while (index < message.content.length) {
			const item = message.content[index];
			if (item && typeof item === "object" && item.type === "tool_result") {
				index += 1;
				continue;
			}
			break;
		}
		message.content.splice(index, 0, block);
		return true;
	}
	return false;
}

/** 逐块取一条消息的文本。 */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (typeof block === "string") parts.push(block);
		else if (block && typeof block === "object" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join(SEPARATOR);
}

/** 把提示文本并进首条 user 消息（OpenAI 形态，content 只支持字符串/数组）。 */
function prependOpenAI(message, text) {
	if (typeof message.content === "string") {
		message.content = `${text}${SEPARATOR}${message.content}`;
		return;
	}
	if (Array.isArray(message.content)) {
		message.content = [{ type: "text", text }, ...message.content];
		return;
	}
	message.content = [{ type: "text", text }];
}

/** 深拷贝 content，避免改动宿主传入的冻结对象。 */
function cloneContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((item) => (item && typeof item === "object" ? { ...item } : item));
	return content;
}

/**
 * Anthropic 形态：顶层 system → 首条 user。
 * @param {object} body - 请求体。
 * @param {"move"|"copy"} mode - move 删除顶层 system，copy 保留。
 * @returns {object | undefined} 改写后的请求体，或 undefined 表示无需改写。
 */
function foldAnthropic(body, mode) {
	const { text, cacheControl } = flattenSystem(body.system);
	const messages = Array.isArray(body.messages)
		? body.messages.map((message) =>
				message && typeof message === "object" ? { ...message, content: cloneContent(message.content) } : message
			)
		: [];
	const next = { ...body, messages };
	const injected = text.length > 0 ? injectAnthropic(messages, text, cacheControl) : false;
	if (text.length > 0 && !injected) {
		messages.unshift({ role: "user", content: [{ type: "text", text, ...(cacheControl ? { cache_control: cacheControl } : {}) }] });
	}
	if (mode === "move" && body.system !== undefined) delete next.system;
	if (text.length === 0 && mode !== "move") return undefined;
	return next;
}

/**
 * OpenAI 形态：前导 system/developer 消息 → 首条 user。
 * @param {object} body - 请求体。
 * @param {"move"|"copy"} mode - move 删除前导 system 消息。
 * @returns {object | undefined} 改写后的请求体，或 undefined 表示无需改写。
 */
function foldOpenAI(body, mode) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const leading = [];
	let index = 0;
	while (index < messages.length) {
		const message = messages[index];
		if (!message || typeof message !== "object" || (message.role !== "system" && message.role !== "developer")) break;
		leading.push(message);
		index += 1;
	}
	if (leading.length === 0) return undefined;
	const text = leading
		.map((message) => contentText(message.content))
		.filter((part) => part.length > 0)
		.join(SEPARATOR);
	const rest = messages.slice(index).map((message) =>
		message && typeof message === "object" ? { ...message, content: cloneContent(message.content) } : message
	);
	if (text.length > 0) {
		const firstUser = rest.find((message) => message && message.role === "user");
		if (firstUser) prependOpenAI(firstUser, text);
		else rest.unshift({ role: "user", content: text });
	}
	const next = { ...body, messages: mode === "move" ? rest : [...leading.map((m) => ({ ...m })), ...rest] };
	return next;
}

/**
 * 改写一次请求体：把 system 折叠进首条 user 消息。
 * @param {string} text - 原始 JSON 文本。
 * @param {"move"|"copy"} mode - 是否删除 system 字段。
 * @returns {string | undefined} 改写后的 JSON，或 undefined 表示无需改写。
 */
export function rewriteRequestBody(text, mode) {
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
	const next = body.system !== undefined ? foldAnthropic(body, mode) : foldOpenAI(body, mode);
	if (next === undefined) return undefined;
	if (JSON.stringify(next) === JSON.stringify(body)) return undefined;
	return JSON.stringify(next);
}

/**
 * 取一次 fetch 调用的 URL 字符串，无法识别时返回 undefined。
 * @param {unknown} input - fetch 第一个参数。
 * @returns {string | undefined} URL。
 */
function urlOf(input) {
	if (typeof input === "string") return input;
	if (typeof Request !== "undefined" && input instanceof Request) return input.url;
	if (input instanceof URL) return input.href;
	return undefined;
}

/**
 * 把 fetch 的 body 参数转成可解析文本；流式或二进制 body 原样放过。
 * @param {unknown} body - init.body。
 * @returns {Promise<string | undefined>} 文本，或 undefined 表示不处理。
 */
async function bodyToText(body) {
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
	if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
	if (typeof Request !== "undefined" && body instanceof ReadableStream) return undefined;
	return undefined;
}

/* ------------------------------------------------------------------ */
/* 本地代理                                                            */
/* ------------------------------------------------------------------ */

/** 读取完整请求体（带上限）。 */
function readAll(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error(`request body exceeds ${limit} bytes`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/**
 * 代理内部状态快照。
 * @param {object} state - 安装状态。
 * @returns {Record<string, unknown>} 快照。
 */
function proxySnapshot(state) {
	const proxy = state.proxy;
	return {
		listening: proxy.server !== null,
		address: proxy.server !== null ? `127.0.0.1:${state.runtime.port}` : "",
		port: state.runtime.port,
		upstream: state.runtime.upstream,
		mode: state.runtime.mode,
		startedAt: proxy.startedAt,
		stats: { ...proxy.stats },
		lastError: proxy.lastError,
	};
}

/** 发送 JSON 响应。 */
function sendJson(res, status, payload) {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(body.length),
		"cache-control": "no-store",
	});
	res.end(body);
}

/** 自检：在代理进程内把一份样例请求走一遍改写管线，返回前后对比。 */
async function handleSelfTest(state, req, res) {
	let raw;
	try {
		raw = await readAll(req, MAX_BODY_BYTES);
	} catch (error) {
		sendJson(res, 413, { ok: false, error: String(error && error.message ? error.message : error) });
		return;
	}
	let sample;
	try {
		sample = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {};
	} catch {
		sendJson(res, 400, { ok: false, error: "invalid json" });
		return;
	}
	const system = typeof sample.system === "string" ? sample.system : "代理桥自检：system 应当出现在第一条 user 消息里。";
	const body = {
		model: "bridge-selftest",
		max_tokens: 1,
		system: [{ type: "text", text: system }],
		messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
	};
	const before = JSON.stringify(body);
	const after = rewriteRequestBody(before, state.runtime.mode);
	if (after === undefined) {
		sendJson(res, 200, { ok: false, error: "rewrite returned undefined" });
		return;
	}
	const parsed = JSON.parse(after);
	const firstUser = Array.isArray(parsed.messages) ? parsed.messages.find((m) => m && m.role === "user") : undefined;
	const injected = firstUser ? contentText(firstUser.content) : "";
	sendJson(res, 200, {
		ok: parsed.system === undefined && injected.includes(system),
		systemRemoved: parsed.system === undefined,
		systemChars: system.length,
		firstUserChars: injected.length,
		mode: state.runtime.mode,
	});
}

/** 转发一次请求到上游（流式）。 */
async function forward(state, req, res) {
	const settings = state.runtime;
	const proxy = state.proxy;
	if (settings.upstream.length === 0) {
		proxy.stats.errors += 1;
		proxy.lastError = "未配置上游地址（upstream）";
		sendJson(res, 503, { error: "upstream not configured" });
		return;
	}
	let body;
	try {
		body = await readAll(req, MAX_FORWARD_BYTES);
	} catch (error) {
		proxy.stats.errors += 1;
		proxy.lastError = String(error && error.message ? error.message : error);
		sendJson(res, 413, { error: proxy.lastError });
		return;
	}

	const method = String(req.method ?? "GET").toUpperCase();
	let payload = body;
	let rewritten = false;
	if (method === "POST" && body.length > 0) {
		const text = body.toString("utf8");
		const next = rewriteRequestBody(text, settings.mode);
		if (next !== undefined) {
			payload = Buffer.from(next, "utf8");
			rewritten = true;
		}
	}

	proxy.stats.requests += 1;
	if (rewritten) {
		proxy.stats.rewrites += 1;
		proxy.stats.bytesSaved = (proxy.stats.bytesSaved ?? 0) + (payload.length - body.length);
		proxy.stats.lastAt = new Date().toISOString();
		record(state, {
			at: proxy.stats.lastAt,
			host: new URL(settings.upstream).host,
			systemChars: countSystemChars(body),
			mode: settings.mode,
			via: "proxy",
		});
	}

	let target;
	try {
		target = new URL(req.url ?? "/", settings.upstream);
	} catch {
		sendJson(res, 400, { error: "invalid request url" });
		return;
	}

	try {
		req.socket?.setNoDelay?.(true);
	} catch {
		/* 套接字已关闭 */
	}
	const headers = { ...req.headers };
	delete headers.host;
	delete headers.connection;
	delete headers["content-length"];
	delete headers["accept-encoding"];
	headers["content-length"] = String(payload.length);

	const lib = target.protocol === "https:" ? https : http;
	const upstreamReq = lib.request(
		{
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port || (target.protocol === "https:" ? 443 : 80),
			path: `${target.pathname}${target.search}`,
			method,
			headers,
		},
		(upstreamRes) => {
			const outHeaders = { ...upstreamRes.headers };
			delete outHeaders["transfer-encoding"];
			delete outHeaders.connection;
			try {
				res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
			} catch (error) {
				proxy.stats.errors += 1;
				proxy.lastError = String(error && error.message ? error.message : error);
				upstreamRes.destroy();
				return;
			}
			upstreamRes.pipe(res);
			upstreamRes.on("error", (error) => {
				proxy.stats.errors += 1;
				proxy.lastError = String(error && error.message ? error.message : error);
				res.destroy();
			});
		}
	);

	res.on("close", () => {
		if (!res.writableEnded) upstreamReq.destroy();
	});
	upstreamReq.setTimeout(600_000, () => {
		proxy.lastError = "upstream timeout";
		upstreamReq.destroy(new Error("upstream timeout"));
	});
	upstreamReq.on("error", (error) => {
		proxy.stats.errors += 1;
		proxy.lastError = String(error && error.message ? error.message : error);
		if (!res.headersSent) sendJson(res, 502, { error: `upstream unreachable: ${proxy.lastError}` });
		else res.destroy();
	});
	upstreamReq.end(payload.length > 0 ? payload : undefined);
}

/** 统计请求体里的 system 字符数，仅用于显示。 */
function countSystemChars(buffer) {
	try {
		const body = JSON.parse(buffer.toString("utf8"));
		const { text } = flattenSystem(body && body.system);
		return text.length;
	} catch {
		return 0;
	}
}

/** 创建代理服务器的请求处理器。 */
function proxyHandler(state) {
	return (req, res) => {
		let pathname = "/";
		try {
			pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		} catch {
			pathname = "/";
		}
		if (pathname === PROXY_STATUS_PATH) {
			sendJson(res, 200, proxySnapshot(state));
			return;
		}
		if (pathname === PROXY_SELFTEST_PATH) {
			handleSelfTest(state, req, res).catch(() => {
				try {
					sendJson(res, 500, { ok: false });
				} catch {
					/* 响应已结束 */
				}
			});
			return;
		}
		forward(state, req, res).catch((error) => {
			state.proxy.stats.errors += 1;
			state.proxy.lastError = String(error && error.message ? error.message : error);
			try {
				if (!res.headersSent) sendJson(res, 502, { error: state.proxy.lastError });
				else res.destroy();
			} catch {
				/* 响应已结束 */
			}
		});
	};
}

/**
 * 启动本地代理。
 * @param {object} state - 安装状态。
 * @returns {Promise<Record<string, unknown>>} 启动后的代理快照。
 */
function startProxy(state) {
	if (state.proxy.server !== null) return Promise.resolve(proxySnapshot(state));
	const server = http.createServer(proxyHandler(state));
	server.keepAliveTimeout = 65_000;
	server.headersTimeout = 70_000;
	server.on("clientError", (error, socket) => {
		state.proxy.lastError = `client error: ${String(error && error.message ? error.message : error)}`;
		if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
	});
	return new Promise((resolve, reject) => {
		server.once("error", (error) => {
			state.proxy.lastError = String(error && error.message ? error.message : error);
			reject(error);
		});
		server.listen(state.runtime.port, "127.0.0.1", () => {
			server.removeAllListeners("error");
			server.on("error", (error) => {
				state.proxy.lastError = String(error && error.message ? error.message : error);
				state.logger.warn(`api-relay-bridge: 代理服务器错误（${state.proxy.lastError}）`);
			});
			state.proxy.server = server;
			state.proxy.startedAt = new Date().toISOString();
			state.proxy.lastError = null;
			state.logger.info(
				`api-relay-bridge: 代理已监听 http://127.0.0.1:${state.runtime.port} → ${state.runtime.upstream}（mode=${state.runtime.mode}）`
			);
			resolve(proxySnapshot(state));
		});
	});
}

/**
 * 停止本地代理。
 * @param {object} state - 安装状态。
 * @returns {Promise<Record<string, unknown>>} 停止后的代理快照。
 */
function stopProxy(state) {
	const server = state.proxy.server;
	if (server === null) return Promise.resolve(proxySnapshot(state));
	state.proxy.server = null;
	state.proxy.startedAt = null;
	return new Promise((resolve) => {
		server.closeAllConnections?.();
		server.close(() => {
			state.logger.info(`api-relay-bridge: 代理已停止（127.0.0.1:${state.runtime.port}）`);
			resolve(proxySnapshot(state));
		});
		setTimeout(() => resolve(proxySnapshot(state)), 500);
	});
}

/** TCP 端口连通性探测。 */
function probePort(port, timeoutMs = 1500) {
	return new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		const done = (ok, detail) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve({ ok, detail });
		};
		socket.setTimeout(timeoutMs, () => done(false, "连接超时"));
		socket.once("connect", () => done(true, "端口已监听"));
		socket.once("error", (error) => done(false, String(error && error.code ? error.code : error)));
	});
}

/** 上游可达性探测（任意 HTTP 状态码都算可达）。 */
function probeUpstream(upstream, timeoutMs = 8000) {
	if (typeof upstream !== "string" || upstream.length === 0) {
		return Promise.resolve({ ok: false, detail: "未配置上游地址", ms: 0 });
	}
	return new Promise((resolve) => {
		const started = Date.now();
		let settled = false;
		const finish = (ok, detail) => {
			if (settled) return;
			settled = true;
			resolve({ ok, detail, ms: Date.now() - started });
		};
		try {
			const url = new URL(upstream);
			const lib = url.protocol === "https:" ? https : http;
			const req = lib.request(
				{ protocol: url.protocol, hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: "/", method: "GET", timeout: timeoutMs },
				(res) => {
					res.resume();
					finish(true, `HTTP ${res.statusCode ?? 0}`);
				}
			);
			req.setTimeout(timeoutMs, () => {
				req.destroy(new Error("timeout"));
				finish(false, "连接超时");
			});
			req.on("error", (error) => finish(false, String(error && error.message ? error.message : error)));
			req.end();
		} catch (error) {
			finish(false, String(error && error.message ? error.message : error));
		}
	});
}

/** 通过本机代理的自检端点验证改写管线。 */
function probePipeline(port, timeoutMs = 4000) {
	return new Promise((resolve) => {
		const started = Date.now();
		const body = Buffer.from(
			JSON.stringify({
				system: "代理桥自检：这一段应当出现在第一条 user 消息里。",
				messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
			}),
			"utf8"
		);
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: PROXY_SELFTEST_PATH,
				method: "POST",
				timeout: timeoutMs,
				headers: { "content-type": "application/json", "content-length": String(body.length) },
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					let parsed;
					try {
						parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					} catch {
						resolve({ ok: false, detail: "自检响应无法解析", ms: Date.now() - started });
						return;
					}
					const detail = parsed.ok
						? `system ${parsed.systemChars} 字符 → 首条 user ${parsed.firstUserChars} 字符，顶层 system 已移除`
						: `自检未通过：${parsed.error ?? "改写结果不符合预期"}`;
					resolve({ ok: parsed.ok === true, detail, ms: Date.now() - started });
				});
			}
		);
		req.setTimeout(timeoutMs, () => {
			req.destroy(new Error("timeout"));
			resolve({ ok: false, detail: "自检超时", ms: Date.now() - started });
		});
		req.on("error", (error) => resolve({ ok: false, detail: String(error && error.message ? error.message : error), ms: Date.now() - started }));
		req.end(body);
	});
}

/**
 * 跑一次完整检测：端口、上游、改写管线。
 * @param {object} state - 安装状态。
 * @returns {Promise<Record<string, unknown>>} 检测结果。
 */
async function runCheck(state) {
	const port = state.runtime.port;
	const portResult = await probePort(port);
	const upstreamResult = await probeUpstream(state.runtime.upstream);
	const pipelineResult = portResult.ok ? await probePipeline(port) : { ok: false, detail: "端口未监听，跳过", ms: 0 };
	const checks = [
		{ id: "listen", label: "代理端口", ok: portResult.ok, detail: portResult.ok ? `127.0.0.1:${port} 已监听` : `${portResult.detail}` },
		{ id: "upstream", label: "上游可达", ok: upstreamResult.ok, detail: `${state.runtime.upstream} · ${upstreamResult.detail} · ${upstreamResult.ms}ms` },
		{ id: "rewrite", label: "改写管线", ok: pipelineResult.ok, detail: `${pipelineResult.detail} · ${pipelineResult.ms}ms` },
	];
	const ok = checks.every((item) => item.ok);
	state.proxy.check = { at: new Date().toISOString(), ok, checks };
	if (!ok) state.proxy.lastError = checks.find((item) => !item.ok)?.detail ?? null;
	return state.proxy.check;
}

/* ------------------------------------------------------------------ */
/* 面板路由                                                            */
/* ------------------------------------------------------------------ */

/**
 * 探测 fetch 兜底在链上的位置。
 *
 * 宿主里可能有别的插件在本插件之后再次包装 `globalThis.fetch`（例如
 * dsh-experimental-inspector 的抓包观察器），此时 `globalThis.fetch` 不再等于
 * 本插件的包装函数，但它仍在链上。用一次哨兵请求判断链路是否还通：哨兵 URL
 * 只被本插件识别并就地返回 204，不会发出真实网络请求。
 * @param {object} state - 安装状态。
 * @returns {Promise<{installed: boolean, position: string}>} 位置信息。
 */
async function layering(state) {
	if (typeof globalThis.fetch !== "function") return { installed: false, position: "missing" };
	if (globalThis.fetch === state.wrapper) return { installed: true, position: "top" };
	const now = Date.now();
	if (state.probeResult !== undefined && now - state.probeCheckedAt < PROBE_TTL_MS) return state.probeResult;
	const before = state.stats.probes;
	try {
		await globalThis.fetch(PROBE_URL, { method: "GET", signal: AbortSignal.timeout(2000) });
	} catch {
		/* 探测调用本身失败，按未命中处理 */
	}
	const hit = state.stats.probes > before;
	state.probeResult = hit ? { installed: true, position: "shadowed" } : { installed: false, position: "detached" };
	state.probeCheckedAt = now;
	return state.probeResult;
}

/**
 * 构造面板读取的状态快照。
 * @param {object} state - 安装状态。
 * @returns {Promise<Record<string, unknown>>} 快照。
 */
async function snapshot(state) {
	const layer = await layering(state);
	return {
		plugin: PLUGIN,
		version: VERSION,
		proxy: proxySnapshot(state),
		check: state.proxy.check ?? null,
		fallback: {
			installed: layer.installed,
			position: layer.position,
			enabled: state.runtime.enabled,
			targets: state.runtime.targets.slice(),
			stats: { ...state.stats },
		},
		recent: state.recent.slice().reverse(),
	};
}

/**
 * 把新配置应用到运行对象，返回发生变化的字段名。
 * @param {object} runtime - 运行配置。
 * @param {Record<string, unknown>} patch - 面板提交的字段。
 * @returns {string[]} 变更字段。
 */
function applyRuntime(runtime, patch) {
	const changed = [];
	if (typeof patch.enabled === "boolean" && patch.enabled !== runtime.enabled) {
		runtime.enabled = patch.enabled;
		changed.push("enabled");
	}
	if (MODES.has(patch.mode) && patch.mode !== runtime.mode) {
		runtime.mode = patch.mode;
		changed.push("mode");
	}
	if (patch.port !== undefined) {
		const port = normalizePort(patch.port);
		if (port !== runtime.port) {
			runtime.port = port;
			changed.push("port");
		}
	}
	if (patch.upstream !== undefined) {
		const upstream = normalizeUpstream(patch.upstream);
		if (upstream !== runtime.upstream) {
			runtime.upstream = upstream;
			changed.push("upstream");
		}
	}
	if (patch.targets !== undefined) {
		const targets = normalizeTargets(patch.targets);
		if (targets.join(",") !== runtime.targets.join(",")) {
			runtime.targets = targets;
			changed.push("targets");
		}
	}
	if (typeof patch.audit === "boolean" && patch.audit !== runtime.audit) {
		runtime.audit = patch.audit;
		changed.push("audit");
	}
	if (typeof patch.verbose === "boolean" && patch.verbose !== runtime.verbose) {
		runtime.verbose = patch.verbose;
		changed.push("verbose");
	}
	return changed;
}

/** 读取面板 POST 的 JSON body（带上限）。 */
function readJsonBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				resolve(undefined);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				resolve(parsed && typeof parsed === "object" ? parsed : undefined);
			} catch {
				resolve(undefined);
			}
		});
		req.on("error", () => resolve(undefined));
	});
}

/**
 * 注册面板路由。
 * @param {object} ws - webServer。
 * @param {object} state - 安装状态。
 * @returns {() => void} 清理函数。
 */
function installRoutes(ws, state) {
	if (!ws || typeof ws.register !== "function") return () => {};
	if (state.routes.size > 0) return () => {};
	const disposers = [];
	const mount = (route) => {
		disposers.push(ws.register({ kind: "exact", path: route.path, handler: route.handler }));
		state.routes.set(route.path, true);
	};

	mount({
		kind: "exact",
		path: ROUTE_STATUS,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "HEAD") {
				sendJson(res, 405, { error: "method not allowed" });
				return;
			}
			try {
				sendJson(res, 200, await snapshot(state));
			} catch (error) {
				state.logger.warn(`api-relay-bridge: 状态路由失败（${String(error && error.message ? error.message : error)}）`);
				try {
					sendJson(res, 500, { error: "internal error" });
				} catch {
					/* 响应已结束 */
				}
			}
		},
	});

	mount({
		kind: "exact",
		path: ROUTE_PROXY,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { error: "method not allowed" });
				return;
			}
			try {
				const body = (await readJsonBody(req)) ?? {};
				const action = typeof body.action === "string" ? body.action : "";
				if (action === "start") {
					state.runtime.enabled = true;
					await startProxy(state);
					saveOverrides(state.runtime);
					sendJson(res, 200, { action, ok: true, ...(await snapshot(state)) });
					return;
				}
				if (action === "stop") {
					await stopProxy(state);
					saveOverrides(state.runtime);
					sendJson(res, 200, { action, ok: true, ...(await snapshot(state)) });
					return;
				}
				if (action === "check") {
					const check = await runCheck(state);
					sendJson(res, 200, { action, ok: check.ok, ...(await snapshot(state)) });
					return;
				}
				sendJson(res, 400, { error: `unknown action: ${action}` });
			} catch (error) {
				state.logger.warn(`api-relay-bridge: 代理控制失败（${String(error && error.message ? error.message : error)}）`);
				try {
					sendJson(res, 500, { error: String(error && error.message ? error.message : error) });
				} catch {
					/* 响应已结束 */
				}
			}
		},
	});

	mount({
		kind: "exact",
		path: ROUTE_CONFIG,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { error: "method not allowed" });
				return;
			}
			try {
				const patch = await readJsonBody(req);
				if (patch === undefined) {
					sendJson(res, 400, { error: "invalid json body" });
					return;
				}
				const changed = applyRuntime(state.runtime, patch);
				if (changed.includes("port") || changed.includes("upstream")) {
					await stopProxy(state);
					await startProxy(state);
				}
				if (changed.length > 0) {
					saveOverrides(state.runtime);
					state.logger.info(`api-relay-bridge: 面板更新配置 ${changed.join(", ")}`);
				}
				sendJson(res, 200, { changed, ...(await snapshot(state)) });
			} catch (error) {
				state.logger.warn(`api-relay-bridge: 配置路由失败（${String(error && error.message ? error.message : error)}）`);
				try {
					sendJson(res, 500, { error: "internal error" });
				} catch {
					/* 响应已结束 */
				}
			}
		},
	});

	mount({
		kind: "exact",
		path: ROUTE_RESET,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { error: "method not allowed" });
				return;
			}
			state.stats.requests = 0;
			state.stats.rewrites = 0;
			state.stats.skips = 0;
			state.stats.failures = 0;
			state.stats.systemChars = 0;
			state.stats.lastAt = null;
			state.proxy.stats.requests = 0;
			state.proxy.stats.rewrites = 0;
			state.proxy.stats.errors = 0;
			state.proxy.stats.lastAt = null;
			state.proxy.lastError = null;
			state.proxy.check = null;
			state.recent.length = 0;
			state.probeResult = undefined;
			sendJson(res, 200, await snapshot(state));
		},
	});

	return () => {
		for (const dispose of disposers) dispose();
		state.routes.clear();
	};
}

/* ------------------------------------------------------------------ */
/* 安装                                                                */
/* ------------------------------------------------------------------ */

/** 写审计记录（落盘失败不影响请求）。 */
function record(state, entry) {
	state.recent.push(entry);
	if (state.recent.length > RECENT_LIMIT) state.recent.splice(0, state.recent.length - RECENT_LIMIT);
	if (!state.runtime.audit) return;
	try {
		fs.mkdirSync(path.dirname(state.runtime.auditPath), { recursive: true });
		fs.appendFileSync(state.runtime.auditPath, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		/* 审计写失败不阻断请求 */
	}
}

/**
 * 安装改写层（进程级单例 + 引用计数）。
 * @param {object} runtime - 运行配置。
 * @param {object} logger - 宿主 logger。
 * @returns {() => void} 释放函数。
 */
function acquire(runtime, logger) {
	const shared = globalThis[STATE_KEY];
	if (shared !== undefined) {
		shared.refs += 1;
		shared.runtime = runtime;
		shared.logger = logger;
		return () => release(shared, logger);
	}
	const original = globalThis.fetch;
	const state = {
		refs: 1,
		runtime,
		logger,
		original,
		wrapper: undefined,
		stats: { requests: 0, rewrites: 0, skips: 0, failures: 0, systemChars: 0, probes: 0, lastAt: null },
		recent: [],
		routes: new Map(),
		announced: false,
		proxy: {
			server: null,
			startedAt: null,
			lastError: null,
			check: null,
			stats: { requests: 0, rewrites: 0, errors: 0, lastAt: null },
		},
	};
	state.wrapper = async function bridgedFetch(input, init) {
		if (urlOf(input) === PROBE_URL) {
			state.stats.probes += 1;
			return new Response(null, { status: 204 });
		}
		state.stats.requests += 1;
		const active = state.runtime;
		if (!active.enabled) return state.original(input, init);
		if (typeof original !== "function") return state.original(input, init);
		let rewritten;
		try {
			rewritten = await intercept(input, init, state);
		} catch (error) {
			state.stats.failures += 1;
			state.logger.warn(`api-relay-bridge: 兜底拦截失败，按原请求放行（${String(error && error.message ? error.message : error)}）`);
			return (state.original ?? original)(input, init);
		}
		if (rewritten === undefined) return (state.original ?? original)(input, init);
		return (state.original ?? original)(rewritten.input, rewritten.init);
	};
	globalThis.fetch = state.wrapper;
	globalThis[STATE_KEY] = state;
	return () => release(state, logger);
}

/**
 * 兜底改写：只处理直连目标主机的请求。
 * @param {unknown} input - fetch 第一个参数。
 * @param {unknown} init - fetch 第二个参数。
 * @param {object} state - 安装状态。
 * @returns {Promise<{input: unknown, init: unknown} | undefined>} 改写后的调用参数。
 */
async function intercept(input, init, state) {
	const settings = state.runtime;
	const isRequest = typeof Request !== "undefined" && input instanceof Request;
	const url = urlOf(input);
	if (url === undefined) return undefined;
	if (!hostMatches(url, settings.targets)) return undefined;
	const method = String(init && init.method ? init.method : isRequest ? input.method : "GET").toUpperCase();
	if (method !== "POST") {
		state.stats.skips += 1;
		return undefined;
	}
	const headers = new Headers(init && init.headers !== undefined ? init.headers : isRequest ? input.headers : undefined);
	const rawBody = init && init.body !== undefined ? init.body : isRequest ? await input.clone().text() : undefined;
	const text = await bodyToText(rawBody);
	if (text === undefined || text.length === 0) {
		state.stats.skips += 1;
		return undefined;
	}
	const next = rewriteRequestBody(text, settings.mode);
	if (next === undefined) {
		state.stats.skips += 1;
		return undefined;
	}
	headers.delete("content-length");
	const parsed = JSON.parse(text);
	const { text: systemText } = flattenSystem(parsed.system);
	state.stats.rewrites += 1;
	state.stats.systemChars += systemText.length;
	state.stats.lastAt = new Date().toISOString();
	if (!state.announced) {
		state.announced = true;
		state.logger.info(`api-relay-bridge: 兜底改写已接管 ${url}（system ${systemText.length} 字符折叠进首条 user 消息）`);
	}
	record(state, {
		at: state.stats.lastAt,
		host: new URL(url).host,
		systemChars: systemText.length,
		mode: settings.mode,
		via: "fetch",
	});
	return { input: isRequest ? new Request(input, { headers }) : input, init: { ...(init ?? {}), headers, body: next } };
}

/** 释放安装；最后一个持有者负责恢复 fetch 并停掉代理。 */
function release(state, logger) {
	state.refs -= 1;
	if (state.refs > 0) return;
	if (globalThis.fetch === state.wrapper) globalThis.fetch = state.original;
	if (globalThis[STATE_KEY] === state) delete globalThis[STATE_KEY];
	stopProxy(state).catch(() => {});
	try {
		for (const dispose of state.routeDisposers ?? []) dispose();
	} catch {
		/* 路由清理失败忽略 */
	}
	if (logger && typeof logger.info === "function") logger.info("api-relay-bridge: 已卸载（fetch 兜底与代理均已停止）");
}

/**
 * 插件入口。
 * @param {object} ctx - cordis 上下文。
 * @param {unknown} config - 插件配置。
 */
export function apply(ctx, config) {
	const runtime = { ...normalizeConfig(config), ...loadOverrides() };
	ctx.effect(() => acquire(runtime, ctx.logger), "api-relay-bridge.install()");
	const state = globalThis[STATE_KEY];
	if (runtime.enabled && runtime.upstream.length === 0) {
		state.proxy.lastError = "未配置上游地址（upstream）";
		ctx.logger.warn("api-relay-bridge: 未配置上游地址，代理未启动。请在面板「监听设置」填写上游，或设置配置项 upstream。");
	} else if (runtime.enabled) {
		startProxy(state).catch((error) => {
			ctx.logger.warn(`api-relay-bridge: 代理启动失败（${String(error && error.message ? error.message : error)}）`);
		});
	}
	let disposeRoutes = () => {};
	ctx.inject(["webServer"], (sub) => {
		disposeRoutes = installRoutes(sub.webServer, state);
		state.routeDisposers = [disposeRoutes];
		return () => disposeRoutes();
	});
}

/** cordis 插件名。 */
export const name = PLUGIN;
/** 插件版本。 */
export const version = VERSION;
/** 不依赖其它服务。 */
export const inject = [];
