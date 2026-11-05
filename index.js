/**
 * API 中转站桥（宿主半边）。
 *
 * 问题：部分 API 中转站会丢弃 Anthropic 请求顶层的 `system` 字段，system 提示因此
 * 永远到不了模型。做法：在 127.0.0.1 上跑一个本地 HTTP 代理，把 DSH 的 provider
 * baseURL 指过来；代理把 `system` 折叠进第一条 user 消息、再把 system 置空，
 * 然后原样（流式）转发到上游。请求链路上因此多了一跳本机回环，模型侧却能看到
 * 完整提示。
 *
 * 多上游：DSH 的 baseURL 是 provider 级别的，一个地址就只能有一个上游。本插件
 * 为每个 provider 记录它原本的上游地址，并在覆盖时额外写入一个内部路由头
 * `x-relay-route: <provider>`；代理按这个头（其次按请求体里的 model，再其次按
 * 路径前缀 `/<provider>/...`）选择真正的上游，于是「A 站的 DeepSeek-V4.1-Flash
 * 走 A 站的上游、B 站的 gpt-6-astra 走 B 站的上游」可以同时成立，且所有
 * provider 的 baseURL 都是同一个 `http://127.0.0.1:8790`。
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
const VERSION = "2.2.0";
/** 进程级安装状态的 Symbol 键，HMR 重载后仍能找到同一份状态。 */
const STATE_KEY = Symbol.for("dsh.api-relay-bridge.state");
/** 折叠后 system 文本与用户内容之间的分隔符。 */
const SEPARATOR = "\\n\\n";
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
/** 代理只监听回环地址。 */
const LISTEN_HOST = "127.0.0.1";
/** 内部路由头：覆盖时写进 provider 的 headers，代理据此确定上游。 */
const ROUTE_HEADER = "x-relay-route";
/** 哨兵 URL：只被 fetch 兜底识别，用于确认它还挂在 fetch 链上。 */
const PROBE_URL = "http://api-relay-bridge.internal/__probe__";
/** 链路探测结果的缓存时长（毫秒）。 */
const PROBE_TTL_MS = 30_000;
/** DSH 配置快照的缓存时长（毫秒），避免面板轮询反复读 profile。 */
const DSH_TTL_MS = 1500;
/** 代理自带的内部路由。 */
const PROXY_STATUS_PATH = "/__proxy/status";
const PROXY_SELFTEST_PATH = "/__proxy/selftest";
/** 面板路由。 */
const ROUTE_STATUS = "/relay-bridge/status";
const ROUTE_PROXY = "/relay-bridge/proxy";
const ROUTE_CONFIG = "/relay-bridge/config";
const ROUTE_RESET = "/relay-bridge/reset";
const ROUTE_MODELS = "/relay-bridge/models";

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

/** 错误对象转字符串。 */
function messageOf(error) {
	return String(error && error.message ? error.message : error);
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
 * 规范化上游地址：保留路径前缀（`https://host/v1` 这类网关很常见），去掉结尾斜杠。
 * @param {unknown} value - 配置值。
 * @returns {string} 形如 https://host[/path] 的上游地址，无法识别时为空串。
 */
function normalizeUpstream(value) {
	const raw = typeof value === "string" ? value.trim() : "";
	if (raw.length === 0) return DEFAULT_UPSTREAM;
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_UPSTREAM;
		const prefix = url.pathname.replace(/\/+$/, "");
		return `${url.protocol}//${url.host}${prefix}`;
	} catch {
		return DEFAULT_UPSTREAM;
	}
}

/** 本插件的监听地址。 */
function listenAddress(runtime) {
	return `http://${LISTEN_HOST}:${runtime.port}`;
}

/**
 * 判断一个 baseURL 是否已经指向本插件的监听地址（允许带 provider 路径前缀）。
 * @param {unknown} value - provider 的 baseURL。
 * @param {number} port - 监听端口。
 * @returns {boolean} 是否指向本代理。
 */
