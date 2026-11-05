/*
 * dsh-api-relay-bridge — 客户端半边（中转站桥）。
 *
 * 在左侧栏注册一个全局面板图标（sidebar.panellist），并在主列注册同名面板
 * （main，key 与图标 id 一致）。面板显示本地代理的实时状态，提供检测/覆盖/还原/
 * 启用/停止动作，并在下方的「模型 · 上游对照表」里逐模型查看和修改上游地址、
 * 删除模型（与 DSH 模型设置同步）。所有改写与转发都在宿主半边完成。
 *
 * 数据回路：GET /relay-bridge/status 轮询；POST /relay-bridge/proxy 控制代理与
 * 覆盖；POST /relay-bridge/models 维护模型映射；POST /relay-bridge/config 提交
 * 配置；POST /relay-bridge/reset 清空统计。
 */
window.__ModuleLoader__.load({
  id: "dsh-api-relay-bridge",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;

    const PLUGIN_ID = "dsh-api-relay-bridge";
    const PANEL_ID = "api-relay-bridge";
    const PANEL_LABEL = "中转站桥";
    const POLL_MS = 2000;

    /* 图标：桥接/链路符号。ownerProps 给 size 与 active。 */
    function BridgeIcon(props) {
      const size = props && typeof props.size === "number" ? props.size : 18;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        h("path", { d: "M2 10.5h3.2M10.8 10.5H14" }),
        h("path", { d: "M5.2 10.5c0-2.1 1.2-3.6 2.8-3.6s2.8 1.5 2.8 3.6" }),
        h("path", { d: "M2 12.8h12" }),
        h("circle", { cx: 8, cy: 4.3, r: 1.4 })
      );
    }

    /* 样式：全部走宿主设计令牌，深浅色自动跟随。 */
    function Styles() {
      return h(
        "style",
        null,
        `
.ab-root{box-sizing:border-box;height:100%;overflow-y:auto;padding:18px 22px 40px;
  color:var(--dsw-alias-label-primary,#e2e8f0);font-size:13px;line-height:1.55;
  background:var(--dsw-alias-bg-module-platform,transparent);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.ab-wrap{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.ab-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ab-title{font-size:15px;font-weight:600;letter-spacing:.2px}
.ab-ver{font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);
  font-size:11px;color:var(--dsw-alias-label-tertiary,#94a3b8);font-variant-numeric:tabular-nums}
.ab-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;
  font-size:11px;border:1px solid var(--dsw-alias-border-l2,rgba(148,163,184,.35));
  color:var(--dsw-alias-label-secondary,#cbd5e1);white-space:nowrap}
.ab-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#94a3b8)}
.ab-dot.on{background:var(--dsw-alias-state-success-primary,#10b981)}
.ab-dot.warn{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.ab-dot.err{background:var(--dsw-alias-state-error-primary,#ef4444)}
.ab-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ab-spacer{flex:1 1 auto}
.ab-card{border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.22));border-radius:12px;
  padding:13px 15px;background:var(--dsw-alias-bg-layer-1,rgba(148,163,184,.05))}
.ab-card-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.ab-card-t{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#cbd5e1);letter-spacing:.3px}
.ab-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:9px}
.ab-stat{border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.22));border-radius:10px;
  padding:9px 11px;background:var(--dsw-alias-bg-layer-2,rgba(148,163,184,.06))}
.ab-stat-k{font-size:11px;color:var(--dsw-alias-label-tertiary,#94a3b8)}
.ab-stat-v{font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);
  font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}
.ab-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.14))}
.ab-row:first-of-type{border-top:0}
.ab-row-l{display:flex;flex-direction:column;gap:1px;min-width:0}
.ab-row-k{font-size:12px;color:var(--dsw-alias-label-secondary,#cbd5e1)}
.ab-row-d{font-size:11px;color:var(--dsw-alias-label-tertiary,#94a3b8);word-break:break-all}
.ab-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(148,163,184,.35));
  background:var(--dsw-alias-button-tool-bar-fill,transparent);color:var(--dsw-alias-label-primary,#e2e8f0);
  border-radius:8px;padding:5px 13px;font-size:12px;line-height:18px;cursor:pointer;
  transition:background .12s,border-color .12s,color .12s;white-space:nowrap}
.ab-btn:hover:not(:disabled){background:var(--dsw-alias-button-tool-bar-hover,rgba(148,163,184,.16))}
.ab-btn:disabled{opacity:.45;cursor:not-allowed}
.ab-btn.primary{background:var(--dsw-alias-button-primary-fill,#2563eb);border-color:transparent;
  color:var(--dsw-alias-label-primary-foreground,#fff)}
.ab-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#1d4ed8)}
.ab-btn.primary:disabled{opacity:1;background:transparent;border-color:var(--dsw-alias-border-l2,rgba(148,163,184,.35));
  color:var(--dsw-alias-label-tertiary,#94a3b8)}
.ab-btn.danger{color:var(--dsw-alias-state-error-primary,#ef4444);
  border-color:var(--dsw-alias-state-error-primary,rgba(239,68,68,.45))}
.ab-btn.danger:hover:not(:disabled){background:rgba(239,68,68,.12)}
.ab-btn.sm{padding:3px 9px;font-size:11px;line-height:16px}
.ab-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,rgba(148,163,184,.35));
  border-radius:8px;overflow:hidden}
.ab-seg button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#cbd5e1);
  padding:4px 11px;font-size:12px;cursor:pointer}
.ab-seg button.on{background:var(--dsw-alias-interactive-bg-active,rgba(148,163,184,.24));
  color:var(--dsw-alias-label-primary,#e2e8f0)}
.ab-input{box-sizing:border-box;width:100%;border-radius:8px;padding:5px 9px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(148,163,184,.35));
  background:var(--dsw-alias-bg-layer-2,rgba(148,163,184,.06));
  color:var(--dsw-alias-label-primary,#e2e8f0);
  font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace)}
.ab-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3b82f6)}
.ab-list{display:flex;flex-direction:column;max-height:340px;overflow-y:auto}
.ab-item{display:grid;grid-template-columns:64px 1fr auto;gap:10px;align-items:baseline;
  padding:6px 2px;border-top:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.14));font-size:12px}
.ab-item:first-child{border-top:0}
.ab-mono{font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);
  font-variant-numeric:tabular-nums;font-size:11px;color:var(--dsw-alias-label-tertiary,#94a3b8)}
.ab-host{color:var(--dsw-alias-label-primary,#e2e8f0);word-break:break-all}
.ab-tags{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ab-tag{font-size:11px;padding:1px 7px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2,rgba(148,163,184,.35));
  color:var(--dsw-alias-label-tertiary,#94a3b8);white-space:nowrap}
.ab-tag.ok{color:var(--dsw-alias-state-success-primary,#10b981);
  border-color:var(--dsw-alias-state-success-primary,rgba(16,185,129,.4))}
.ab-tag.warn{color:var(--dsw-alias-state-warn-primary,#f59e0b);
  border-color:var(--dsw-alias-state-warn-primary,rgba(245,158,11,.45))}
.ab-ok{color:var(--dsw-alias-state-success-primary,#10b981);font-weight:600}
.ab-bad{color:var(--dsw-alias-state-error-primary,#ef4444);font-weight:600}
.ab-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#f87171);word-break:break-all}
.ab-muted{font-size:12px;color:var(--dsw-alias-label-tertiary,#94a3b8)}
.ab-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#94a3b8);padding:10px 0;text-align:center}
.ab-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ab-field{display:flex;flex-direction:column;gap:4px}
.ab-field-k{font-size:11px;color:var(--dsw-alias-label-tertiary,#94a3b8)}
.ab-group{border-top:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.18));padding-top:8px;margin-top:8px}
.ab-group:first-of-type{border-top:0;padding-top:0;margin-top:0}
.ab-group-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.ab-group-n{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#e2e8f0)}
.ab-mrow{display:grid;grid-template-columns:minmax(140px,1.05fr) minmax(180px,2fr) auto;
  gap:8px;align-items:center;padding:5px 0}
.ab-mrow-m{display:flex;flex-direction:column;gap:1px;min-width:0}
.ab-mrow-id{font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);
  font-size:11.5px;color:var(--dsw-alias-label-primary,#e2e8f0);word-break:break-all}
.ab-mrow-n{font-size:11px;color:var(--dsw-alias-label-tertiary,#94a3b8);word-break:break-all}
.ab-mrow-a{display:flex;gap:6px;align-items:center;justify-content:flex-end}
.ab-note{font-size:11.5px;color:var(--dsw-alias-state-warn-primary,#f59e0b);word-break:break-all}
@media (max-width:640px){
  .ab-mrow{grid-template-columns:1fr;align-items:stretch}
  .ab-mrow-a{justify-content:flex-start}
  .ab-grid2{grid-template-columns:1fr}
}
`
      );
    }

    /** 取状态快照。 */
    async function fetchStatus() {
      const res = await fetch("/relay-bridge/status", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    /** 控制代理：start / stop / check / cover / uncover。 */
    async function callProxy(action, extra) {
      const res = await fetch("/relay-bridge/proxy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...(extra ?? {}) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    /** 维护模型映射：set-upstream / delete-model / refresh。 */
    async function callModels(payload) {
      const res = await fetch("/relay-bridge/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
      return data ?? {};
    }

    /** 提交配置补丁。 */
    async function submitConfig(patch) {
      const res = await fetch("/relay-bridge/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    /** 清空宿主统计。 */
    async function submitReset() {
      const res = await fetch("/relay-bridge/reset", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    function fmtTime(iso) {
      if (typeof iso !== "string") return "--:--:--";
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) return "--:--:--";
      const pad = (v) => String(v).padStart(2, "0");
      return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
    }

    function fmtNumber(value) {
      const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
      return n.toLocaleString("zh-CN");
    }

    function Stat(props) {
      return h(
        "div",
        { className: "ab-stat" },
        h("div", { className: "ab-stat-k" }, props.label),
        h("div", { className: "ab-stat-v" }, fmtNumber(props.value))
      );
    }

    /** 按 provider 分组，保留宿主给的顺序。 */
    function groupRows(rows) {
      const groups = [];
      const index = new Map();
      for (const row of rows) {
        let group = index.get(row.provider);
        if (group === undefined) {
          group = {
            provider: row.provider,
            providerName: row.providerName,
            api: row.api,
            covered: row.covered,
            baseURL: row.baseURL,
            rows: [],
          };
          index.set(row.provider, group);
          groups.push(group);
        }
        group.rows.push(row);
      }
      return groups;
    }

    /** 面板主体。 */
    function Panel() {
      const [data, setData] = useState(null);
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const [busy, setBusy] = useState("");
      const [port, setPort] = useState("");
      const [upstream, setUpstream] = useState("");
      const [drafts, setDrafts] = useState({});
      const [confirmKey, setConfirmKey] = useState("");
      const dirty = useRef(false);
      const draftKeys = useRef(new Set());

      const apply = (next) => {
        setData(next);
        setError("");
        if (!dirty.current && next && next.proxy) {
          setPort(String(next.proxy.port ?? ""));
          setUpstream(String(next.proxy.upstream ?? ""));
        }
      };

      useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const next = await fetchStatus();
            if (alive) apply(next);
          } catch (err) {
            if (alive) setError(String(err && err.message ? err.message : err));
          }
        };
        tick();
        const timer = setInterval(tick, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      /** 统一跑一个异步动作：置 busy、清错、套用返回的快照。 */
      const run = async (action, task) => {
        setBusy(action);
        setError("");
        setNotice("");
        try {
          const next = await task();
          if (next && next.proxy) apply(next);
          return next ?? null;
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
          return null;
        } finally {
          setBusy("");
        }
      };

      const act = (action) =>
        run(action, async () => {
          const payload = await callProxy(action);
          if (payload && payload.ok === false && payload.error) setError(String(payload.error));
          if (action === "cover" && Array.isArray(payload.covered) && payload.covered.length > 0) {
            setNotice(`已覆盖 ${payload.covered.length} 个 provider，baseURL 已指向 ${payload.listen ?? "本代理"}`);
          }
          if (action === "uncover" && Array.isArray(payload.restored)) {
            setNotice(
              payload.restored.length > 0
                ? `已还原 ${payload.restored.length} 个 provider 的 baseURL`
                : "没有可还原的 provider"
            );
          }
          return payload;
        });

      const save = () =>
        run("save", async () => {
          const next = await submitConfig({ port: Number(port), upstream });
          dirty.current = false;
          return next;
        });

      const clear = () => run("reset", () => submitReset());

      const refreshRoutes = () => run("refresh", () => callModels({ action: "refresh" }));

      const saveUpstream = (row) =>
        run(`save:${row.key}`, async () => {
          const value = draftKeys.current.has(row.key) ? drafts[row.key] : row.upstream;
          const payload = await callModels({
            action: "set-upstream",
            provider: row.provider,
            model: row.model,
            upstream: typeof value === "string" ? value.trim() : "",
          });
          if (payload.ok === false) {
            setError(String(payload.error ?? "保存失败"));
            return payload;
          }
          draftKeys.current.delete(row.key);
          setDrafts((prev) => {
            const next = { ...prev };
            delete next[row.key];
            return next;
          });
          setNotice(`${row.provider}/${row.model} 的上游已更新`);
          return payload;
        });

      const removeModel = (row) =>
        run(`del:${row.key}`, async () => {
          const payload = await callModels({
            action: "delete-model",
            provider: row.provider,
            model: row.model,
          });
          setConfirmKey("");
          if (payload.ok === false) {
            setError(String(payload.error ?? "删除失败"));
            return payload;
          }
          draftKeys.current.delete(row.key);
          setNotice(
            payload.warning
              ? String(payload.warning)
              : `已从 DSH 模型设置中删除 ${row.provider}/${row.model}` +
                (payload.removedProvider ? "（该 provider 已无模型，整条移除）" : "")
          );
          return payload;
        });

      const proxy = data && data.proxy ? data.proxy : null;
      const listening = proxy ? proxy.listening === true : false;
      const check = data && data.check ? data.check : null;
      const stats = proxy && proxy.stats ? proxy.stats : {};
      const fallback = data && data.fallback ? data.fallback : null;
      const recent = data && Array.isArray(data.recent) ? data.recent : [];
      const routing = data && data.routing ? data.routing : null;
      const rows = routing && Array.isArray(routing.rows) ? routing.rows : [];
      const groups = groupRows(rows);
      const routeStats = routing && routing.stats ? routing.stats : {};
      const coveredCount = typeof routeStats.covered === "number" ? routeStats.covered : 0;
      const providerCount = typeof routeStats.providers === "number" ? routeStats.providers : 0;
      const listenUrl = routing && routing.listen ? routing.listen : proxy && proxy.listen ? proxy.listen : "";
      const lastRoute = proxy && proxy.lastRoute ? proxy.lastRoute : null;
      const pillText = !proxy
        ? "正在读取状态…"
        : listening
          ? check && check.ok === false
            ? "代理运行中 · 检测异常"
            : "代理运行中"
          : "代理已停止";
      const pillTone = !proxy ? "warn" : listening ? (check && check.ok === false ? "warn" : "on") : "err";

      return h(
        "div",
        { className: "ab-root" },
        h(Styles, null),
        h(
          "div",
          { className: "ab-wrap" },
          h(
            "div",
            { className: "ab-head" },
            h("span", { className: "ab-title" }, "API 中转站桥"),
            h("span", { className: "ab-ver" }, data ? `v${data.version}` : "v2.2.0"),
            h(
              "span",
              { className: "ab-pill", title: proxy && proxy.lastError ? proxy.lastError : "" },
              h("span", { className: `ab-dot ${pillTone}` }),
              pillText
            ),
            h("span", { className: "ab-spacer" }),
            h(
              "div",
              { className: "ab-actions" },
              h(
                "button",
                { className: "ab-btn", onClick: () => act("check"), disabled: busy !== "" },
                busy === "check" ? "检测中…" : "检测"
              ),
              h(
                "button",
                { className: "ab-btn primary", onClick: () => act("cover"), disabled: busy !== "" },
                busy === "cover" ? "覆盖中…" : "覆盖"
              ),
              h(
                "button",
                { className: "ab-btn", onClick: () => act("uncover"), disabled: busy !== "" },
                busy === "uncover" ? "还原中…" : "还原"
              ),
              h(
                "button",
                { className: "ab-btn", onClick: () => act("start"), disabled: busy !== "" || listening },
                busy === "start" ? "启用中…" : "启用"
              ),
              h(
                "button",
                { className: "ab-btn", onClick: () => act("stop"), disabled: busy !== "" || !listening },
                busy === "stop" ? "停止中…" : "停止"
              )
            )
          ),

          error
            ? h(
                "div",
                { className: "ab-card" },
                h("div", { className: "ab-card-h" }, h("span", { className: "ab-card-t" }, "操作失败")),
                h("div", { className: "ab-err" }, error)
              )
            : null,

          notice
            ? h(
                "div",
                { className: "ab-card" },
                h("div", { className: "ab-card-h" }, h("span", { className: "ab-card-t" }, "刚刚完成")),
                h("div", { className: "ab-muted" }, notice)
              )
            : null,

          h(
            "div",
            { className: "ab-card" },
            h(
              "div",
              { className: "ab-card-h" },
              h("span", { className: "ab-card-t" }, "代理状态"),
              h("span", { className: "ab-muted" }, listening ? `自 ${fmtTime(proxy && proxy.startedAt)}` : "未监听")
            ),
            h(
              "div",
              { className: "ab-row" },
              h("div", { className: "ab-row-l" }, h("span", { className: "ab-row-k" }, "监听地址")),
              h("div", { className: "ab-mono" }, proxy ? `http://127.0.0.1:${proxy.port}` : "—")
            ),
            h(
              "div",
              { className: "ab-row" },
              h(
                "div",
                { className: "ab-row-l" },
                h("span", { className: "ab-row-k" }, "默认上游"),
                h("span", { className: "ab-row-d" }, "请求里既无路由头、也无匹配模型时的兜底地址")
              ),
              h("div", { className: "ab-mono" }, proxy && proxy.defaultUpstream ? proxy.defaultUpstream : "未设置")
            ),
            h(
              "div",
              { className: "ab-row" },
              h(
                "div",
                { className: "ab-row-l" },
                h("span", { className: "ab-row-k" }, "当前路由"),
                h(
                  "span",
                  { className: "ab-row-d" },
                  lastRoute
                    ? `${lastRoute.provider || "未知"} / ${lastRoute.model || "未知"} · 经 ${lastRoute.via}`
                    : "还没有转发过请求"
                )
              ),
              h(
                "span",
                { className: "ab-mono" },
                lastRoute && lastRoute.at ? fmtTime(lastRoute.at) : "—"
              )
            ),
            h(
              "div",
              { className: "ab-row" },
              h(
                "div",
                { className: "ab-row-l" },
                h("span", { className: "ab-row-k" }, "改写方式"),
                h("span", { className: "ab-row-d" }, proxy && proxy.mode === "copy" ? "保留顶层 system（copy）" : "system 折叠进首条 user 后置空（move）")
              ),
              h("span", { className: "ab-tag" }, proxy ? proxy.mode : "—")
            ),
            proxy && proxy.lastError
              ? h("div", { className: "ab-row" }, h("div", { className: "ab-row-l" }, h("span", { className: "ab-row-k" }, "最近错误"), h("span", { className: "ab-err" }, proxy.lastError)))
              : null
          ),

          h(
            "div",
            { className: "ab-card" },
            h(
              "div",
              { className: "ab-card-h" },
              h("span", { className: "ab-card-t" }, "检测结果"),
              h("span", { className: "ab-muted" }, check ? `上次 ${fmtTime(check.at)}` : "尚未检测")
            ),
            check
              ? h(
                  "div",
                  null,
                  check.checks.map((item) =>
                    h(
                      "div",
                      { className: "ab-row", key: item.id },
                      h(
                        "div",
                        { className: "ab-row-l" },
                        h("span", { className: "ab-row-k" }, item.label),
                        h("span", { className: "ab-row-d" }, item.detail)
                      ),
                      h("span", { className: item.ok ? "ab-ok" : "ab-bad" }, item.ok ? "通过" : "失败")
                    )
                  )
                )
              : h("div", { className: "ab-empty" }, "点右上角「检测」验证端口、baseURL 覆盖、上游与改写管线")
          ),

          h(
            "div",
            { className: "ab-card" },
            h(
              "div",
              { className: "ab-card-h" },
              h("span", { className: "ab-card-t" }, "转发统计"),
              h("button", { className: "ab-btn", onClick: clear, disabled: busy !== "" }, busy === "reset" ? "清空中…" : "清空")
            ),
            h(
              "div",
              { className: "ab-stats" },
              h(Stat, { label: "转发请求", value: stats.requests }),
              h(Stat, { label: "改写次数", value: stats.rewrites }),
              h(Stat, { label: "转发错误", value: stats.errors })
            ),
            h(
              "div",
              { className: "ab-row" },
              h(
                "div",
                { className: "ab-row-l" },
                h("span", { className: "ab-row-k" }, "最近改写"),
                h("span", { className: "ab-row-d" }, fallback && fallback.position ? `fetch 兜底：${fallback.position}` : "")
              ),
              h("span", { className: "ab-mono" }, stats.lastAt ? fmtTime(stats.lastAt) : "—")
            )
          ),

          h(
            "div",
            { className: "ab-card" },
            h("div", { className: "ab-card-h" }, h("span", { className: "ab-card-t" }, "监听设置")),
            h(
              "div",
              { className: "ab-grid2" },
              h(
                "label",
                { className: "ab-field" },
                h("span", { className: "ab-field-k" }, "端口"),
                h("input", {
                  className: "ab-input",
                  value: port,
                  inputMode: "numeric",
                  onChange: (event) => {
                    dirty.current = true;
                    setPort(event.target.value);
                  },
                })
              ),
              h(
                "label",
                { className: "ab-field" },
                h("span", { className: "ab-field-k" }, "默认上游（可选）"),
                h("input", {
                  className: "ab-input",
                  value: upstream,
                  placeholder: "未匹配到模型时的兜底地址",
                  onChange: (event) => {
                    dirty.current = true;
                    setUpstream(event.target.value);
                  },
                })
              )
            ),
            h(
              "div",
              { className: "ab-row" },
              h(
                "div",
                { className: "ab-row-l" },
                h("span", { className: "ab-row-d" }, "改端口会重启代理；上游按下面的模型对照表分流，默认上游只做兜底。")
              ),
              h("button", { className: "ab-btn", onClick: save, disabled: busy !== "" }, busy === "save" ? "保存中…" : "保存")
            )
          ),

          h(
            "div",
            { className: "ab-card" },
            h(
              "div",
              { className: "ab-card-h" },
              h(
                "div",
                { className: "ab-tags" },
                h("span", { className: "ab-card-t" }, "模型 · 上游对照表"),
                h(
                  "span",
                  { className: "ab-tag" },
                  `${fmtNumber(routeStats.models)} 个模型`
                ),
                h(
                  "span",
                  { className: providerCount > 0 && coveredCount === providerCount ? "ab-tag ok" : "ab-tag warn" },
                  `${fmtNumber(coveredCount)}/${fmtNumber(providerCount)} provider 已覆盖`
                )
              ),
              h(
                "div",
                { className: "ab-actions" },
                h("button", { className: "ab-btn sm", onClick: refreshRoutes, disabled: busy !== "" }, busy === "refresh" ? "刷新中…" : "刷新"),
                h(
                  "button",
                  { className: "ab-btn sm", onClick: () => act("cover"), disabled: busy !== "" },
                  busy === "cover" ? "覆盖中…" : "全部覆盖"
                )
              )
            ),
            routing && routing.dsh && routing.dsh.ok === false
              ? h(
                  "div",
                  { className: "ab-row" },
                  h(
                    "div",
                    { className: "ab-row-l" },
                    h("span", { className: "ab-row-k" }, "读不到 DSH 模型设置"),
                    h("span", { className: "ab-row-d" }, String(routing.dsh.error ?? "未知原因"))
                  ),
                  h("span", { className: "ab-bad" }, "失败")
                )
              : null,
            rows.length === 0
              ? h("div", { className: "ab-empty" }, "还没有可显示的模型。点「覆盖」把 DSH 里的 provider 接到本代理。")
              : h(
                  "div",
                  null,
                  groups.map((group) =>
                    h(
                      "div",
                      { className: "ab-group", key: group.provider },
                      h(
                        "div",
                        { className: "ab-group-h" },
                        h("span", { className: "ab-group-n" }, group.providerName),
                        h("span", { className: "ab-mono" }, group.provider),
                        group.api ? h("span", { className: "ab-tag" }, group.api) : null,
                        h(
                          "span",
                          { className: group.covered ? "ab-tag ok" : "ab-tag warn" },
                          group.covered ? "baseURL 已指向代理" : "baseURL 未指向代理"
                        ),
                        h("span", { className: "ab-spacer" }),
                        h("span", { className: "ab-mono" }, group.covered ? listenUrl || "—" : group.baseURL || "—")
                      ),
                      group.rows.map((row) => {
                        const draft = draftKeys.current.has(row.key)
                          ? drafts[row.key]
                          : row.upstream;
                        const changed =
                          typeof draft === "string" && draft.trim() !== (row.upstream ?? "");
                        const confirming = confirmKey === row.key;
                        return h(
                          "div",
                          { className: "ab-mrow", key: row.key },
                          h(
                            "div",
                            { className: "ab-mrow-m" },
                            h("span", { className: "ab-mrow-id" }, row.model),
                            h(
                              "span",
                              { className: "ab-mrow-n" },
                              `${row.modelName && row.modelName !== row.model ? `${row.modelName} · ` : ""}${
                                row.source === "manual" ? "自定义上游" : "沿用 provider 原始地址"
                              }`
                            )
                          ),
                          h(
                            "div",
                            { className: "ab-tags" },
                            h("input", {
                              className: "ab-input",
                              value: typeof draft === "string" ? draft : "",
                              placeholder: row.original || "https://上游地址",
                              spellCheck: false,
                              onChange: (event) => {
                                const value = event.target.value;
                                draftKeys.current.add(row.key);
                                setDrafts((prev) => ({ ...prev, [row.key]: value }));
                              },
                              onKeyDown: (event) => {
                                if (event.key === "Enter") saveUpstream(row);
                                if (event.key === "Escape") {
                                  draftKeys.current.delete(row.key);
                                  setDrafts((prev) => {
                                    const next = { ...prev };
                                    delete next[row.key];
                                    return next;
                                  });
                                }
                              },
                            }),
                            row.stale ? h("span", { className: "ab-tag warn" }, "DSH 已无") : null,
                            row.missing ? h("span", { className: "ab-tag warn" }, "未记录") : null
                          ),
                          h(
                            "div",
                            { className: "ab-mrow-a" },
                            changed
                              ? h(
                                  "button",
                                  {
                                    className: "ab-btn sm",
                                    onClick: () => saveUpstream(row),
                                    disabled: busy !== "",
                                  },
                                  busy === `save:${row.key}` ? "保存中…" : "保存"
                                )
                              : null,
                            h(
                              "button",
                              {
                                className: "ab-btn sm danger",
                                onClick: () => {
                                  if (confirming) removeModel(row);
                                  else setConfirmKey(row.key);
                                },
                                disabled: busy !== "",
                                title: "从 DSH 模型设置里删除这个模型",
                              },
                              busy === `del:${row.key}`
                                ? "删除中…"
                                : confirming
                                  ? "确认删除"
                                  : "删除"
                            )
                          )
                        );
                      })
                    )
                  )
                ),
            h(
              "div",
              { className: "ab-muted", style: { marginTop: "8px" } },
              "覆盖后每个 provider 的 baseURL 都指向本代理，改写映射表里的上游地址即可让不同模型走不同中转站；删除会同时从 DSH 模型设置里移除该模型。"
            )
          ),

          h(
            "div",
            { className: "ab-card" },
            h(
              "div",
              { className: "ab-card-h" },
              h("span", { className: "ab-card-t" }, "最近改写记录"),
              h("span", { className: "ab-muted" }, `保留最近 ${recent.length} 条`)
            ),
            recent.length === 0
              ? h("div", { className: "ab-empty" }, "还没有改写记录。发一条对话，system 会被折叠进首条 user 消息。")
              : h(
                  "div",
                  { className: "ab-list" },
                  recent.map((item, index) =>
                    h(
                      "div",
                      { className: "ab-item", key: `${item.at}-${index}` },
                      h("span", { className: "ab-mono" }, fmtTime(item.at)),
                      h(
                        "span",
                        { className: "ab-host" },
                        item.provider
                          ? `${item.provider} / ${item.model || "?"} → ${item.host || "—"}`
                          : item.host || "—"
                      ),
                      h(
                        "span",
                        { className: "ab-tags" },
                        h("span", { className: "ab-tag" }, `${fmtNumber(item.systemChars)} 字符`),
                        h("span", { className: "ab-tag" }, item.via === "proxy" ? "代理" : "兜底")
                      )
                    )
                  )
                )
          ),

          h(
            "div",
            { className: "ab-muted" },
            "DSH → 127.0.0.1 代理 → 中转站：代理按路由头/模型名选出该模型对应的上游，把顶层 system 拼进第一条 user 消息后置空，再流式转发。"
          )
        )
      );
    }

    function apply(ctx) {
      try {
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: 60,
              label: () => PANEL_LABEL,
            },
            BridgeIcon
          )
        );
      } catch (error) {
        console.warn("[api-relay-bridge] sidebar.panellist 注册失败", error);
      }

      try {
        ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, Panel));
      } catch (error) {
        console.warn("[api-relay-bridge] main 面板注册失败", error);
      }
    }

    return { name: PLUGIN_ID, inject: ["slots"], apply };
  },
});
