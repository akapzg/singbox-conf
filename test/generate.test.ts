import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { generateConfig, nodeObject, parseJsonc, parseRuleList, validate } from "../src/generate";
import { blueprintProfile, newNode, newTailnet } from "../src/defaults";
import { normalizeProfile } from "../src/storage";
import { TEMPLATES, NODE_TYPES } from "../src/templates";
import type { Profile } from "../src/types";
import { normalize } from "./normalize";
import { walk, type Query } from "./dnswalk";

// SFM's tiger.json (sanitized) before the DNS redesign. Non-DNS parts must still match it.
const baseline = normalize(JSON.parse(readFileSync(new URL("./fixtures/tiger-baseline.json", import.meta.url), "utf8"))) as any;
const gen = (p: Profile = blueprintProfile()) => generateConfig(p) as any;

/** The author's own settings, entered the way a user would, reproducing the baseline. */
function personalProfile(): Profile {
  // The baseline's servers, saved by the v1 form editor; loading migrates them to JSON nodes.
  const p = normalizeProfile({
    servers: [
      { name: "us-la-99", host: "us-la-99.example.com" },
      { name: "us-la3-zgo", host: "us-la3-zgo.example.com" },
    ],
  });
  p.settings.steam = true;
  p.settings.blockIcloudQuic = true;
  p.settings.tailnets = [
    newTailnet({
      tag: "home",
      endpoint: `{
        // home tailnet
        "state_directory": "tailscale-main",
        "hostname": "my-mac",
        "accept_routes": true
      }`,
    }),
    newTailnet({
      tag: "work",
      endpoint: `{
        "state_directory": "tailscale-secondary",
        "hostname": "my-mac-2",
        "accept_routes": true,
        "exit_node": "office-gw",
        "exit_node_allow_lan_access": true
      }`,
      acceptDefaultResolvers: true,
      dnsDomains: ["corp.example.com"],
    }),
  ];
  return p;
}

const usesCustomList = (r: any) => /custom-direct-domains|"gfwlist-custom-(domains|ips)"\]/.test(JSON.stringify(r)) && r.outbound === "proxy";

describe("personal settings reproduce the baseline outside DNS", () => {
  const out = normalize(gen(personalProfile())) as any;
  it.each(["log", "http_clients", "endpoints", "inbounds"])("%s", (key) => {
    expect(out[key]).toEqual(baseline[key]);
  });
  it("route, apart from the custom lists and the dropped IPv6 group", () => {
    const isCustomDirect = (r: any) => JSON.stringify(r).includes("custom-direct-domains");
    expect(out.route.rules.filter((r: any) => !isCustomDirect(r) && !usesCustomList(r))).toEqual(
      baseline.route.rules.filter((r: any) => r.outbound !== "proxy-v6"),
    );
    expect(out.route.rule_set.filter((r: any) => !isCustomDirect(r))).toEqual(baseline.route.rule_set);
    const { rule_set: _a, rules: _b, ...rest } = out.route;
    const { rule_set: _c, rules: _d, ...baseRest } = baseline.route;
    expect(rest).toEqual(baseRest);
  });
  it("outbounds, apart from resolving proxy hosts locally and dropping the IPv6 group", () => {
    const expected = baseline.outbounds
      .filter((o: any) => o.tag !== "proxy-v6")
      .map((o: any) => (o.domain_resolver === "cn-dns" ? { ...o, domain_resolver: "local" } : o));
    expect(out.outbounds).toEqual(expected);
  });
  it("experimental", () => {
    expect(out.experimental).toEqual(baseline.experimental);
  });
  it("tailnet DNS servers and rules", () => {
    const tsServers = baseline.dns.servers.filter((s: any) => s.type === "tailscale");
    expect(out.dns.servers.filter((s: any) => s.type === "tailscale")).toEqual(tsServers);
    expect(out.dns.rules.slice(0, 3)).toEqual(baseline.dns.rules.slice(0, 3));
  });
});