function isListenUrl(value, port) {
	if (typeof value !== "string" || value.length === 0) return false;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		const host = url.hostname.toLowerCase();
		if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") return false;
		const actual = url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
		return actual === port;
	} catch {
		return false;
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

/** 模型 ↔ 上游映射文件路径。 */
function mappingFile() {
	return path.join(stateDir(), "routing.json");
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
/* 模型 ↔ 上游映射                                                     */
/* ------------------------------------------------------------------ */

/**
 * 规范化映射表。
 * @param {unknown} raw - 磁盘内容。
 * @returns {{version: number, updatedAt: string | null, providers: Record<string, object>}} 映射表。
 */
function normalizeMapping(raw) {
	const out = { version: 1, updatedAt: null, providers: {} };
	if (!raw || typeof raw !== "object") return out;
	if (typeof raw.updatedAt === "string") out.updatedAt = raw.updatedAt;
	const providers = raw.providers && typeof raw.providers === "object" ? raw.providers : {};
	for (const [pid, value] of Object.entries(providers)) {
		if (!pid || !value || typeof value !== "object") continue;
		const entry = {
			id: pid,
			displayName: typeof value.displayName === "string" && value.displayName.length > 0 ? value.displayName : pid,
			api: typeof value.api === "string" ? value.api : "",
			original: normalizeUpstream(value.original),
			upstream: normalizeUpstream(value.upstream),
			covered: value.covered === true,
			models: {},
		};
		const models = value.models && typeof value.models === "object" ? value.models : {};
		for (const [mid, row] of Object.entries(models)) {
			if (!mid) continue;
			const source = row && typeof row === "object" && row.source === "manual" ? "manual" : "original";
			const upstream = row && typeof row === "object" ? normalizeUpstream(row.upstream) : "";
			const original = row && typeof row === "object" ? normalizeUpstream(row.original) : "";
			entry.models[mid] = {
				id: mid,
				upstream,
				original,
				source,
				updatedAt: row && typeof row === "object" && typeof row.updatedAt === "string" ? row.updatedAt : null,
			};
		}
		out.providers[pid] = entry;
	}
	return out;
}

/** 读取映射表（缺失时返回空表）。 */
function loadMapping() {
	try {
		return normalizeMapping(JSON.parse(fs.readFileSync(mappingFile(), "utf8")));
	} catch {
		return normalizeMapping(undefined);
	}
}

/** 把映射表写盘。 */
function saveMapping(mapping) {
	const dir = stateDir();
	fs.mkdirSync(dir, { recursive: true });
	const payload = normalizeMapping(mapping);
	payload.updatedAt = new Date().toISOString();
	mapping.updatedAt = payload.updatedAt;
	fs.writeFileSync(mappingFile(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	return payload;
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
 * 改写已解析的请求体。
 * @param {object} body - 已解析的请求体对象（不会被就地修改）。
 * @param {"move"|"copy"} mode - 改写方式。
 * @returns {object | undefined} 改写后的请求体，或 undefined 表示无需改写。
 */
function rewriteBodyObject(body, mode) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
	const next = body.system !== undefined ? foldAnthropic(body, mode) : foldOpenAI(body, mode);
	if (next === undefined) return undefined;
	if (JSON.stringify(next) === JSON.stringify(body)) return undefined;
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
	const next = rewriteBodyObject(body, mode);
	if (next === undefined) return undefined;
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
/* 上游解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从请求路径推断 API 形态，用于在同名模型（不同 provider）之间消歧。
 * @param {string} pathname - 代理收到的路径。
 * @returns {string} API 形态，未知时为空串。
 */
function apiShapeOfPath(pathname) {
	if (typeof pathname !== "string") return "";
	if (/\/chat\/completions$/.test(pathname) || /\/completions$/.test(pathname)) return "openai-completions";
	if (/\/responses$/.test(pathname)) return "openai-responses";
	if (/\/messages$/.test(pathname)) return "anthropic-messages";
	return "";
}

/**
 * 把上游前缀和请求路径拼成一个完整 URL。
 *
 * 上游可以带路径（`https://gateway.example/anthropic` 这类前缀很常见），这时
 * 请求路径要接在前缀后面而不是把前缀顶掉，所以不能直接用 `new URL(path, base)`。
 * @param {string} upstream - 上游地址（可能带路径前缀）。
 * @param {string} pathname - 代理收到的路径（已去掉 provider 前缀）。
 * @param {string} [search] - 查询串（含 `?`）。
 * @returns {URL} 完整目标地址。
 */
function joinUpstream(upstream, pathname, search = "") {
	const base = new URL(upstream);
	const prefix = base.pathname.replace(/\/+$/, "");
	const suffix = pathname.length > 0 ? pathname : "/";
	base.pathname = `${prefix}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
	base.search = search;
	return base;
}

/**
 * 从映射表里挑出这次请求应该走的真实上游。
 *
 * 优先级：路由头（覆盖时写入的 provider id）→ 路径前缀 `/<provider>/...` →
 * 请求体里的 model（同名时用 API 形态消歧）→ 面板里的默认上游。
 * @param {object} state - 安装状态。
 * @param {{provider?: string, model?: string, pathname?: string}} context - 请求线索。
 * @returns {{upstream: string, provider: string, model: string, via: string}} 路由结果。
 */
function resolveRoute(state, context) {
	const mapping = state.mapping.providers;
	const model = typeof context.model === "string" ? context.model : "";
	const pick = (pid) => {
		const entry = mapping[pid];
		if (!entry) return "";
		if (model.length > 0 && entry.models[model] !== undefined) {
			const row = entry.models[model];
			if (row.upstream.length > 0) return row.upstream;
			if (row.original.length > 0) return row.original;
		}
		return entry.upstream || entry.original || "";
	};
	const provider = typeof context.provider === "string" ? context.provider : "";
	if (provider.length > 0) {
		const upstream = pick(provider);
		if (upstream.length > 0) return { upstream, provider, model, via: "provider" };
	}
	if (model.length > 0) {
		const shape = apiShapeOfPath(context.pathname ?? "");
		const candidates = Object.entries(mapping).filter(([, entry]) => entry.models[model] !== undefined);
		const filtered = shape.length > 0 ? candidates.filter(([, entry]) => entry.api === shape) : [];
		const pool = filtered.length > 0 ? filtered : candidates;
		if (pool.length === 1) {
			const [pid] = pool[0];
			const upstream = pick(pid);
			if (upstream.length > 0) return { upstream, provider: pid, model, via: "model" };
		}
	}
	if (state.runtime.upstream.length > 0) return { upstream: state.runtime.upstream, provider, model, via: "default" };
	return { upstream: "", provider, model, via: "none" };
}

/**
 * 从 baseURL / 请求路径里取出 provider id：支持 `http://127.0.0.1:8790/<provider>` 这种写法。
 * @param {object} state - 安装状态。
 * @param {string} pathname - 代理收到的路径。
 * @returns {{provider: string | undefined, pathname: string}} 拆分结果。
 */
function splitProviderPath(state, pathname) {
	const match = /^\/([^/]+)(\/.*)?$/.exec(pathname);
	if (match === null) return { provider: undefined, pathname };
	let candidate = match[1];
	try {
		candidate = decodeURIComponent(candidate);
	} catch {
		/* 非法转义按原样处理 */
	}
	if (!Object.hasOwn(state.mapping.providers, candidate)) return { provider: undefined, pathname };
	return { provider: candidate, pathname: match[2] && match[2].length > 0 ? match[2] : "/" };
}

/* ------------------------------------------------------------------ */
/* DSH 模型设置读写                                                    */
/* ------------------------------------------------------------------ */

/**
 * 拆开 schemastery 的 volatile 包装（`{get: () => value}`）。
 * @param {unknown} value - 可能被包装的值。
 * @returns {unknown} 解开后的值。
 */
function unwrapVolatile(value) {
	let node = value;
	for (let depth = 0; depth < 4; depth += 1) {
		if (!node || typeof node !== "object") return node;
		const getter = Reflect.get(node, "get");
		if (typeof getter !== "function") return node;
		try {
			node = getter.call(node);
		} catch {
			return node;
		}
	}
	return node;
}

/**
 * 从 live config / settings 表单里挑出 llm-pi-ai 的 providers 表。
 * @param {unknown} value - 形如 `{providers: {...}}` 的配置。
 * @returns {Record<string, object> | undefined} providers 表；不是 pi-ai 配置时返回 undefined。
 */
function providersOf(value) {
	const node = unwrapVolatile(value);
	if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
	const providers = unwrapVolatile(Reflect.get(node, "providers"));
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
	return providers;
}

/** loader entry id 是否指向 pi-ai 适配器。 */
function isPiAiId(id) {
	return typeof id === "string" && /llm-pi-ai$/.test(id);
}

/**
 * 读取 DSH 当前的 provider 表（面板显示与路由兜底都用它）。
 * @param {object} state - 安装状态。
 * @param {boolean} [force] - 跳过缓存。
 * @returns {Promise<{ok: boolean, ns: string, providers: Record<string, object>, source: string, error: string | null}>} 结果。
 */
async function readDshProviders(state, force = false) {
	const now = Date.now();
	if (!force && state.dshCache !== undefined && now - state.dshCache.at < DSH_TTL_MS) return state.dshCache.value;
	const finish = (value) => {
		state.dshCache = { at: Date.now(), value };
		return value;
	};
	const fail = (error) => finish({ ok: false, ns: "", providers: {}, source: "none", error });
	const editor = state.host?.configEditor;
	if (editor && typeof editor.entries === "function") {
		try {
			const rows = [...editor.entries()];
			const ordered = rows.filter((entry) => isPiAiId(entry?.options?.id)).concat(rows.filter((entry) => !isPiAiId(entry?.options?.id)));
			for (const entry of ordered) {
				const providers = providersOf(entry && entry.fiber ? entry.fiber.config : undefined);
				if (providers === undefined) continue;
				return finish({ ok: true, ns: String(entry.options?.id ?? ""), providers, source: "configEditor", error: null });
			}
		} catch (error) {
			return fail(messageOf(error));
		}
	}
	const settings = state.host?.settings;
	if (settings && typeof settings.describe === "function") {
		try {
			const rows = await settings.describe({});
			for (const row of Array.isArray(rows) ? rows : []) {
				const providers = providersOf(row && row.value);
				if (providers === undefined) continue;
				return finish({ ok: true, ns: String(row.ns ?? ""), providers, source: "settings", error: null });
			}
		} catch (error) {
			return fail(messageOf(error));
		}
	}
	if (!editor) return fail("configEditor 服务不可用（非 profile 模式，或配置编辑器未启用）");
	return finish({ ok: false, ns: "", providers: {}, source: "none", error: "未在 DSH 配置里找到 llm-pi-ai 的 providers" });
}

/**
 * 把 providers 表写回 profile（走 configEditor 的验证 + 热重载通道）。
 * @param {object} state - 安装状态。
 * @param {object} entry - 承载 providers 的 loader entry。
 * @param {(providers: Record<string, object>) => Record<string, object> | undefined} mutate - 在最新配置上做改动。
 * @returns {Promise<{ok: boolean, error: string | null}>} 结果。
 */
async function writeDshProviders(state, entry, mutate) {
	const editor = state.host?.configEditor;
	if (!editor || typeof editor.edit !== "function") {
		return { ok: false, error: "configEditor 服务不可用，无法改写 DSH 模型设置" };
	}
	if (entry === undefined) return { ok: false, error: "未在 DSH 配置里找到 llm-pi-ai 的 providers" };
	let failure = null;
	try {
		await editor.edit(entry, (current) => {
			const base = current && typeof current === "object" ? current : {};
			const source = base.providers && typeof base.providers === "object" ? base : entry;
			const providers = rawProvidersOf(source, providersOf(entry?.fiber?.config) ?? {});
			const next = mutate(providers);
			if (next === undefined) return base;
			return { ...base, providers: next };
		});
	} catch (error) {
		failure = messageOf(error);
	}
	state.dshCache = undefined;
	return failure === null ? { ok: true, error: null } : { ok: false, error: failure };
}

/** 把 live providers 里的模型 id 列出来。 */
function modelIdsOf(profile) {
	const models = profile && Array.isArray(profile.models) ? profile.models : [];
	const out = [];
	for (const model of models) {
		if (typeof model === "string" && model.length > 0) out.push({ id: model, name: model });
		else if (model && typeof model === "object" && typeof model.id === "string" && model.id.length > 0) {
			out.push({ id: model.id, name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id });
		}
	}
	return out;
}

/** 深拷贝成纯对象：live 配置里的 providers 是 schemastery 冻结包装，直接写会抛只读错误。 */
function deepPlain(value) {
	if (Array.isArray(value)) return value.map((item) => deepPlain(item));
	if (value !== null && typeof value === "object") {
		const copy = {};
		for (const [key, item] of Object.entries(value)) copy[key] = deepPlain(item);
		return copy;
	}
	return value;
}

/** 取原始（未解析）的 providers 表，用于写回；拿不到时退回 live 表，两种情况都返回全新的纯对象副本。 */
function rawProvidersOf(entry, providers) {
	const raw = entry && entry.options && entry.options.config;
	// entry.options.config 有时也带着 schemastery 的 volatile 包装，交给 providersOf 统一拆。
	const source = providersOf(raw) ?? providers;
	const copy = {};
	for (const [pid, profile] of Object.entries(source ?? {})) {
		if (profile === null || typeof profile !== "object") continue;
		copy[pid] = deepPlain(profile);
	}
	return copy;
}

/** 找到承载 providers 的 loader entry（写入需要 entry，而不是 id）。 */
function providerEntry(state) {
	const editor = state.host?.configEditor;
	if (!editor || typeof editor.entries !== "function") return undefined;
	try {
		for (const entry of editor.entries()) {
			if (providersOf(entry && entry.fiber ? entry.fiber.config : undefined) !== undefined) return entry;
		}
	} catch {
		/* 找不到就返回 undefined */
	}
	return undefined;
}

/**
 * 覆盖：把每个 provider 的 baseURL 指到本插件，并写入内部路由头。
 * @param {object} state - 安装状态。
 * @param {string[] | undefined} ids - 只覆盖这些 provider；缺省为全部。
 * @returns {Promise<{ok: boolean, covered: string[], error: string | null}>} 结果。
 */
async function coverProviders(state, ids) {
	const live = await readDshProviders(state, true);
	if (!live.ok) return { ok: false, covered: [], error: live.error };
	const entry = providerEntry(state);
	if (entry === undefined) return { ok: false, covered: [], error: "configEditor 服务不可用，无法改写 DSH 模型设置" };
	const listen = listenAddress(state.runtime);
	const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids.filter((id) => typeof id === "string")) : undefined;
	const mapping = state.mapping;
	const covered = [];
	const written = await writeDshProviders(state, entry, (raw) => {
		for (const [pid, profile] of Object.entries(raw)) {
			if (wanted !== undefined && !wanted.has(pid)) continue;
			const current = profile && typeof profile === "object" ? { ...profile } : {};
			const baseURL = typeof current.baseURL === "string" ? current.baseURL : "";
			const original = isListenUrl(baseURL, state.runtime.port) ? "" : normalizeUpstream(baseURL);
			const existing = mapping.providers[pid] ?? {
				id: pid,
				displayName: pid,
				api: "",
				original: "",
				upstream: "",
				covered: false,
				models: {},
			};
			const keepOriginal = original.length > 0 ? original : existing.original;
			const api = typeof current.api === "string" ? current.api : existing.api;
			const displayName = typeof current.displayName === "string" && current.displayName.length > 0 ? current.displayName : pid;
			const models = {};
			for (const model of modelIdsOf(live.providers[pid] ?? current)) {
				const row = existing.models[model.id];
				models[model.id] = {
					id: model.id,
					upstream: row && row.upstream.length > 0 ? row.upstream : keepOriginal,
					original: row && row.original.length > 0 ? row.original : keepOriginal,
					source: row && row.source === "manual" ? "manual" : "original",
					updatedAt: row ? row.updatedAt : null,
				};
			}
			mapping.providers[pid] = {
				id: pid,
				displayName,
				api,
				original: keepOriginal,
				upstream: existing.upstream || keepOriginal,
				covered: true,
				models,
			};
			current.baseURL = listen;
			const headers = current.headers && typeof current.headers === "object" ? { ...current.headers } : {};
			headers[ROUTE_HEADER] = pid;
			current.headers = headers;
			raw[pid] = current;
			covered.push(pid);
		}
		return covered.length > 0 ? raw : undefined;
	});
	if (!written.ok) return { ok: false, covered: [], error: written.error };
	if (covered.length === 0) return { ok: true, covered, error: null };
	saveMapping(mapping);
	state.logger.info(`api-relay-bridge: 已覆盖 ${covered.length} 个 provider 的 baseURL → ${listen}`);
	return { ok: true, covered, error: null };
}

/**
 * 还原：把 baseURL 写回覆盖前记录的上游地址，并移除内部路由头。
 * @param {object} state - 安装状态。
 * @param {string[] | undefined} ids - 只还原这些 provider；缺省为全部。
 * @returns {Promise<{ok: boolean, restored: string[], skipped: string[], error: string | null}>} 结果。
 */
async function uncoverProviders(state, ids) {
	const live = await readDshProviders(state, true);
	if (!live.ok) return { ok: false, restored: [], skipped: [], error: live.error };
	const entry = providerEntry(state);
	if (entry === undefined) return { ok: false, restored: [], skipped: [], error: "configEditor 服务不可用，无法改写 DSH 模型设置" };
	const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids.filter((id) => typeof id === "string")) : undefined;
	const restored = [];
	const skipped = [];
	const written = await writeDshProviders(state, entry, (raw) => {
		for (const [pid, profile] of Object.entries(raw)) {
			if (wanted !== undefined && !wanted.has(pid)) continue;
			const current = profile && typeof profile === "object" ? { ...profile } : {};
			const record = state.mapping.providers[pid];
			const target = record ? record.original || record.upstream : normalizeUpstream(current.baseURL);
			if (target.length === 0) {
				skipped.push(pid);
				continue;
			}
			current.baseURL = target;
			if (current.headers && typeof current.headers === "object") {
				const headers = { ...current.headers };
				delete headers[ROUTE_HEADER];
				if (Object.keys(headers).length === 0) delete current.headers;
				else current.headers = headers;
			}
			if (record) record.covered = false;
			raw[pid] = current;
			restored.push(pid);
		}
		return restored.length > 0 ? raw : undefined;
	});
	if (!written.ok) return { ok: false, restored: [], skipped, error: written.error };
	if (restored.length === 0) return { ok: true, restored, skipped, error: null };
	saveMapping(state.mapping);
	state.logger.info(`api-relay-bridge: 已还原 ${restored.length} 个 provider 的 baseURL`);
	return { ok: true, restored, skipped, error: null };
}

/**
 * 修改某个模型的上游地址（只动插件映射，DSH 侧 baseURL 已经指向本代理）。
 * @param {object} state - 安装状态。
 * @param {string} pid - provider id。
 * @param {string} mid - 模型 id。
 * @param {string} upstream - 新的上游 origin；空串表示恢复原始地址。
 * @returns {{ok: boolean, error: string | null}} 结果。
 */
function setModelUpstream(state, pid, mid, upstream) {
	if (typeof pid !== "string" || pid.length === 0) return { ok: false, error: "缺少 provider" };
	if (typeof mid !== "string" || mid.length === 0) return { ok: false, error: "缺少模型 id" };
	const normalized = normalizeUpstream(upstream);
	if (typeof upstream === "string" && upstream.trim().length > 0 && normalized.length === 0) {
		return { ok: false, error: "上游地址必须是 http(s) 的完整 URL" };
	}
	const provider = state.mapping.providers[pid] ?? { id: pid, displayName: pid, api: "", original: "", upstream: "", covered: false, models: {} };
	const row = provider.models[mid] ?? { id: mid, upstream: "", original: provider.original, source: "original", updatedAt: null };
	row.upstream = normalized.length > 0 ? normalized : row.original || provider.original;
	row.source = typeof upstream === "string" && upstream.trim().length > 0 && normalized !== (row.original || provider.original) ? "manual" : "original";
	row.updatedAt = new Date().toISOString();
	provider.models[mid] = row;
	state.mapping.providers[pid] = provider;
	saveMapping(state.mapping);
	return { ok: true, error: null };
}

/**
 * 删除一个模型：同时清掉映射行和 DSH 模型设置里的模型。
 * @param {object} state - 安装状态。
 * @param {string} pid - provider id。
 * @param {string} mid - 模型 id。
 * @returns {Promise<{ok: boolean, removedProvider: boolean, error: string | null, warning: string | null}>} 结果。
 */
async function deleteModelRoute(state, pid, mid) {
	if (typeof pid !== "string" || pid.length === 0) return { ok: false, removedProvider: false, error: "缺少 provider", warning: null };
	if (typeof mid !== "string" || mid.length === 0) return { ok: false, removedProvider: false, error: "缺少模型 id", warning: null };
	const live = await readDshProviders(state, true);
	if (!live.ok) return { ok: false, removedProvider: false, error: live.error, warning: null };
	const entry = providerEntry(state);
	if (entry === undefined) return { ok: false, removedProvider: false, error: "configEditor 服务不可用，无法改写 DSH 模型设置", warning: null };
	let removedProvider = false;
	let missing = false;
	const written = await writeDshProviders(state, entry, (raw) => {
		const profile = raw[pid];
		if (!profile || typeof profile !== "object") {
			missing = true;
			return undefined;
		}
		const models = Array.isArray(profile.models)
			? profile.models.filter((model) => {
					const id = typeof model === "string" ? model : model && typeof model === "object" ? model.id : undefined;
					return id !== mid;
				})
			: [];
		if (models.length === 0) {
			delete raw[pid];
			removedProvider = true;
		} else {
			raw[pid] = { ...profile, models };
		}
		return raw;
	});
	if (missing) return { ok: false, removedProvider: false, error: `provider "${pid}" 不存在`, warning: null };
	if (!written.ok) return { ok: false, removedProvider: false, error: written.error, warning: null };
	if (state.mapping.providers[pid] !== undefined) {
		delete state.mapping.providers[pid].models[mid];
		if (removedProvider) delete state.mapping.providers[pid];
		saveMapping(state.mapping);
	}
	let warning = null;
	try {
		for (const item of state.host?.configEditor?.entries?.() ?? []) {
			const config = item && item.options ? item.options.config : undefined;
			if (!config || typeof config !== "object" || Array.isArray(config)) continue;
			if (config.provider === pid && config.model === mid) {
				warning = `默认模型仍指向 ${pid}/${mid}，请在 DSH 设置里换一个默认模型`;
			}
		}
	} catch {
		/* 默认模型检查失败不影响删除结果 */
	}
	state.logger.info(`api-relay-bridge: 已删除模型 ${pid}/${mid}${removedProvider ? "（provider 已无模型，整条移除）" : ""}`);
	return { ok: true, removedProvider, error: null, warning };
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
		address: proxy.server !== null ? `${LISTEN_HOST}:${state.runtime.port}` : "",
		listen: listenAddress(state.runtime),
		port: state.runtime.port,
		upstream: state.runtime.upstream,
		defaultUpstream: state.runtime.upstream,
		mode: state.runtime.mode,
		startedAt: proxy.startedAt,
		stats: { ...proxy.stats, byProvider: { ...(proxy.stats.byProvider ?? {}) } },
		lastError: proxy.lastError,
		lastRoute: proxy.lastRoute ?? null,
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
		sendJson(res, 413, { ok: false, error: messageOf(error) });
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

/** 转发一次请求到解析出来的上游（流式）。 */
async function forward(state, req, res) {
	const settings = state.runtime;
	const proxy = state.proxy;
	let body;
	try {
		body = await readAll(req, MAX_FORWARD_BYTES);
	} catch (error) {
		proxy.stats.errors += 1;
		proxy.lastError = messageOf(error);
		sendJson(res, 413, { error: proxy.lastError });
		return;
	}

	const method = String(req.method ?? "GET").toUpperCase();
	const rawPath = req.url ?? "/";
	let pathname = "/";
	try {
		pathname = new URL(rawPath, "http://127.0.0.1").pathname;
	} catch {
		pathname = "/";
	}
	const prefixed = splitProviderPath(state, pathname);
	const headerRoute = req.headers[ROUTE_HEADER];
	const providerHint =
		prefixed.provider ?? (typeof headerRoute === "string" && headerRoute.length > 0 ? headerRoute : undefined);
	const search = (() => {
		try {
			return new URL(rawPath, "http://127.0.0.1").search;
		} catch {
			return "";
		}
	})();

	let payload = body;
	let rewritten = false;
	let modelId;
	let systemChars = 0;
	if (method === "POST" && body.length > 0) {
		const text = body.toString("utf8");
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			if (typeof parsed.model === "string") modelId = parsed.model;
			systemChars = flattenSystem(parsed.system).text.length;
			const next = rewriteBodyObject(parsed, settings.mode);
			if (next !== undefined) {
				payload = Buffer.from(JSON.stringify(next), "utf8");
				rewritten = true;
			}
		}
	}

	const route = resolveRoute(state, { provider: providerHint, model: modelId, pathname: prefixed.pathname });
	if (route.upstream.length === 0) {
		proxy.stats.errors += 1;
		proxy.lastError = modelId ? `模型 "${modelId}" 没有可用的上游地址` : "未配置上游地址";
		sendJson(res, 503, {
			error: "upstream not configured",
			detail: proxy.lastError,
			model: modelId ?? null,
			provider: providerHint ?? null,
			hint: "在「中转站桥」面板点「覆盖」，或给该模型填写上游地址",
		});
		return;
	}

	proxy.stats.requests += 1;
	if (rewritten) {
		proxy.stats.rewrites += 1;
		proxy.stats.bytesSaved = (proxy.stats.bytesSaved ?? 0) + (payload.length - body.length);
		proxy.stats.lastAt = new Date().toISOString();
		record(state, {
			at: proxy.stats.lastAt,
			host: new URL(route.upstream).host,
			provider: route.provider,
			model: route.model,
			systemChars,
			mode: settings.mode,
			via: "proxy",
		});
	}
	if (route.provider.length > 0) {
		const counts = proxy.stats.byProvider ?? (proxy.stats.byProvider = {});
		counts[route.provider] = (counts[route.provider] ?? 0) + 1;
	}
	proxy.lastRoute = {
		at: new Date().toISOString(),
		provider: route.provider,
		model: route.model,
		upstream: route.upstream,
		via: route.via,
	};

	let target;
	try {
		target = joinUpstream(route.upstream, prefixed.pathname, search);
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
	delete headers[ROUTE_HEADER];
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
				proxy.lastError = messageOf(error);
				upstreamRes.destroy();
				return;
			}
			upstreamRes.pipe(res);
			upstreamRes.on("error", (error) => {
				proxy.stats.errors += 1;
				proxy.lastError = messageOf(error);
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
		proxy.lastError = messageOf(error);
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
			state.proxy.lastError = messageOf(error);
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
		state.proxy.lastError = `client error: ${messageOf(error)}`;
		if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
	});
	return new Promise((resolve, reject) => {
		server.once("error", (error) => {
			state.proxy.lastError = messageOf(error);
			reject(error);
		});
		server.listen(state.runtime.port, LISTEN_HOST, () => {
			server.removeAllListeners("error");
			server.on("error", (error) => {
				state.proxy.lastError = messageOf(error);
				state.logger.warn(`api-relay-bridge: 代理服务器错误（${state.proxy.lastError}）`);
			});
			state.proxy.server = server;
			state.proxy.startedAt = new Date().toISOString();
			state.proxy.lastError = null;
			const routes = Object.keys(state.mapping.providers).length;
			state.logger.info(
				`api-relay-bridge: 代理已监听 ${listenAddress(state.runtime)}（mode=${state.runtime.mode}，路由 ${routes} 个 provider，默认上游 ${state.runtime.upstream || "未设置"}）`
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
			state.logger.info(`api-relay-bridge: 代理已停止（${LISTEN_HOST}:${state.runtime.port}）`);
			resolve(proxySnapshot(state));
		});
		setTimeout(() => resolve(proxySnapshot(state)), 500);
	});
}

/** TCP 端口连通性探测。 */
function probePort(port, timeoutMs = 1500) {
	return new Promise((resolve) => {
		const socket = net.connect({ host: LISTEN_HOST, port });
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
function probeUpstream(upstream, timeoutMs = 6000) {
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
				{
					protocol: url.protocol,
					hostname: url.hostname,
					port: url.port || (url.protocol === "https:" ? 443 : 80),
					path: url.pathname.length > 0 ? url.pathname : "/",
					method: "GET",
					timeout: timeoutMs,
				},
				(res) => {
					res.resume();
					finish(true, `HTTP ${res.statusCode ?? 0}`);
				}
			);
			req.setTimeout(timeoutMs, () => {
				req.destroy(new Error("timeout"));
				finish(false, "连接超时");
			});
			req.on("error", (error) => finish(false, messageOf(error)));
			req.end();
		} catch (error) {
			finish(false, messageOf(error));
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
				host: LISTEN_HOST,
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
		req.on("error", (error) => resolve({ ok: false, detail: messageOf(error), ms: Date.now() - started }));
		req.end(body);
	});
}

/**
 * 检测各 provider 的 baseURL 是否已指向本代理，不是就自动改。
 * @param {object} state - 安装状态。
 * @returns {Promise<{ok: boolean, detail: string, fixed: string[], pending: string[], error: string | null}>} 结果。
 */
async function ensureCoverage(state) {
	const live = await readDshProviders(state, true);
	if (!live.ok) {
		return { ok: false, detail: live.error ?? "读不到 DSH 模型设置", fixed: [], pending: [], error: live.error };
	}
	const listen = listenAddress(state.runtime);
	const providers = Object.entries(live.providers);
	if (providers.length === 0) return { ok: true, detail: "DSH 里没有 provider", fixed: [], pending: [], error: null };
	const pending = providers.filter(([, profile]) => !isListenUrl(profile && profile.baseURL, state.runtime.port)).map(([pid]) => pid);
	if (pending.length === 0) {
		return { ok: true, detail: `${providers.length} 个 provider 的 baseURL 均已指向 ${listen}`, fixed: [], pending: [], error: null };
	}
	const covered = await coverProviders(state, pending);
	if (!covered.ok) {
		return { ok: false, detail: `${pending.length} 个 provider 未指向代理，自动改写失败：${covered.error}`, fixed: [], pending, error: covered.error };
	}
	return {
		ok: true,
		detail: `已自动把 ${pending.length} 个 provider（${pending.join("、")}）的 baseURL 改写为 ${listen}`,
		fixed: pending,
		pending: [],
		error: null,
	};
}

/**
 * 跑一次完整检测：端口、baseURL 覆盖、上游可达、改写管线。
 * @param {object} state - 安装状态。
 * @returns {Promise<Record<string, unknown>>} 检测结果。
 */
async function runCheck(state) {
	const port = state.runtime.port;
	const portResult = await probePort(port);
	const coverage = await ensureCoverage(state);
	const upstreams = [...new Set(Object.values(state.mapping.providers).map((entry) => entry.upstream || entry.original).filter((value) => typeof value === "string" && value.length > 0))];
	if (state.runtime.upstream.length > 0 && !upstreams.includes(state.runtime.upstream)) upstreams.push(state.runtime.upstream);
	const probes = await Promise.all(upstreams.map((upstream) => probeUpstream(upstream)));
	const upstreamOk = upstreams.length > 0 && probes.every((probe) => probe.ok);
	const upstreamDetail =
		upstreams.length === 0
			? "没有任何上游地址（先点「覆盖」）"
			: probes.map((probe, index) => `${upstreams[index]} ${probe.detail} ${probe.ms}ms`).join(" ｜ ");
	const pipelineResult = portResult.ok ? await probePipeline(port) : { ok: false, detail: "端口未监听，跳过", ms: 0 };
	const checks = [
		{ id: "listen", label: "代理端口", ok: portResult.ok, detail: portResult.ok ? `${LISTEN_HOST}:${port} 已监听` : `${portResult.detail}` },
		{ id: "coverage", label: "baseURL 覆盖", ok: coverage.ok, detail: coverage.detail },
		{ id: "upstream", label: "上游可达", ok: upstreamOk, detail: upstreamDetail },
		{ id: "rewrite", label: "改写管线", ok: pipelineResult.ok, detail: `${pipelineResult.detail} · ${pipelineResult.ms}ms` },
	];
	const ok = checks.every((item) => item.ok);
	state.proxy.check = { at: new Date().toISOString(), ok, checks, coverage };
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
 * 把映射表和 DSH 实时配置合并成面板要用的行。
 * @param {object} state - 安装状态。
 * @param {object} dsh - readDshProviders 结果。
 * @returns {Record<string, unknown>} 路由快照。
 */
function routingSnapshot(state, dsh) {
	const listen = listenAddress(state.runtime);
	const rows = [];
	const providers = [];
	const live = dsh.ok ? dsh.providers : {};
	const seen = new Set();
	for (const [pid, profile] of Object.entries(live)) {
		const record = state.mapping.providers[pid];
		const baseURL = typeof profile?.baseURL === "string" ? profile.baseURL : "";
		const covered = isListenUrl(baseURL, state.runtime.port);
		const providerUpstream = record ? record.upstream || record.original : normalizeUpstream(baseURL);
		const models = modelIdsOf(profile);
		providers.push({
			id: pid,
			displayName: typeof profile?.displayName === "string" && profile.displayName.length > 0 ? profile.displayName : pid,
			api: typeof profile?.api === "string" ? profile.api : "",
			baseURL,
			covered,
			upstream: providerUpstream,
			original: record ? record.original : "",
			models: models.length,
		});
		for (const model of models) {
			const row = record?.models?.[model.id];
			rows.push({
				key: `${pid}::${model.id}`,
				provider: pid,
				providerName: typeof profile?.displayName === "string" && profile.displayName.length > 0 ? profile.displayName : pid,
				api: typeof profile?.api === "string" ? profile.api : "",
				model: model.id,
				modelName: model.name,
				baseURL,
				covered,
				upstream: row && row.upstream.length > 0 ? row.upstream : providerUpstream,
				original: row && row.original.length > 0 ? row.original : record ? record.original : "",
				source: row ? row.source : "original",
				missing: !record,
			});
			seen.add(`${pid}::${model.id}`);
		}
	}
	for (const [pid, record] of Object.entries(state.mapping.providers)) {
		if (live[pid] !== undefined) continue;
		for (const [mid, row] of Object.entries(record.models)) {
			if (seen.has(`${pid}::${mid}`)) continue;
			rows.push({
				key: `${pid}::${mid}`,
				provider: pid,
				providerName: record.displayName || pid,
				api: record.api,
				model: mid,
				modelName: mid,
				baseURL: "",
				covered: false,
				upstream: row.upstream || record.upstream || record.original,
				original: row.original || record.original,
				source: row.source,
				stale: true,
				missing: false,
			});
		}
	}
	const coveredCount = providers.filter((provider) => provider.covered).length;
	return {
		listen,
		header: ROUTE_HEADER,
		dsh: { ok: dsh.ok, ns: dsh.ns, source: dsh.source, error: dsh.error },
		defaults: { upstream: state.runtime.upstream },
		rows,
		providers,
		stats: {
			models: rows.length,
			covered: coveredCount,
			providers: providers.length,
			uncovered: providers.length - coveredCount,
			mapped: rows.filter((row) => row.source === "manual").length,
		},
		updatedAt: state.mapping.updatedAt,
	};
}

/**
 * 构造面板读取的状态快照。
 * @param {object} state - 安装状态。
 * @returns {Promise<Record<string, unknown>>} 快照。
 */
async function snapshot(state) {
	const layer = await layering(state);
	const dsh = await readDshProviders(state);
	return {
		plugin: PLUGIN,
		version: VERSION,
		proxy: proxySnapshot(state),
		check: state.proxy.check ?? null,
		routing: routingSnapshot(state, dsh),
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
				state.logger.warn(`api-relay-bridge: 状态路由失败（${messageOf(error)}）`);
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
				if (action === "cover") {
					const ids = Array.isArray(body.providers) ? body.providers : undefined;
					const covered = await coverProviders(state, ids);
					// 覆盖之后 provider 的 baseURL 已经指向本代理，代理必须同时在监听，否则下次请求会连接被拒。
					if (covered.ok && covered.covered.length > 0 && state.proxy.server === null) {
						state.runtime.enabled = true;
						saveOverrides(state.runtime);
						try {
							await startProxy(state);
						} catch (error) {
							state.logger.warn(`api-relay-bridge: 覆盖后启动代理失败（${messageOf(error)}）`);
						}
					}
					sendJson(res, 200, {
						action,
						ok: covered.ok,
						error: covered.error,
						covered: covered.covered,
						...(await snapshot(state)),
					});
					return;
				}
				if (action === "uncover") {
					const ids = Array.isArray(body.providers) ? body.providers : undefined;
					const restored = await uncoverProviders(state, ids);
					sendJson(res, 200, {
						action,
						ok: restored.ok,
						error: restored.error,
						restored: restored.restored,
						skipped: restored.skipped,
						...(await snapshot(state)),
					});
					return;
				}
				sendJson(res, 400, { error: `unknown action: ${action}` });
			} catch (error) {
				state.logger.warn(`api-relay-bridge: 代理控制失败（${messageOf(error)}）`);
				try {
					sendJson(res, 500, { error: messageOf(error) });
				} catch {
					/* 响应已结束 */
				}
			}
		},
	});

	mount({
		kind: "exact",
		path: ROUTE_MODELS,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { error: "method not allowed" });
				return;
			}
			try {
				const body = (await readJsonBody(req)) ?? {};
				const action = typeof body.action === "string" ? body.action : "";
				const provider = typeof body.provider === "string" ? body.provider : "";
				const model = typeof body.model === "string" ? body.model : "";
				if (action === "set-upstream") {
					const result = setModelUpstream(state, provider, model, typeof body.upstream === "string" ? body.upstream : "");
					sendJson(res, 200, { action, ok: result.ok, error: result.error, ...(await snapshot(state)) });
					return;
				}
				if (action === "delete-model") {
					const result = await deleteModelRoute(state, provider, model);
					sendJson(res, 200, {
						action,
						ok: result.ok,
						error: result.error,
						warning: result.warning,
						removedProvider: result.removedProvider,
						...(await snapshot(state)),
					});
					return;
				}
				if (action === "refresh") {
					state.dshCache = undefined;
					sendJson(res, 200, { action, ok: true, ...(await snapshot(state)) });
					return;
				}
				sendJson(res, 400, { error: `unknown action: ${action}` });
			} catch (error) {
				state.logger.warn(`api-relay-bridge: 模型路由操作失败（${messageOf(error)}）`);
				try {
					sendJson(res, 500, { error: messageOf(error) });
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
				if (changed.includes("port")) {
					await stopProxy(state);
					await startProxy(state);
				}
				if (changed.length > 0) {
					saveOverrides(state.runtime);
					state.logger.info(`api-relay-bridge: 面板更新配置 ${changed.join(", ")}`);
				}
				sendJson(res, 200, { changed, ...(await snapshot(state)) });
			} catch (error) {
				state.logger.warn(`api-relay-bridge: 配置路由失败（${messageOf(error)}）`);
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
			state.proxy.stats.byProvider = {};
			state.proxy.lastAt = null;
			state.proxy.lastError = null;
			state.proxy.check = null;
			state.proxy.lastRoute = null;
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
		shared.mapping = loadMapping();
		shared.host = shared.host ?? {};
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
		mapping: loadMapping(),
		host: {},
		dshCache: undefined,
		proxy: {
			server: null,
			startedAt: null,
			lastError: null,
			check: null,
			lastRoute: null,
			stats: { requests: 0, rewrites: 0, errors: 0, lastAt: null, byProvider: {} },
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
			state.logger.warn(`api-relay-bridge: 兜底拦截失败，按原请求放行（${messageOf(error)}）`);
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
		provider: "",
		model: typeof parsed.model === "string" ? parsed.model : "",
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
	if (state === undefined) return;
	ctx.inject(["configEditor"], (sub) => {
		state.host = state.host ?? {};
		state.host.configEditor = sub.configEditor;
		state.dshCache = undefined;
		return () => {
			if (state.host?.configEditor === sub.configEditor) state.host.configEditor = undefined;
			state.dshCache = undefined;
		};
	});
	ctx.inject(["settings"], (sub) => {
		state.host = state.host ?? {};
		state.host.settings = sub.settings;
		state.dshCache = undefined;
		return () => {
			if (state.host?.settings === sub.settings) state.host.settings = undefined;
			state.dshCache = undefined;
		};
	});
	const hasRoutes = Object.keys(state.mapping.providers).length > 0;
	if (runtime.enabled && runtime.upstream.length === 0 && !hasRoutes) {
		state.proxy.lastError = "未配置上游地址（upstream）";
		ctx.logger.warn("api-relay-bridge: 还没有任何上游地址，代理虽已监听但无法转发。请在面板点「覆盖」自动登记上游，或填写默认上游。");
	} else if (runtime.enabled) {
		startProxy(state).catch((error) => {
			ctx.logger.warn(`api-relay-bridge: 代理启动失败（${messageOf(error)}）`);
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
/** 不依赖其它服务（settings / configEditor / webServer 走动态 inject）。 */
export const inject = [];
