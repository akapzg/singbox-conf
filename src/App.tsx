import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Platform, Profile, ProxyNode, RemoteDnsChoice, RemoteDnsProtocol, Settings, Tailnet } from "./types";
import { TEMPLATES } from "./templates";
import { REMOTE_DNS, generateConfig, nodeObject, parseDomainList, parseRuleList, tailnetEndpoint, validate, type Issue } from "./generate";
import { freshTag, newNode, newTailnet } from "./defaults";
import { clearStore, defaultStore, loadStore, newSavedProfile, saveStore, type Store } from "./storage";
import { dedupeTags, importSingBoxConfig, type ImportResult } from "./importer";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; self-hosted http:// pages land here.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Field(props: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={props.wide ? "field wide" : "field"}>
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

function Secret(props: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="secret">
      <input
        type={shown ? "text" : "password"}
        value={props.value}
        placeholder={props.placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <button type="button" className="ghost small" onClick={() => setShown(!shown)}>
        {shown ? "隐藏" : "显示"}
      </button>
    </span>
  );
}

function IssueList(props: { issues: Issue[] }) {
  if (!props.issues.length) return null;
  return (
    <ul className="inline-issues">
      {props.issues.map((i, k) => (
        <li key={k} className={i.level}>
          {i.detail}
        </li>
      ))}
    </ul>
  );
}

function IssueBadge(props: { issues: Issue[] }) {
  const errors = props.issues.filter((i) => i.level === "error").length;
  const warnings = props.issues.length - errors;
  if (errors) return <span className="badge error">{errors} 个错误</span>;
  if (warnings) return <span className="badge warning">{warnings} 条提醒</span>;
  return null;
}

function NodeCard(props: {
  node: ProxyNode;
  index: number;
  count: number;
  issues: Issue[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (n: ProxyNode) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const { node: n } = props;
  const set = (patch: Partial<ProxyNode>) => props.onChange({ ...n, ...patch });
  const { object, endpoint } = nodeObject(n);
  const server = object && typeof object.server === "string" ? `${object.server}${object.server_port ? `:${object.server_port}` : ""}` : "";
  return (
    <article className={`card node${props.expanded ? " open" : ""}`} id={`item-${n.id}`}>
      <div className="card-summary">
        <button type="button" className="summary-toggle" aria-expanded={props.expanded} onClick={props.onToggle}>
          <span className="chevron" aria-hidden="true" />
          <span className="summary-main">
            <span className="summary-title">{n.tag || "未命名节点"}</span>
            <span className="summary-meta mono">
              {object ? String(object.type) : "未识别"}
              {server && ` · ${server}`}
            </span>
          </span>
          <span className="summary-badges">
            {endpoint && <span className="badge">端点</span>}
            {!n.inGroups && <span className="badge">不在代理组</span>}
            <IssueBadge issues={props.issues} />
          </span>
        </button>
        <div className="card-actions">
          <button type="button" className="icon" disabled={props.index === 0} onClick={() => props.onMove(-1)} aria-label="上移" title="上移">
            ↑
          </button>
          <button
            type="button"
            className="icon"
            disabled={props.index === props.count - 1}
            onClick={() => props.onMove(1)}
            aria-label="下移"
            title="下移"
          >
            ↓
          </button>
          <button
            type="button"
            className="icon danger"
            aria-label={`删除节点 ${n.tag}`}
            title="删除"
            onClick={() => {
              if (confirm(`删除节点「${n.tag || "未命名"}」？`)) props.onRemove();
            }}
          >
            ✕
          </button>
        </div>
      </div>
      {props.expanded && (
        <div className="card-body">
          <IssueList issues={props.issues} />
          <Field label="标签" hint="出站标签，也是在客户端里看到的节点名" wide>
            <input value={n.tag} spellCheck={false} onChange={(e) => set({ tag: e.target.value.trim() })} />
          </Field>
          <div className="field">
            <span className="field-label">节点配置（JSON，可写注释；tag 由生成器填写）</span>
            <CodeEditor value={n.body} onChange={(body) => set({ body })} />
          </div>
          <label className="check">
            <input type="checkbox" checked={n.inGroups} onChange={(e) => set({ inGroups: e.target.checked })} />
            <span>
              加入代理组<span className="muted">（出现在 proxy 选择器和 auto 自动测速中；只作为其他节点 detour 的可以不勾）</span>
            </span>
          </label>
        </div>
      )}
    </article>
  );
}

/** Textarea for JSON with comments: Tab indents instead of leaving the field. */
function CodeEditor(props: { value: string; onChange: (v: string) => void; minRows?: number; maxRows?: number }) {
  const lines = props.value.split("\n").length;
  return (
    <textarea
      className="mono code-input"
      rows={Math.min(props.maxRows ?? 24, Math.max(props.minRows ?? 6, lines + 1))}
      value={props.value}
      spellCheck={false}
      autoComplete="off"
      autoCapitalize="off"
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== "Tab" || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        const t = e.currentTarget;
        const { selectionStart: a, selectionEnd: b, value } = t;
        const next = `${value.slice(0, a)}  ${value.slice(b)}`;
        props.onChange(next);
        requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
      }}
    />
  );
}