describe("default profile carries no personal settings", () => {
  const text = JSON.stringify(gen());
  it.each(['"home"', '"work"', "my-mac", "office-gw", "corp.example.com", "lancache", "steamcontent", "icloud", "tailscale", 'preferred_by":[', "endpoints"])(
    "does not mention %s",
    (word) => expect(text).not.toContain(word),
  );
  it("still resolves local-network names locally", () => {
    expect(gen().dns.rules[0]).toEqual({ preferred_by: "local", action: "route", server: "local" });
  });
});

describe("DNS", () => {
  const dns = gen(personalProfile()).dns;
  const rules: any[] = dns.rules;
  const QTYPES = ["A", "AAAA", "HTTPS", "SVCB"] as const;
  const all = (q: Omit<Query, "qtype">) => QTYPES.map((qtype) => walk(rules, { ...q, qtype }));
  const IPV6_CARRIERS = ["AAAA", "HTTPS", "SVCB"] as const;

  it("has no domestic DoH or IPv6 probe server and references only defined servers", () => {
    const servers = new Set(dns.servers.map((s: any) => s.tag));
    expect(servers.has("cn-dns")).toBe(false);
    expect(servers.has("google-v6-check")).toBe(false);
    for (const r of rules) if (r.server) expect(servers.has(r.server), r.server).toBe(true);
    expect(servers.has(dns.final)).toBe(true);
  });

  it("only matches responses of earlier evaluates", () => {
    const seen = new Set<string>();
    const visit = (r: any, top: any) => {
      if (typeof r.match_response === "string") expect(seen.has(r.match_response), JSON.stringify(top)).toBe(true);
      (r.rules ?? []).forEach((x: any) => visit(x, top));
    };
    for (const r of rules) {
      visit(r, r);
      if (r.action === "evaluate") seen.add(r.tag);
    }
  });

  it("follows the race/speculative constraints", () => {
    const hasMatchResponse = (r: any): boolean => "match_response" in r || (r.rules ?? []).some(hasMatchResponse);
    for (const r of rules) {
      if (r.race) expect(hasMatchResponse(r), JSON.stringify(r)).toBe(true);
      expect(r.race && r.speculative).toBeFalsy();
    }
  });

  it("sends no ECS by default, and the configured subnet only to the remote resolver", () => {
    expect(JSON.stringify(rules)).not.toContain("client_subnet");
    const p = blueprintProfile();
    p.settings.clientSubnet = "203.0.113.0/24";
    const withEcs = gen(p).dns.rules.filter((r: any) => r.client_subnet);
    expect(withEcs.map((r: any) => r.server)).toEqual(["remote"]);
  });

  it("Direct mode never depends on the proxy", () => {
    for (const w of all({ mode: "Direct", publicV6Iface: true })) expect(w).toEqual({ evaluated: [], final: "route:local" });
    expect(walk(rules, { mode: "Direct", qtype: "AAAA", publicV6Iface: false }).final).toBe("predefined:NOERROR");
  });

  it("GFWList: outside gfwlist uses only the local resolver, gfwlist only the remote one", () => {
    for (const w of all({ mode: "GFWList", publicV6Iface: true })) expect(w).toEqual({ evaluated: [], final: "route:local" });
    for (const w of all({ mode: "GFWList", gfw: true, publicV6Iface: true })) {
      expect(w.evaluated).not.toContain("local");
      expect(w.final).not.toBe("route:local");
    }
    expect(walk(rules, { mode: "GFWList", qtype: "A", gfw: true }).evaluated).toEqual(["remote"]);
  });

  it("Non-CN: domestic domains go local; others ask local and remote together", () => {
    for (const w of all({ mode: "Non-CN", cnSite: true, publicV6Iface: true })) expect(w.final).toBe("route:local");
    expect(walk(rules, { mode: "Non-CN", qtype: "A" }).evaluated).toEqual(["local", "remote"]);
    expect(walk(rules, { mode: "Non-CN", qtype: "AAAA" })).toEqual({ evaluated: ["local"], final: "predefined:NOERROR" });
    const remote = rules.filter((r) => r.action === "evaluate" && r.server === "remote");
    expect(remote.every((r) => r.speculative)).toBe(true);
  });

  it("Global: everything, even domestic domains, is resolved through the proxy", () => {
    for (const w of all({ mode: "Global", cnSite: true, publicV6Iface: true })) {
      expect(w.evaluated).not.toContain("local");
      expect(w.evaluated.every((s) => s === "remote")).toBe(true);
    }
  });

  it("proxied domains never get IPv6 addresses, HTTPS or SVCB records", () => {
    const proxied: Omit<Query, "qtype">[] = [{ mode: "GFWList", gfw: true }, { mode: "Non-CN" }, { mode: "Global" }, { mode: "Global", cnSite: true }];
    for (const q of proxied) {
      for (const qtype of IPV6_CARRIERS) {
        const w = walk(rules, { ...q, qtype, publicV6Iface: true });
        expect(w.final, `${JSON.stringify(q)} ${qtype}`).toBe("predefined:NOERROR");
        expect(w.evaluated).not.toContain("remote");
      }
      expect(walk(rules, { ...q, qtype: "A", publicV6Iface: true }).evaluated).toContain("remote");
    }
  });

  it("direct domains keep IPv6, HTTPS and SVCB from the local resolver", () => {
    const direct: Omit<Query, "qtype">[] = [{ mode: "Direct" }, { mode: "GFWList" }, { mode: "Non-CN", cnSite: true }];
    for (const q of direct) {
      for (const qtype of IPV6_CARRIERS) {
        expect(walk(rules, { ...q, qtype, publicV6Iface: true }), `${q.mode} ${qtype}`).toEqual({ evaluated: [], final: "route:local" });
      }
    }
  });

  it.each([
    ["google", "tls", { type: "tls", server: "8.8.8.8", server_port: 853, tls: { enabled: true, server_name: "dns.google" } }],
    ["cloudflare", "https", { type: "https", server: "1.1.1.1", server_port: 443, path: "/dns-query", tls: { enabled: true, server_name: "cloudflare-dns.com" } }],
    ["quad9", "tls", { type: "tls", server: "9.9.9.9", server_port: 853, tls: { enabled: true, server_name: "dns.quad9.net" } }],
  ] as const)("remote resolver %s over %s", (provider, protocol, expected) => {
    const p = blueprintProfile();
    p.settings.remoteDns = { provider, protocol };
    const server = gen(p).dns.servers.find((s: any) => s.tag === "remote");
    expect(server).toEqual({ ...expected, tag: "remote", detour: "proxy" });
  });
});

