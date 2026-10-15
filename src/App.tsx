import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Platform, Profile, ProxyNode, RemoteDnsProtocol, RemoteDnsProvider, Settings, Tailnet } from "./types";
import { TEMPLATES } from "./templates";
import { REMOTE_DNS, generateConfig, nodeObject, parseDomainList, parseRuleList, tailnetEndpoint, validate } from "./generate";
import { freshTag, newNode, newTailnet } from "./defaults";
import { clearStore, defaultStore, loadStore, newSavedProfile, normalizeProfile, saveStore, type Store } from "./storage";

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

function NodeCard(props: {
  node: ProxyNode;
  index: number;
  count: number;
  onChange: (n: ProxyNode) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const { node: n } = props;
  const set = (patch: Partial<ProxyNode>) => props.onChange({ ...n, ...patch });
  const { object, endpoint, error } = nodeObject(n);
  return (
    <article className="card">
      <header className="card-head">
        <div>
          <h3>{n.tag || "未命名节点"}</h3>
          <p className="muted mono">
            {object ? `${String(object.type)}${endpoint ? "（端点）" : ""}` : "未识别"}
            {n.inGroups ? "" : " · 不在代理组中"}
          </p>
        </div>
        <div className="card-actions">
          <button type="button" className="ghost small" disabled={props.index === 0} onClick={() => props.onMove(-1)} aria-label="上移">
            ↑
          </button>
          <button
            type="button"
            className="ghost small"
            disabled={props.index === props.count - 1}
            onClick={() => props.onMove(1)}
            aria-label="下移"
          >
            ↓
          </button>
          <button
            type="button"
            className="ghost small danger"
            onClick={() => {
              if (confirm(`删除节点「${n.tag || "未命名"}」？`)) props.onRemove();
            }}
          >
            删除
          </button>
        </div>
      </header>
      <Field label="标签" hint="出站标签，也是在客户端里看到的节点名" wide>
        <input value={n.tag} spellCheck={false} onChange={(e) => set({ tag: e.target.value.trim() })} />
      </Field>
      <div className="field">
        <span className="field-label">节点配置（JSON，可写注释；tag 由生成器填写）</span>
        <textarea
          className="mono"
          rows={Math.min(24, Math.max(6, n.body.split("\n").length + 1))}
          value={n.body}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => set({ body: e.target.value })}
        />
        {error && <p className="invalid">{error}</p>}
      </div>
      <label className="check">
        <input type="checkbox" checked={n.inGroups} onChange={(e) => set({ inGroups: e.target.checked })} />
        <span>
          加入代理组<span className="muted">（出现在 proxy 选择器和 auto 自动测速中；只作为其他节点 detour 的可以不勾）</span>
        </span>
      </label>
    </article>
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
      <header className="card-head">
        <div>
          <h3>分流</h3>
          <p className="muted">
            每行一项，域名同时匹配所有子域名；<span className="mono">#</span> 之后为注释。
          </p>
        </div>
      </header>
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

function TailnetCard(props: { tailnet: Tailnet; onChange: (t: Tailnet) => void; onRemove: () => void }) {
  const { tailnet: t } = props;
  const set = (patch: Partial<Tailnet>) => props.onChange({ ...t, ...patch });
  const { error } = tailnetEndpoint(t);
  return (
    <article className="card">
      <header className="card-head">
        <div>
          <h3>{t.tag || "未命名 tailnet"}</h3>
          <p className="muted mono">
            endpoint: {t.tag}
            {(t.magicDns || t.dnsDomains.some((l) => l.trim())) && ` · dns: ${t.tag}-dns`}
          </p>
        </div>
        <div className="card-actions">
          <button
            type="button"
            className="ghost small danger"
            onClick={() => {
              if (confirm(`删除 tailnet「${t.tag || "未命名"}」？`)) props.onRemove();
            }}
          >
            删除
          </button>
        </div>
      </header>
      <Field label="标签" hint="端点的标签；DNS 服务器会命名为「标签-dns」" wide>
        <input value={t.tag} spellCheck={false} onChange={(e) => set({ tag: e.target.value.trim() })} />
      </Field>
      <div className="field">
        <span className="field-label">端点配置（JSON，可写注释；type 和 tag 由生成器填写）</span>
        <textarea
          className="mono"
          rows={Math.min(16, Math.max(6, t.endpoint.split("\n").length + 1))}
          value={t.endpoint}
          spellCheck={false}
          onChange={(e) => set({ endpoint: e.target.value })}
        />
        {error && <p className="invalid">JSON 有误：{error}</p>}
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
    </article>
  );
}

function SettingsCard(props: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const { settings: s } = props;
  const set = props.onChange;
  const platform = PLATFORMS.find((p) => p.value === s.platform);
  return (
    <details className="card settings">
      <summary>
        <h3>平台与高级设置</h3>
      </summary>
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
            onChange={(e) => set({ remoteDns: { ...s.remoteDns, provider: e.target.value as RemoteDnsProvider } })}
          >
            {Object.entries(REMOTE_DNS).map(([value, p]) => (
              <option key={value} value={value}>
                {p.label}（{p.address}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="协议">
          <select
            value={s.remoteDns.protocol}
            onChange={(e) => set({ remoteDns: { ...s.remoteDns, protocol: e.target.value as RemoteDnsProtocol } })}
          >
            <option value="tls">DNS over TLS</option>
            <option value="https">DNS over HTTPS</option>
          </select>
        </Field>
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
    </details>
  );
}

function uniqueName(name: string, store: Store): string {
  const names = store.profiles.map((p) => p.name);
  if (!names.includes(name)) return name;
  for (let i = 2; ; i++) if (!names.includes(`${name} ${i}`)) return `${name} ${i}`;
}

/** Switch, add, copy, rename and delete the profiles kept in this browser. */
function ProfileBar(props: { store: Store; onChange: (s: Store) => void; onAdd: (name: string, p?: Profile) => void }) {
  const { store } = props;
  const active = store.profiles.find((p) => p.id === store.activeId) ?? store.profiles[0];
  const ask = (message: string, initial: string) => {
    const name = prompt(message, initial)?.trim();
    return name || null;
  };
  return (
    <div className="row profile-bar">
      <select
        value={active.id}
        aria-label="当前配置"
        onChange={(e) => props.onChange({ ...store, activeId: e.target.value })}
      >
        {store.profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="ghost small"
        onClick={() => {
          const name = ask("新配置的名称（从示例开始）", uniqueName("新配置", store));
          if (name) props.onAdd(uniqueName(name, store));
        }}
      >
        新建
      </button>
      <button
        type="button"
        className="ghost small"
        onClick={() => {
          const name = ask("副本的名称", uniqueName(`${active.name} 副本`, store));
          if (name) props.onAdd(uniqueName(name, store), structuredClone(active.profile));
        }}
      >
        复制
      </button>
      <button
        type="button"
        className="ghost small"
        onClick={() => {
          const name = ask("重命名为", active.name);
          if (name && name !== active.name) {
            const unique = uniqueName(name, store);
            props.onChange({ ...store, profiles: store.profiles.map((p) => (p.id === active.id ? { ...p, name: unique } : p)) });
          }
        }}
      >
        重命名
      </button>
      <button
        type="button"
        className="ghost small danger"
        disabled={store.profiles.length < 2}
        onClick={() => {
          if (!confirm(`删除配置「${active.name}」？`)) return;
          const profiles = store.profiles.filter((p) => p.id !== active.id);
          props.onChange({ activeId: profiles[0].id, profiles });
        }}
      >
        删除
      </button>
    </div>
  );
}

export default function App() {
  const [store, setStore] = useState<Store>(loadStore);
  const [toast, setToast] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const active = store.profiles.find((p) => p.id === store.activeId) ?? store.profiles[0];
  const profile = active.profile;
  const setProfile = (update: (p: Profile) => Profile) =>
    setStore((s) => ({
      ...s,
      profiles: s.profiles.map((x) => (x.id === s.activeId ? { ...x, profile: update(x.profile) } : x)),
    }));

  useEffect(() => saveStore(store), [store]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  const issues = useMemo(() => validate(profile), [profile]);
  const configText = useMemo(() => JSON.stringify(generateConfig(profile), null, 2), [profile]);
  const errors = issues.filter((i) => i.level === "error");

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

  const addProfile = (name: string, p?: Profile) => {
    const saved = newSavedProfile(name, p);
    setStore((s) => ({ activeId: saved.id, profiles: [...s.profiles, saved] }));
  };

  const importProfile = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text());
      const name = typeof raw?.name === "string" && raw.name ? raw.name : file.name.replace(/\.json$/i, "");
      addProfile(uniqueName(name, store), normalizeProfile(raw));
      setToast(`已导入为「${name}」`);
    } catch (e) {
      alert(`导入失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>sing-box 配置生成器</h1>
          <p className="muted">纯前端运行，所有配置只保存在当前浏览器，不会上传到任何地方。需要 sing-box 1.14 及以上。</p>
        </div>
        <div className="top-actions">
          <ProfileBar store={store} onChange={setStore} onAdd={addProfile} />
          <button
            type="button"
            className="ghost"
            onClick={() => download(`singbox-confgen-${active.name.replace(/[\\/:*?"<>|]/g, "-")}.json`, JSON.stringify({ name: active.name, ...profile }, null, 2))}
          >
            导出
          </button>
          <button type="button" className="ghost" onClick={() => fileInput.current?.click()}>
            导入
          </button>
          <button
            type="button"
            className="ghost danger"
            onClick={() => {
              if (!confirm("清除本浏览器保存的全部配置，并恢复为示例？")) return;
              clearStore();
              setStore(defaultStore());
            }}
          >
            清除本地数据
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importProfile(f);
              e.target.value = "";
            }}
          />
        </div>
      </header>

      <main className="layout">
        <section className="pane">
          <div className="pane-head">
            <h2>节点</h2>
            <AddNode usedTags={profile.nodes.map((n) => n.tag)} onAdd={(n) => setProfile((p) => ({ ...p, nodes: [...p.nodes, n] }))} />
          </div>
          {profile.nodes.length === 0 && <p className="empty">还没有节点：选择协议模板，点击「添加节点」。</p>}
          {profile.nodes.map((n, i) => (
            <NodeCard
              key={n.id}
              node={n}
              index={i}
              count={profile.nodes.length}
              onChange={(next) => updateNode(i, next)}
              onRemove={() => removeNode(i)}
              onMove={(d) => moveNode(i, d)}
            />
          ))}
          <RoutingCard settings={profile.settings} onChange={setSettings} />

          <div className="pane-head">
            <h2>Tailscale</h2>
            <button
              type="button"
              className="ghost"
              onClick={() =>
                setSettings({
                  tailnets: [
                    ...profile.settings.tailnets,
                    newTailnet({ tag: profile.settings.tailnets.length ? `ts${profile.settings.tailnets.length + 1}` : "ts" }),
                  ],
                })
              }
            >
              添加 tailnet
            </button>
          </div>
          {profile.settings.tailnets.length === 0 && (
            <p className="empty">未使用 Tailscale。需要访问 tailnet 里的设备或内网时，点击「添加 tailnet」。</p>
          )}
          {profile.settings.tailnets.map((t, i) => (
            <TailnetCard
              key={t.id}
              tailnet={t}
              onChange={(next) => setSettings({ tailnets: profile.settings.tailnets.map((x, j) => (j === i ? next : x)) })}
              onRemove={() => setSettings({ tailnets: profile.settings.tailnets.filter((_, j) => j !== i) })}
            />
          ))}

          <SettingsCard settings={profile.settings} onChange={setSettings} />
        </section>

        <section className="pane output">
          <div className="pane-head">
            <h2>生成的配置</h2>
            <div className="row">
              <button
                type="button"
                className="ghost"
                onClick={async () => setToast((await copyText(configText)) ? "已复制到剪贴板" : "复制失败，请手动选择")}
              >
                复制
              </button>
              <button type="button" className="primary" onClick={() => download("config.json", configText)}>
                下载 config.json
              </button>
            </div>
          </div>
          {issues.length > 0 && (
            <ul className="issues">
              {issues.map((i, k) => (
                <li key={k} className={i.level}>
                  {i.level === "error" ? "错误" : "提醒"}：{i.message}
                </li>
              ))}
            </ul>
          )}
          {errors.length > 0 && <p className="muted">存在错误时，sing-box 可能无法加载这份配置。</p>}
          <pre className="code" tabIndex={0}>
            {configText}
          </pre>
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