function AddNode(props: { usedTags: string[]; onAdd: (n: ProxyNode) => void }) {
  const [templateId, setTemplateId] = useState(TEMPLATES[0].id);
  return (
    <div className="row add-node">
      <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="协议模板">
        {TEMPLATES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="primary"
        onClick={() => {
          const t = TEMPLATES.find((x) => x.id === templateId)!;
          props.onAdd(newNode({ tag: freshTag(t.tagPrefix, props.usedTags), body: t.body }));
        }}
      >
        添加节点
      </button>
    </div>
  );
}

const PLATFORMS: { value: Platform; label: string; note: string }[] = [
  { value: "apple", label: "macOS / iOS（SFM、SFI）", note: "" },
  { value: "android", label: "Android（SFA）", note: "Android 上能否识别本机公网 IPv6 尚未实测；识别不了时，直连会只用 IPv4，不影响使用。" },
  { value: "linux", label: "Linux（命令行）", note: "启用 auto_redirect（基于 nftables，sing-box 推荐在 Linux 上开启）。" },
  { value: "windows", label: "Windows（命令行）", note: "" },
];

const MODES: { value: Settings["defaultMode"]; label: string }[] = [
  { value: "GFWList", label: "GFWList：只有 gfwlist 里的走代理" },
  { value: "Non-CN", label: "Non-CN：国内直连，其余走代理" },
  { value: "Global", label: "Global：全部走代理" },
  { value: "Direct", label: "Direct：全部直连" },
];

/** Line-based list editor with live parse feedback. */
function ListEditor(props: {
  lines: string[];
  onChange: (lines: string[]) => void;
  placeholder: string;
  summary: (text: string) => { count: number; invalid: string[] };
  unit: string;
}) {
  const { count, invalid } = props.summary(props.lines.join("\n"));
  return (
    <>
      <textarea
        className="mono"
        rows={Math.min(12, Math.max(3, props.lines.length + 1))}
        value={props.lines.join("\n")}
        placeholder={props.placeholder}
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value.split("\n"))}
      />
      <p className="muted">
        {count ? `已识别 ${count} ${props.unit}` : "未设置"}
        {invalid.length > 0 && <span className="invalid">；无法识别：{invalid.join("、")}</span>}
      </p>
    </>
  );
}

const domainSummary = (text: string) => {
  const { domains, invalid } = parseDomainList(text);
  return { count: domains.length, invalid };
};
const ruleSummary = (text: string) => {
  const { domains, cidrs, invalid } = parseRuleList(text);
  return { count: domains.length + cidrs.length, invalid };
};

function RoutingCard(props: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const { settings: s } = props;
  return (
    <article className="card">
      <p className="muted">
        列表每行一项，域名同时匹配所有子域名；<span className="mono">#</span> 之后为注释。
      </p>
      <Field label="默认模式" hint="启动时使用的模式，运行中可在客户端或 Clash API 中切换" wide>
        <select value={s.defaultMode} onChange={(e) => props.onChange({ defaultMode: e.target.value as Settings["defaultMode"] })}>
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="field">
        <span className="field-label">直连域名（除 Global 外始终直连，用本地 DNS 解析）</span>
        <ListEditor
          lines={s.directDomains}
          onChange={(directDomains) => props.onChange({ directDomains })}
          placeholder={"example.cn\nintranet.example.com  # 公司内网"}
          summary={domainSummary}
          unit="个域名"
        />
      </div>
      <div className="field">
        <span className="field-label">代理域名和 IP（除 Direct 外始终走代理；适合被墙但不在 gfwlist 里的网站）</span>
        <ListEditor
          lines={s.proxyRules}
          onChange={(proxyRules) => props.onChange({ proxyRules })}
          placeholder={"intercom.io\n203.0.113.0/24"}
          summary={ruleSummary}
          unit="项"
        />
      </div>
    </article>
  );
}