describe("custom remote DNS server", () => {
  const withCustom = (custom: string) => {
    const p = blueprintProfile();
    p.settings.remoteDns = { ...p.settings.remoteDns, provider: "custom", custom };
    return p;
  };

  it("uses the JSON body, filling in tag and the proxy detour", () => {
    const cfg = gen(withCustom('{ // mine\n "type": "quic", "server": "9.9.9.9", "tls": {"enabled": true, "server_name": "dns.quad9.net"} }'));
    expect(cfg.dns.servers.find((s: any) => s.tag === "remote")).toEqual({
      type: "quic",
      tag: "remote",
      server: "9.9.9.9",
      tls: { enabled: true, server_name: "dns.quad9.net" },
      detour: "proxy",
    });
  });

  it("keeps an explicit detour", () => {
    const cfg = gen(withCustom('{"type":"udp","server":"10.0.0.53","detour":"direct"}'));
    expect(cfg.dns.servers.find((s: any) => s.tag === "remote").detour).toBe("direct");
  });

  it("reports a broken body and falls back to Google so the config still loads", () => {
    const p = withCustom('{"type":"doh","server":"x"}');
    expect(validate(p).map((i) => i.message).join()).toContain("自定义代理 DNS 服务器：type 必须是");
    expect(gen(p).dns.servers.find((s: any) => s.tag === "remote").server).toBe("8.8.8.8");
  });
});

