// Import nodes and Tailscale tailnets from an existing sing-box config (any version close to
// 1.14, including SFM's re-saved form). Everything else in it (DNS, routing) is left out: the
// generator's own policy replaces it.

import { parseJsonc } from "./generate";
import { newGroup, newNode, newTailnet } from "./defaults";
import { ENDPOINT_TYPES, NODE_TYPES } from "./templates";
import type { ProxyGroup, ProxyNode, Tailnet } from "./types";

type Json = Record<string, any>;

export interface ImportResult {
  nodes: ProxyNode[];
  tailnets: Tailnet[];
  groups: ProxyGroup[];
  /** Things the user should know were left out or changed. */
  notes: string[];
}

/** SFM writes single-item lists as plain values. */
const list = (v: unknown): any[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

const pretty = (o: Json) => JSON.stringify(o, null, 2);

const GROUP_TYPES = ["selector", "urltest"];
/** Group tags the generator creates itself; not imported as user groups. */
const RESERVED_GROUPS = ["proxy", "auto"];

/** Fields the generator fills in or that only make sense in the source config. */
function nodeBody(o: Json, keptResolvers: Set<string>): Json {
  const { tag: _tag, ...body } = o;
  if (typeof body.domain_resolver === "string" && !keptResolvers.has(body.domain_resolver)) delete body.domain_resolver;
  if (typeof body.domain_resolver === "object" && body.domain_resolver && !keptResolvers.has(body.domain_resolver.server)) {
    delete body.domain_resolver;
  }
  // SFM writes server_port 0 next to server_ports.
  if (body.server_port === 0 && body.server_ports) delete body.server_port;
  return body;
}

export function importSingBoxConfig(text: string): ImportResult {
  let config: Json;
  try {
    config = parseJsonc(text) as Json;
  } catch (e) {
    throw new Error(`不是有效的 JSON：${(e as Error).message}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("不是 sing-box 配置：顶层必须是对象");
  const outbounds: Json[] = list(config.outbounds);
  const endpoints: Json[] = list(config.endpoints);
  if (!outbounds.length && !endpoints.length) throw new Error("没有找到 outbounds 或 endpoints，这不像是 sing-box 配置");

  const notes: string[] = [];
  const dnsServers: Json[] = list(config.dns?.servers);
  const dnsRules: Json[] = list(config.dns?.rules);
  const routeRules: Json[] = list(config.route?.rules);
  const groups = outbounds.filter((o) => GROUP_TYPES.includes(o.type));
  // The generator's own entry groups; when present they say which nodes are offered directly.
  const entry = groups.filter((g) => RESERVED_GROUPS.includes(g.tag));
  const grouped = new Set((entry.length ? entry : groups).flatMap((g) => list(g.outbounds)));

  // ---- Tailscale ----
  const tailnets: Tailnet[] = endpoints
    .filter((e) => e.type === "tailscale")
    .map((e) => {
      const { type: _type, tag, ...body } = e;
      const server = dnsServers.find((s) => s.type === "tailscale" && s.endpoint === tag);
      const dnsTag = server?.tag;
      const magicDns = !!dnsTag && dnsRules.some((r) => list(r.preferred_by).includes(dnsTag));
      const dnsDomains = dnsTag
        ? dnsRules.filter((r) => r.server === dnsTag && r.domain_suffix && !r.preferred_by).flatMap((r) => list(r.domain_suffix))
        : [];
      const routes = routeRules
        .filter((r) => r.outbound === tag && !r.preferred_by && (r.domain_suffix || r.ip_cidr))
        .flatMap((r) => [...list(r.domain_suffix), ...list(r.ip_cidr)]);
      return newTailnet({
        tag,
        endpoint: pretty(body),
        magicDns,
        acceptDefaultResolvers: !!server?.accept_default_resolvers,
        dnsDomains,
        routes,
        asProxy: grouped.has(tag),
      });
    });
  const tailnetDns = new Set(dnsServers.filter((s) => s.type === "tailscale").map((s) => s.tag));

  // ---- nodes ----
  // Resolvers that still exist after import: the generator's own servers.
  const keptResolvers = new Set(["local", "remote", ...tailnets.map((t) => `${t.tag}-dns`)]);
  const candidates = [
    ...outbounds.filter((o) => NODE_TYPES.includes(o.type) && !ENDPOINT_TYPES.includes(o.type)),
    ...endpoints.filter((e) => ENDPOINT_TYPES.includes(e.type)),
  ];
  const dropped = new Set<string>();
  const nodes = candidates.map((o) => {
    const resolver = typeof o.domain_resolver === "string" ? o.domain_resolver : o.domain_resolver?.server;
    if (resolver && !keptResolvers.has(resolver) && !tailnetDns.has(resolver)) dropped.add(resolver);
    return newNode({
      tag: o.tag,
      body: pretty(nodeBody(o, keptResolvers)),
      // Without groups in the source, offer every node; otherwise keep helper nodes (e.g. a
      // ShadowTLS detour) out of the groups as they were.
      inGroups: groups.length === 0 || grouped.has(o.tag),
    });
  });
  if (dropped.size) notes.push(`节点里的 domain_resolver（${[...dropped].join("、")}）已去掉，改用本地 DNS 解析节点地址`);

  const skipped = outbounds
    .filter((o) => !NODE_TYPES.includes(o.type) && !GROUP_TYPES.includes(o.type) && !["direct", "block", "dns"].includes(o.type))
    .map((o) => `${o.tag}（${o.type}）`);
  if (skipped.length) notes.push(`不支持作为节点、已跳过：${skipped.join("、")}`);
  if (!nodes.length && !tailnets.length) throw new Error("配置里没有可导入的节点或 Tailscale 端点");

  // ---- groups ----
  const userGroups = groups.filter((g) => !RESERVED_GROUPS.includes(g.tag));
  const imported = userGroups.map((g) => newGroup({ tag: g.tag, type: g.type }));
  const idOf = new Map<string, string>([
    ...nodes.map((n) => [n.tag, n.id] as const),
    ...tailnets.map((t) => [t.tag, t.id] as const),
    ...imported.map((g) => [g.tag, g.id] as const),
  ]);
  const droppedMembers = new Set<string>();
  const kept: ProxyGroup[] = [];
  userGroups.forEach((src, i) => {
    const g = imported[i];
    for (const tag of list(src.outbounds)) {
      if (idOf.has(tag)) g.members.push(idOf.get(tag)!);
      else droppedMembers.add(tag);
    }
    if (src.type === "selector" && typeof src.default === "string" && idOf.has(src.default)) g.defaultMember = idOf.get(src.default)!;
    if (src.type === "urltest") {
      g.testUrl = src.url && src.url !== "https://www.gstatic.com/generate_204" ? src.url : "";
      g.interval = typeof src.interval === "string" && src.interval !== "3m" ? src.interval : "";
      g.tolerance = typeof src.tolerance === "number" && src.tolerance !== 50 ? src.tolerance : null;
    }
    if (g.members.length) kept.push(g);
    else notes.push(`代理组「${g.tag}」没有可导入的成员，已跳过`);
  });
  if (droppedMembers.size) notes.push(`代理组里引用的 ${[...droppedMembers].join("、")} 不是可导入的节点，已从组中去掉`);
  return { nodes, tailnets, groups: kept, notes };
}

/** Rename imported tags that collide with existing ones (`a` → `a-2`). */
export function dedupeTags<T extends { tag: string }>(incoming: T[], existing: string[]): T[] {
  const used = new Set(existing);
  return incoming.map((x) => {
    let tag = x.tag;
    for (let i = 2; used.has(tag); i++) tag = `${x.tag}-${i}`;
    used.add(tag);
    return tag === x.tag ? x : { ...x, tag };
  });
}