function TailnetCard(props: {
  tailnet: Tailnet;
  issues: Issue[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (t: Tailnet) => void;
  onRemove: () => void;
}) {
  const { tailnet: t } = props;
  const set = (patch: Partial<Tailnet>) => props.onChange({ ...t, ...patch });
  const { endpoint } = tailnetEndpoint(t);
  const host = endpoint && typeof endpoint.hostname === "string" ? endpoint.hostname : "";
  return (
    <article className={`card node${props.expanded ? " open" : ""}`} id={`item-${t.id}`}>
      <div className="card-summary">
        <button type="button" className="summary-toggle" aria-expanded={props.expanded} onClick={props.onToggle}>
          <span className="chevron" aria-hidden="true" />
          <span className="summary-main">
            <span className="summary-title">{t.tag || "未命名 tailnet"}</span>
            <span className="summary-meta mono">
              tailscale{host && ` · ${host}`}
              {(t.magicDns || t.dnsDomains.some((l) => l.trim())) && ` · dns: ${t.tag}-dns`}
            </span>
          </span>
          <span className="summary-badges">
            {t.asProxy && <span className="badge">代理出口</span>}
            <IssueBadge issues={props.issues} />
          </span>
        </button>
        <div className="card-actions">
          <button
            type="button"
            className="icon danger"
            aria-label={`删除 tailnet ${t.tag}`}
            title="删除"
            onClick={() => {
              if (confirm(`删除 tailnet「${t.tag || "未命名"}」？`)) props.onRemove();
            }}
          >
            ✕
          </button>
        </div>
      </div>
      {props.expanded && (
      <div className="card-body">
      <IssueList issues={props.issues} />
      <Field label="标签" hint="端点的标签；DNS 服务器会命名为「标签-dns」" wide>
        <input value={t.tag} spellCheck={false} onChange={(e) => set({ tag: e.target.value.trim() })} />
      </Field>
      <div className="field">
        <span className="field-label">端点配置（JSON，可写注释；type 和 tag 由生成器填写）</span>
        <CodeEditor value={t.endpoint} onChange={(endpoint) => set({ endpoint })} maxRows={16} />
      </div>
      <label className="check">
        <input type="checkbox" checked={t.magicDns} onChange={(e) => set({ magicDns: e.target.checked })} />
        <span>
          MagicDNS<span className="muted">（tailnet 设备名和 tailnet 下发的 DNS 路由后缀交给它解析）</span>
        </span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={t.acceptDefaultResolvers}
          onChange={(e) => set({ acceptDefaultResolvers: e.target.checked })}
        />
        <span>
          使用 tailnet 的默认 DNS 服务器<span className="muted">（交给它的域名不在 MagicDNS 里时，用 tailnet 配置的全局 DNS 解析）</span>
        </span>
      </label>
      <div className="field">
        <span className="field-label">分域 DNS：交给这个 tailnet 解析的域名（例如公司内网域名，才能拿到内网地址）</span>
        <ListEditor
          lines={t.dnsDomains}
          onChange={(dnsDomains) => set({ dnsDomains })}
          placeholder="corp.example.com"
          summary={domainSummary}
          unit="个域名"
        />
      </div>
      <div className="field">
        <span className="field-label">额外路由：走这个 tailnet 的域名或 IP 段（tailnet 设备和已批准的子网路由会自动识别，不用填）</span>
        <ListEditor
          lines={t.routes}
          onChange={(routes) => set({ routes })}
          placeholder={"10.20.0.0/16\nnas.example.com"}
          summary={ruleSummary}
          unit="项"
        />
      </div>
      <label className="check">
        <input type="checkbox" checked={t.asProxy} onChange={(e) => set({ asProxy: e.target.checked })} />
        <span>
          作为代理出口<span className="muted">（加入 proxy 选择器，可手动选用；需要在端点里设置 exit_node）</span>
        </span>
      </label>
      </div>
      )}
    </article>
  );
}

function SettingsCard(props: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const { settings: s } = props;
  const set = props.onChange;
  const platform = PLATFORMS.find((p) => p.value === s.platform);
  return (
    <article className="card">
      <div className="grid">
        <Field label="目标平台" hint={platform?.note} wide>
          <select value={s.platform} onChange={(e) => set({ platform: e.target.value as Platform })}>
            {PLATFORMS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="代理 DNS 服务器" hint="走代理的域名经代理用它解析">
          <select
            value={s.remoteDns.provider}
            onChange={(e) => set({ remoteDns: { ...s.remoteDns, provider: e.target.value as RemoteDnsChoice } })}
          >
            {Object.entries(REMOTE_DNS).map(([value, p]) => (
              <option key={value} value={value}>
                {p.label}（{p.address}）
              </option>
            ))}
            <option value="custom">自定义…</option>
          </select>
        </Field>
        {s.remoteDns.provider !== "custom" ? (
          <Field label="协议">
            <select
              value={s.remoteDns.protocol}
              onChange={(e) => set({ remoteDns: { ...s.remoteDns, protocol: e.target.value as RemoteDnsProtocol } })}
            >
              <option value="tls">DNS over TLS</option>
              <option value="https">DNS over HTTPS</option>
            </select>
          </Field>
        ) : (
          <div className="field wide">
            <span className="field-label">自定义 DNS 服务器（JSON，可写注释；tag 由生成器填写，默认经 proxy 访问）</span>
            <CodeEditor
              value={s.remoteDns.custom}
              onChange={(custom) => set({ remoteDns: { ...s.remoteDns, custom } })}
              minRows={6}
              maxRows={14}
            />
          </div>
        )}
        <Field label="ECS 网段" hint="随查询发给代理 DNS 的 EDNS Client Subnet。留空时按代理服务器位置返回结果，通常更合适" wide>
          <input
            value={s.clientSubnet}
            placeholder="留空（推荐）"
            spellCheck={false}
            onChange={(e) => set({ clientSubnet: e.target.value.trim() })}
          />
        </Field>
        <Field label="Clash API 监听地址" hint="留空则不开启">
          <input
            value={s.clashController}
            placeholder="127.0.0.1:9090"
            spellCheck={false}
            onChange={(e) => set({ clashController: e.target.value.trim() })}
          />
        </Field>
        <Field label="Clash API secret">
          <Secret value={s.clashSecret} onChange={(clashSecret) => set({ clashSecret })} />
        </Field>
        <label className="check wide">
          <input type="checkbox" checked={s.steam} onChange={(e) => set({ steam: e.target.checked })} />
          <span>
            Steam<span className="muted">（局域网缓存 lancache 用本地 DNS 解析；Non-CN 模式下 Steam 下载直连）</span>
          </span>
        </label>
        <label className="check wide">
          <input type="checkbox" checked={s.blockIcloudQuic} onChange={(e) => set({ blockIcloudQuic: e.target.checked })} />
          <span>
            禁止 iCloud 使用 QUIC<span className="muted">（拒绝到 gateway.icloud.com 的 UDP 443，让它改用 TCP）</span>
          </span>
        </label>
      </div>
    </article>
  );
}

/** A node whose server is still the template's example address. */
function isExampleNode(n: ProxyNode): boolean {
  const { object } = nodeObject(n);
  const server = object && typeof object.server === "string" ? object.server : "";
  return /(^|\.)example\.com$/.test(server);
}

function uniqueName(name: string, store: Store): string {
  const names = store.profiles.map((p) => p.name);
  if (!names.includes(name)) return name;
  for (let i = 2; ; i++) if (!names.includes(`${name} ${i}`)) return `${name} ${i}`;
}

/** Small dropdown menu; closes on outside click and Escape. */
function Menu(props: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {props.label}
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {props.children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem(props: { onSelect: () => void; danger?: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={props.danger ? "menu-item danger" : "menu-item"}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      {props.children}
    </button>
  );
}

type Tab = "nodes" | "routing" | "tailscale" | "settings";
const TABS: { id: Tab; label: string }[] = [
  { id: "nodes", label: "节点" },
  { id: "routing", label: "分流" },
  { id: "tailscale", label: "Tailscale" },
  { id: "settings", label: "高级" },
];
const TAB_KEY = "singbox-gen:tab";

function loadTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (TABS.some((x) => x.id === t)) return t as Tab;
  } catch {
    // Storage blocked: start on the first tab.
  }
  return "nodes";
}

/** JSON with keys, strings, numbers and literals wrapped for colouring. */
function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const cls = m[1] ? (m[2] ? "tok-key" : "tok-str") : m[3] ? "tok-lit" : "tok-num";
    out.push(
      <span key={m.index} className={cls}>
        {m[1] ?? m[0]}
      </span>,
    );
    if (m[2]) out.push(m[2]);
    last = re.lastIndex;
  }
  out.push(text.slice(last));
  return out;
}