describe("custom direct domains", () => {
  const withList = (lines: string[]) => {
    const p = blueprintProfile();
    p.settings.directDomains = lines;
    return gen(p);
  };
  const ruleSet = (cfg: any) => cfg.route.rule_set.find((r: any) => r.tag === "custom-direct-domains");

  it("is an empty never-matching set by default", () => {
    expect(ruleSet(gen()).rules).toEqual([{ domain_regex: ["a^"] }]);
  });

  it("cleans and de-duplicates entries", () => {
    const cfg = withList(["Example.CN", "*.corp.example.com  # office", "", ".example.cn", "a.b."]);
    expect(ruleSet(cfg).rules).toEqual([{ domain_suffix: ["example.cn", "corp.example.com", "a.b"] }]);
  });

  it("routes listed domains direct in every mode but Global", () => {
    const rules = withList(["example.com"]).route.rules;
    const idx = rules.findIndex((r: any) => JSON.stringify(r).includes("custom-direct-domains"));
    expect(rules[idx].outbound).toBe("direct");
    const gfwIdx = rules.findIndex((r: any) => JSON.stringify(r).includes('"GFWList"') && r.outbound === "direct");
    expect(idx).toBeLessThan(gfwIdx);
  });

  it("resolves listed domains locally, even when they are in gfwlist", () => {
    const rules = withList(["example.com"]).dns.rules;
    for (const mode of ["Direct", "GFWList", "Non-CN"] as const) {
      for (const qtype of ["A", "AAAA", "HTTPS"] as const) {
        expect(walk(rules, { mode, qtype, gfw: true, customDirect: true, publicV6Iface: true }), `${mode} ${qtype}`).toEqual({
          evaluated: [],
          final: "route:local",
        });
      }
    }
    expect(walk(rules, { mode: "Global", qtype: "A", customDirect: true }).evaluated).toEqual(["remote"]);
  });

  it("reports malformed entries", () => {
    const p = blueprintProfile();
    p.settings.directDomains = ["good.example", "bad domain", "http://x.com"];
    const msg = validate(p).find((i) => i.message.includes("直连域名"))?.message ?? "";
    expect(msg).toContain("bad domain");
    expect(msg).toContain("http://x.com");
  });
});

describe("custom proxy domains and IPs", () => {
  const withList = (lines: string[], extra: Partial<Profile["settings"]> = {}) => {
    const p = blueprintProfile();
    p.settings.proxyRules = lines;
    Object.assign(p.settings, extra);
    return gen(p);
  };
  const set = (cfg: any, tag: string) => cfg.route.rule_set.find((r: any) => r.tag === tag).rules;

  it("splits domains and IP prefixes into the two rule-sets", () => {
    const cfg = withList(["Intercom.io", "203.0.113.7", "2001:db8::/32", "10.0.0.0/8  # lab", "bad entry"]);
    expect(set(cfg, "gfwlist-custom-domains")).toEqual([{ domain_suffix: ["intercom.io"] }]);
    expect(set(cfg, "gfwlist-custom-ips")).toEqual([{ ip_cidr: ["203.0.113.7/32", "2001:db8::/32", "10.0.0.0/8"] }]);
  });

  it("keeps placeholders and adds no rules when empty", () => {
    const cfg = withList(["", "  # nothing"]);
    expect(set(cfg, "gfwlist-custom-domains")).toEqual([{ domain_regex: ["a^"] }]);
    expect(cfg.route.rules.some(usesCustomList)).toBe(false);
  });

  it("routes listed entries through the proxy after the direct lists and before mode rules", () => {
    const rules = withList(["intercom.io"]).route.rules;
    const idx = rules.findIndex(usesCustomList);
    const directIdx = rules.findIndex((r: any) => JSON.stringify(r).includes("custom-direct-domains"));
    const modeIdx = rules.findIndex((r: any) => JSON.stringify(r).includes('"GFWList"') && r.outbound === "direct");
    expect(rules[idx]).toEqual({ rule_set: ["gfwlist-custom-domains", "gfwlist-custom-ips"], action: "route", outbound: "proxy" });
    expect(directIdx).toBeLessThan(idx);
    expect(idx).toBeLessThan(modeIdx);
  });

  it("resolves listed domains remotely and IPv4-only, except in Direct mode or when also listed as direct", () => {
    const rules = withList(["intercom.io"]).dns.rules;
    for (const mode of ["GFWList", "Non-CN", "Global"] as const) {
      // Even a domain on the domestic list is proxied once it is listed here.
      expect(walk(rules, { mode, qtype: "A", customProxy: true, cnSite: true }), mode).toEqual({ evaluated: [], final: "route:remote" });
      expect(walk(rules, { mode, qtype: "AAAA", customProxy: true, cnSite: true }).final, mode).toBe("predefined:NOERROR");
    }
    expect(walk(rules, { mode: "Direct", qtype: "A", customProxy: true })).toEqual({ evaluated: [], final: "route:local" });
    expect(walk(rules, { mode: "GFWList", qtype: "A", customProxy: true, customDirect: true })).toEqual({ evaluated: [], final: "route:local" });
  });

  it("parses IPv4, IPv6 and bare addresses", () => {
    expect(parseRuleList("1.2.3.4\n1.2.3.0/24\n::1\nfe80::/10\n300.1.1.1\n1.2.3.4/33")).toEqual({
      domains: [],
      cidrs: ["1.2.3.4/32", "1.2.3.0/24", "::1/128", "fe80::/10"],
      invalid: ["300.1.1.1", "1.2.3.4/33"],
    });
  });
});

