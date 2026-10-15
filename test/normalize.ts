// Canonical form for comparing configs that differ only in sing-box's serialization style
// (SFM re-saves configs: single-item arrays become strings, defaults are dropped, durations expand).
const LIST_KEYS = new Set([
  "domain", "domain_suffix", "domain_regex", "ip_cidr", "rule_set", "query_type", "network",
  "default_interface_address", "server_ports", "alpn", "address", "neighbor_domain", "preferred_by", "port",
]);
const DURATIONS: Record<string, string> = { "24h0m0s": "1d", "3m0s": "3m", "30m0s": "30m" };

export function normalize(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => normalize(x));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = normalize(x, k);
    for (const k of Object.keys(o)) if (LIST_KEYS.has(k) && !Array.isArray(o[k])) o[k] = [o[k]];
    if (o.method === "default") delete o.method;
    if (o.format === "binary") delete o.format;
    if (o.type === "inline") delete o.type;
    if (o.server_port === 0) delete o.server_port;
    if (o.accept_default_resolvers === false) delete o.accept_default_resolvers;
    if (o.secret === "") delete o.secret;
    if (key === "" && "detour" in o && o.version === 2) delete o.version;
    if (!("action" in o) && ("outbound" in o || ("server" in o && !("type" in o && o.type !== "logical")))) o.action = "route";
    return o;
  }
  if (typeof v === "string" && v in DURATIONS) return DURATIONS[v];
  return v;
}