export default function App() {
  const [store, setStore] = useState<Store>(loadStore);
  const [toast, setToast] = useState("");
  const [tab, setTabState] = useState<Tab>(loadTab);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showWarnings, setShowWarnings] = useState(false);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const active = store.profiles.find((p) => p.id === store.activeId) ?? store.profiles[0];
  const profile = active.profile;
  const setProfile = (update: (p: Profile) => Profile) =>
    setStore((s) => ({
      ...s,
      profiles: s.profiles.map((x) => (x.id === s.activeId ? { ...x, profile: update(x.profile) } : x)),
    }));
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // Ignore: only a convenience.
    }
  };
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => saveStore(store), [store]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2000);
    return () => clearTimeout(t);
  }, [toast]);
  // After navigating to a card, bring it into view and flash it.
  useEffect(() => {
    if (!scrollTo) return;
    const el = document.getElementById(`item-${scrollTo}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    }
    setScrollTo(null);
  }, [scrollTo, tab, expanded]);

  const issues = useMemo(() => validate(profile), [profile]);
  const configText = useMemo(() => JSON.stringify(generateConfig(profile), null, 2), [profile]);
  const highlighted = useMemo(() => highlightJson(configText), [configText]);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const issuesFor = (id: string) => issues.filter((i) => i.id === id);
  const sectionIssues = (section: Tab) => issues.filter((i) => i.section === section && !i.id);
  const tabState = (section: Tab) => {
    const list = issues.filter((i) => i.section === section);
    return list.some((i) => i.level === "error") ? "error" : list.length ? "warning" : "";
  };

  const goTo = (i: Issue) => {
    setTab(i.section);
    if (i.id) {
      setExpanded((prev) => new Set(prev).add(i.id!));
      setScrollTo(i.id);
    }
  };

  const setSettings = (patch: Partial<Settings>) => setProfile((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  const updateNode = (i: number, n: ProxyNode) => setProfile((p) => ({ ...p, nodes: p.nodes.map((x, j) => (j === i ? n : x)) }));
  const removeNode = (i: number) => setProfile((p) => ({ ...p, nodes: p.nodes.filter((_, j) => j !== i) }));
  const moveNode = (i: number, delta: number) =>
    setProfile((p) => {
      const nodes = [...p.nodes];
      const [n] = nodes.splice(i, 1);
      nodes.splice(i + delta, 0, n);
      return { ...p, nodes };
    });
  const addNode = (n: ProxyNode) => {
    setProfile((p) => ({ ...p, nodes: [...p.nodes, n] }));
    setExpanded((prev) => new Set(prev).add(n.id));
    setScrollTo(n.id);
  };
  const addTailnet = () => {
    const tailnets = profile.settings.tailnets;
    const t = newTailnet({ tag: tailnets.length ? `ts${tailnets.length + 1}` : "ts" });
    setSettings({ tailnets: [...tailnets, t] });
    setExpanded((prev) => new Set(prev).add(t.id));
    setScrollTo(t.id);
  };

  const addProfile = (name: string, p?: Profile) => {
    const saved = newSavedProfile(name, p);
    setStore((s) => ({ activeId: saved.id, profiles: [...s.profiles, saved] }));
  };
  const askName = (message: string, initial: string) => prompt(message, initial)?.trim() || null;

  const importConfig = async (file: File) => {
    let result: ImportResult;
    try {
      result = importSingBoxConfig(await file.text());
    } catch (e) {
      alert(`导入失败：${(e as Error).message}`);
      return;
    }
    // Untouched template examples (still pointing at example.com) are replaced rather than kept.
    const keep = profile.nodes.every(isExampleNode) ? [] : profile.nodes;
    const nodes = dedupeTags(result.nodes, [...keep.map((n) => n.tag), ...profile.settings.tailnets.map((t) => t.tag)]);
    const tailnets = dedupeTags(result.tailnets, [...profile.settings.tailnets.map((t) => t.tag), ...nodes.map((n) => n.tag)]);
    const summary = [
      `从 ${file.name} 导入到配置「${active.name}」：`,
      `· ${nodes.length} 个节点${nodes.length ? `（${nodes.map((n) => n.tag).join("、")}）` : ""}`,
      `· ${tailnets.length} 个 tailnet${tailnets.length ? `（${tailnets.map((t) => t.tag).join("、")}）` : ""}`,
      ...result.notes.map((n) => `· ${n}`),
      ...(keep.length < profile.nodes.length ? ["· 现有的示例节点会被替换"] : []),
      "",
      "DNS 和分流规则不会导入，由本工具的策略生成。追加到现有内容之后，标签重复的会自动改名。",
    ].join("\n");
    if (!confirm(summary)) return;
    setProfile((p) => ({
      ...p,
      nodes: [...keep, ...nodes],
      settings: { ...p.settings, tailnets: [...p.settings.tailnets, ...tailnets] },
    }));
    setTab(nodes.length ? "nodes" : "tailscale");
    setToast(`已导入 ${nodes.length} 个节点、${tailnets.length} 个 tailnet`);
  };

  const tailnets = profile.settings.tailnets;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1>sing-box 配置生成器</h1>
          <p className="muted">纯前端运行，配置只保存在这个浏览器里。适用于 sing-box 1.14 及以上。</p>
        </div>
        <div className="top-actions">
          <label className="profile-select">
            <span className="field-label">配置</span>
            <select value={active.id} onChange={(e) => setStore({ ...store, activeId: e.target.value })}>
              {store.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <Menu label="⋯ 管理">
            {(close) => (
              <>
                <MenuItem
                  onSelect={() => {
                    close();
                    const name = askName("新配置的名称（从示例开始）", uniqueName("新配置", store));
                    if (name) addProfile(uniqueName(name, store));
                  }}
                >
                  新建配置
                </MenuItem>
                <MenuItem
                  onSelect={() => {
                    close();
                    const name = askName("副本的名称", uniqueName(`${active.name} 副本`, store));
                    if (name) addProfile(uniqueName(name, store), structuredClone(profile));
                  }}
                >
                  复制当前配置
                </MenuItem>
                <MenuItem
                  onSelect={() => {
                    close();
                    const name = askName("重命名为", active.name);
                    if (name && name !== active.name) {
                      const unique = uniqueName(name, store);
                      setStore({ ...store, profiles: store.profiles.map((p) => (p.id === active.id ? { ...p, name: unique } : p)) });
                    }
                  }}
                >
                  重命名…
                </MenuItem>
                <hr />
                <MenuItem
                  onSelect={() => {
                    close();
                    fileInput.current?.click();
                  }}
                >
                  从 sing-box 配置导入节点…
                </MenuItem>
                <hr />
                <MenuItem
                  danger
                  disabled={store.profiles.length < 2}
                  onSelect={() => {
                    close();
                    if (!confirm(`删除配置「${active.name}」？`)) return;
                    const profiles = store.profiles.filter((p) => p.id !== active.id);
                    setStore({ activeId: profiles[0].id, profiles });
                  }}
                >
                  删除当前配置
                </MenuItem>
                <MenuItem
                  danger
                  onSelect={() => {
                    close();
                    if (!confirm("清除这个浏览器里保存的全部配置，并恢复为示例？")) return;
                    clearStore();
                    setStore(defaultStore());
                  }}
                >
                  清除全部本地数据
                </MenuItem>
              </>
            )}
          </Menu>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importConfig(f);
              e.target.value = "";
            }}
          />
        </div>
      </header>

      <main className="layout">
        <section className="pane">
          <nav className="tabs" role="tablist" aria-label="设置分类">
            {TABS.map((t) => {
              const count = t.id === "nodes" ? profile.nodes.length : t.id === "tailscale" ? tailnets.length : null;
              const state = tabState(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  className={tab === t.id ? "tab active" : "tab"}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                  {count !== null && <span className="tab-count">{count}</span>}
                  {state && <span className={`dot ${state}`} aria-label={state === "error" ? "有错误" : "有提醒"} />}
                </button>
              );
            })}
          </nav>

          {sectionIssues(tab).length > 0 && <IssueList issues={sectionIssues(tab)} />}

          {tab === "nodes" && (
            <>
              <div className="pane-head">
                <p className="muted">
                  每个节点是一段 sing-box 出站配置。选择协议模板添加，或
                  <button type="button" className="link" onClick={() => fileInput.current?.click()}>
                    从现有的 sing-box 配置导入
                  </button>
                  。
                </p>
                <AddNode usedTags={profile.nodes.map((n) => n.tag)} onAdd={addNode} />
              </div>
              {profile.nodes.length === 0 && <p className="empty">还没有节点：选择协议模板，点击「添加节点」。</p>}
              {profile.nodes.map((n, i) => (
                <NodeCard
                  key={n.id}
                  node={n}
                  index={i}
                  count={profile.nodes.length}
                  issues={issuesFor(n.id)}
                  expanded={expanded.has(n.id)}
                  onToggle={() => toggle(n.id)}
                  onChange={(next) => updateNode(i, next)}
                  onRemove={() => removeNode(i)}
                  onMove={(d) => moveNode(i, d)}
                />
              ))}
            </>
          )}

          {tab === "routing" && <RoutingCard settings={profile.settings} onChange={setSettings} />}

          {tab === "tailscale" && (
            <>
              <div className="pane-head">
                <p className="muted">需要访问 tailnet 里的设备或公司内网时添加。tailnet 设备和已批准的子网路由会自动走对应的 tailnet。</p>
                <button type="button" className="primary" onClick={addTailnet}>
                  添加 tailnet
                </button>
              </div>
              {tailnets.length === 0 && <p className="empty">未使用 Tailscale。</p>}
              {tailnets.map((t, i) => (
                <TailnetCard
                  key={t.id}
                  tailnet={t}
                  issues={issuesFor(t.id)}
                  expanded={expanded.has(t.id)}
                  onToggle={() => toggle(t.id)}
                  onChange={(next) => setSettings({ tailnets: tailnets.map((x, j) => (j === i ? next : x)) })}
                  onRemove={() => setSettings({ tailnets: tailnets.filter((_, j) => j !== i) })}
                />
              ))}
            </>
          )}

          {tab === "settings" && <SettingsCard settings={profile.settings} onChange={setSettings} />}
        </section>

        <section className="pane output" aria-label="生成的配置">
          <div className="pane-head">
            <h2>config.json</h2>
            <div className="row">
              <button
                type="button"
                className="ghost"
                onClick={async () => setToast((await copyText(configText)) ? "已复制到剪贴板" : "复制失败，请手动选择")}
              >
                复制
              </button>
              <button type="button" className="primary" onClick={() => download("config.json", configText)}>
                下载
              </button>
            </div>
          </div>

          <div className={`status ${errors.length ? "error" : warnings.length ? "warning" : "ok"}`} role="status">
            <strong>
              {errors.length
                ? `${errors.length} 个错误：sing-box 可能无法加载这份配置`
                : warnings.length
                  ? `可以生成，但有 ${warnings.length} 条提醒`
                  : "配置完整，可以导入客户端"}
            </strong>
            {warnings.length > 0 && (
              <button type="button" className="link" onClick={() => setShowWarnings(!showWarnings)}>
                {showWarnings ? "收起提醒" : "查看提醒"}
              </button>
            )}
          </div>
          {(errors.length > 0 || showWarnings) && (
            <ul className="issues">
              {[...errors, ...(showWarnings ? warnings : [])].map((i, k) => (
                <li key={k} className={i.level}>
                  <button type="button" className="link" onClick={() => goTo(i)}>
                    {i.message}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <pre className="code" tabIndex={0} aria-label="生成的 config.json">
            {highlighted}
          </pre>
          <p className="muted small-print">
            {configText.split("\n").length} 行 · {(new Blob([configText]).size / 1024).toFixed(1)} KB
          </p>
        </section>
      </main>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