describe("Tailscale", () => {
  const withTailnets = (...tailnets: ReturnType<typeof newTailnet>[]) => {
    const p = blueprintProfile();
    p.settings.tailnets = tailnets;
    return p;
  };

  it("fills in type and tag, ignoring any in the JSON", () => {
    const cfg = gen(withTailnets(newTailnet({ tag: "home", endpoint: '{"type":"x","tag":"y","hostname":"h"}' })));
    expect(cfg.endpoints).toEqual([{ type: "tailscale", tag: "home", hostname: "h" }]);
  });

  it("creates the DNS server only when MagicDNS or split DNS is used", () => {
    const none = gen(withTailnets(newTailnet({ tag: "a", magicDns: false })));
    expect(none.dns.servers.some((s: any) => s.type === "tailscale")).toBe(false);
    expect(JSON.stringify(none.dns.rules)).not.toContain("a-dns");
    const split = gen(withTailnets(newTailnet({ tag: "a", magicDns: false, dnsDomains: ["corp.example.com"] })));
    expect(split.dns.servers.find((s: any) => s.tag === "a-dns")).toEqual({ type: "tailscale", tag: "a-dns", endpoint: "a", accept_search_domain: true });
    expect(split.dns.rules[0]).toEqual({ domain_suffix: ["corp.example.com"], action: "route", server: "a-dns" });
    expect(JSON.stringify(split.dns.rules)).not.toContain('"preferred_by":"a-dns"');
  });

  it("routes tailnet devices and extra routes to the endpoint, and keeps them out of the IPv6 reject rule", () => {
    const cfg = gen(withTailnets(newTailnet({ tag: "a", routes: ["10.20.0.0/16", "nas.example.com"] })));
    expect(cfg.route.rules).toContainEqual({ preferred_by: "a", action: "route", outbound: "a" });
    expect(cfg.route.rules).toContainEqual({ domain_suffix: ["nas.example.com"], ip_cidr: ["10.20.0.0/16"], action: "route", outbound: "a" });
    expect(JSON.stringify(cfg.route.rules[0])).toContain('"preferred_by":["a"]');
  });

  it("offers the endpoint in the proxy selector only when asked", () => {
    const off = gen(withTailnets(newTailnet({ tag: "a" })));
    expect(off.outbounds[0].outbounds).not.toContain("a");
    const on = gen(withTailnets(newTailnet({ tag: "a", asProxy: true, endpoint: '{"exit_node":"x"}' })));
    expect(on.outbounds[0].outbounds).toContain("a");
    expect(on.outbounds.find((o: any) => o.tag === "auto").outbounds).not.toContain("a");
  });

  it("validates tags, JSON and state directories", () => {
    const p = withTailnets(
      newTailnet({ tag: "a" }),
      newTailnet({ tag: "a" }),
      newTailnet({ tag: "b", endpoint: "{ not json" }),
      newTailnet({ tag: "hy2-1" }),
      newTailnet({ tag: "c", asProxy: true, endpoint: '{"state_directory":"c"}' }),
    );
    const msgs = validate(p).map((i) => i.message).join("\n");
    expect(msgs).toContain("标签重复：a");
    expect(msgs).toContain("标签重复：hy2-1");
    expect(msgs).toContain("JSON 有误");
    expect(msgs).toContain("state_directory「tailscale」");
    expect(msgs).toContain("没有设置 exit_node");
  });

  it("parses JSON with comments but keeps // inside strings", () => {
    expect(parseJsonc('{ // c\n "u": "https://x//y", /* block */ "n": 1 }')).toEqual({ u: "https://x//y", n: 1 });
  });
});

describe("platform and modes", () => {
  it("enables auto_redirect only on Linux", () => {
    for (const platform of ["apple", "android", "windows", "linux"] as const) {
      const p = blueprintProfile();
      p.settings.platform = platform;
      expect(!!gen(p).inbounds[0].auto_redirect, platform).toBe(platform === "linux");
    }
  });

  it("uses the configured default mode", () => {
    const p = blueprintProfile();
    p.settings.defaultMode = "Non-CN";
    expect(gen(p).experimental.clash_api.default_mode).toBe("Non-CN");
  });
});

describe("nodes", () => {
  const withNodes = (...nodes: ReturnType<typeof newNode>[]) => {
    const p = blueprintProfile();
    p.nodes = nodes;
    return p;
  };

  it("migrates v1 form servers into nodes with the same tags", () => {
    expect(personalProfile().nodes.map((n) => n.tag)).toEqual(["us-la-99-hy2", "us-la-99-vless", "us-la3-zgo-hy2", "us-la3-zgo-vless"]);
  });

  it("every template is a known type and produces a node without errors once filled in", () => {
    const ids = new Set<string>();
    for (const t of TEMPLATES) {
      ids.add(t.id);
      const { object, error } = nodeObject(newNode({ tag: "x", body: t.body }));
      expect(error, t.id).toBeUndefined();
      expect(NODE_TYPES, t.id).toContain(object!.type);
      const errors = validate(withNodes(newNode({ tag: "x", body: t.body }))).filter((i) => i.level === "error");
      expect(errors, t.id).toEqual([]);
    }
    expect(ids.size).toBe(TEMPLATES.length);
    expect(new Set(TEMPLATES.map((t) => JSON.stringify(nodeObject(newNode({ body: t.body })).object!.type)))).toEqual(
      new Set(NODE_TYPES.map((t) => JSON.stringify(t))),
    );
  });

  it("puts endpoint types under endpoints and the rest under outbounds", () => {
    const wg = TEMPLATES.find((t) => t.id === "wireguard")!;
    const cfg = gen(withNodes(newNode({ tag: "hy" }), newNode({ tag: "wg", body: wg.body })));
    expect(cfg.endpoints.map((e: any) => e.tag)).toEqual(["wg"]);
    expect(cfg.outbounds.map((o: any) => o.tag)).toEqual(["proxy", "auto", "hy", "direct"]);
    expect(cfg.outbounds[1].outbounds).toEqual(["hy", "wg"]);
  });

  it("fills in tag and the local domain resolver unless set", () => {
    const cfg = gen(
      withNodes(
        newNode({ tag: "a", body: '{"type":"trojan","tag":"ignored","server":"s.example.org","server_port":443,"password":"p"}' }),
        newNode({ tag: "b", body: '{"type":"trojan","server":"s.example.org","server_port":443,"password":"p","domain_resolver":"remote"}' }),
      ),
    );
    expect(cfg.outbounds[2]).toEqual({ type: "trojan", tag: "a", server: "s.example.org", server_port: 443, password: "p", domain_resolver: "local" });
    expect(cfg.outbounds[3].domain_resolver).toBe("remote");
  });

  it("leaves nodes out of the groups when asked", () => {
    const cfg = gen(withNodes(newNode({ tag: "a" }), newNode({ tag: "helper", inGroups: false })));
    expect(cfg.outbounds[0].outbounds).toEqual(["auto", "a"]);
    expect(cfg.outbounds[1].outbounds).toEqual(["a"]);
    expect(cfg.outbounds.map((o: any) => o.tag)).toContain("helper");
  });

  it("validates JSON, type, server, detour and empty secrets", () => {
    const msgs = validate(
      withNodes(
        newNode({ tag: "bad", body: "{ nope" }),
        newNode({ tag: "unknown", body: '{"type":"vless2"}' }),
        newNode({ tag: "noserver", body: '{"type":"trojan","password":"p"}' }),
        newNode({ tag: "detour", body: '{"type":"shadowsocks","server":"s.example.org","method":"none","password":"p","detour":"nowhere"}' }),
        newNode({ tag: "empty", body: '{"type":"trojan","server":"s.example.org","password":""}' }),
      ),
    )
      .map((i) => i.message)
      .join("\n");
    expect(msgs).toContain("节点「bad」：JSON 有误");
    expect(msgs).toContain("节点「unknown」：type 必须是");
    expect(msgs).toContain("节点「noserver」：缺少 server");
    expect(msgs).toContain("「nowhere」不存在");
    expect(msgs).toContain("节点「empty」：password 为空");
    const reality = TEMPLATES.find((t) => t.id === "vless-reality")!;
    const nested = validate(withNodes(newNode({ tag: "r", body: reality.body }))).map((i) => i.message);
    expect(nested).toContain("节点「r」：tls.reality.public_key 为空，sing-box 可能无法加载");
  });

  it("checks Shadowsocks 2022 keys like sing-box does", () => {
    const ss = (method: string, password: string) =>
      validate(withNodes(newNode({ tag: "ss", body: JSON.stringify({ type: "shadowsocks", server: "s.example.org", server_port: 1, method, password }) })))
        .filter((i) => i.message.includes("base64 密钥"))
        .map((i) => i.message);
    expect(ss("2022-blake3-aes-128-gcm", "dummy-pass")).toHaveLength(1);
    expect(ss("2022-blake3-aes-128-gcm", "UPFTpZE0Gb2XVeTW9VNioQ==")).toEqual([]);
    expect(ss("2022-blake3-aes-256-gcm", "UPFTpZE0Gb2XVeTW9VNioQ==")).toHaveLength(1);
    expect(ss("2022-blake3-chacha20-poly1305", "fuQQqj0+RRUmmQ/to1EvkWkzyEU7m4ZS40+qiz2zmfQ=")).toEqual([]);
    expect(ss("2022-blake3-aes-128-gcm", "UPFTpZE0Gb2XVeTW9VNioQ==:UPFTpZE0Gb2XVeTW9VNioQ==")).toEqual([]);
    expect(ss("aes-128-gcm", "anything")).toEqual([]);
  });

  it("requires at least one node in the groups", () => {
    const msgs = validate(withNodes(newNode({ tag: "a", inGroups: false }))).map((i) => i.message);
    expect(msgs).toContain("至少要有一个节点加入代理组");
  });
});

describe("validate", () => {
  it("flags duplicate tags, including clashes with reserved ones", () => {
    const p = blueprintProfile();
    p.nodes[1].tag = p.nodes[0].tag;
    p.nodes.push(newNode({ tag: "direct" }));
    const msgs = validate(p).map((i) => i.message).join("\n");
    expect(msgs).toContain(`标签重复：${p.nodes[0].tag}`);
    expect(msgs).toContain("标签重复：direct");
  });

  it("flags a malformed ECS subnet and proxy list entries", () => {
    const p = blueprintProfile();
    p.settings.clientSubnet = "hangzhou";
    p.settings.proxyRules = ["bad entry"];
    const msgs = validate(p).map((i) => i.message).join("\n");
    expect(msgs).toContain("ECS");
    expect(msgs).toContain("代理域名或 IP");
  });
});
