import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { generateConfig } from "../src/generate";
import { dedupeTags, importSingBoxConfig } from "../src/importer";
import { normalize } from "./normalize";
import { sampleProfiles } from "./samples";

const baselineText = readFileSync(new URL("./fixtures/tiger-baseline.json", import.meta.url), "utf8");
const sample = (name: string) => sampleProfiles().find((s) => s.name === name)!.profile;

describe("importing an existing sing-box config", () => {
  const { nodes, tailnets, notes } = importSingBoxConfig(baselineText);

  it("takes the proxy nodes, in order, and keeps them in the groups they were in", () => {
    expect(nodes.map((n) => n.tag)).toEqual(["us-la-99-hy2", "us-la-99-vless", "us-la3-zgo-hy2", "us-la3-zgo-vless"]);
    expect(nodes.every((n) => n.inGroups)).toBe(true);
  });

  it("drops resolvers that will not exist and SFM's server_port 0", () => {
    const hy2 = JSON.parse(nodes[0].body);
    expect(hy2.domain_resolver).toBeUndefined();
    expect(hy2.server_port).toBeUndefined();
    expect(hy2.server_ports).toBe("20000:50000");
    expect(notes.join()).toContain("cn-dns");
  });

  it("takes the tailnets with their DNS and routing options", () => {
    expect(tailnets.map((t) => t.tag)).toEqual(["home", "work"]);
    const [home, work] = tailnets;
    expect(home.magicDns && work.magicDns).toBe(true);
    expect(home.acceptDefaultResolvers).toBe(false);
    expect(work.acceptDefaultResolvers).toBe(true);
    expect(work.dnsDomains).toEqual(["corp.example.com"]);
    expect(JSON.parse(work.endpoint)).toMatchObject({ hostname: "my-mac-2", accept_routes: true });
    expect(JSON.parse(work.endpoint).type).toBeUndefined();
    // The exit node moves into its own field and makes the tailnet a proxy choice.
    expect(JSON.parse(work.endpoint).exit_node).toBeUndefined();
    expect(work.exitNode).toBe("office-gw");
    expect(work.asProxy).toBe(true);
  });

  it.each(["full-apple", "combo-ss-shadowtls"])("round-trips nodes, groups and Tailscale through a generated config (%s)", (name) => {
    const profile = sample(name);
    const config = generateConfig(profile) as any;
    const imported = importSingBoxConfig(JSON.stringify(config));
    // proxy's default and node listing are settings of ours, not imported: map them across by tag.
    const defaultTag = profile.groups.find((g) => g.id === profile.settings.proxyDefault)?.tag;
    const proxyDefault = imported.groups.find((g) => g.tag === defaultTag)?.id ?? "auto";
    const rebuilt = generateConfig({
      ...profile,
      nodes: imported.nodes,
      groups: imported.groups,
      settings: { ...profile.settings, tailnets: imported.tailnets, proxyDefault },
    }) as any;
    expect(normalize(rebuilt.outbounds)).toEqual(normalize(config.outbounds));
    expect(normalize(rebuilt.endpoints)).toEqual(normalize(config.endpoints));
    expect(normalize(rebuilt.dns)).toEqual(normalize(config.dns));
    expect(normalize(rebuilt.route.rules)).toEqual(normalize(config.route.rules));
    expect(imported.notes).toEqual([]);
  });

  it("explains what it cannot use", () => {
    expect(() => importSingBoxConfig("{ nope")).toThrow("不是有效的 JSON");
    expect(() => importSingBoxConfig("[]")).toThrow("顶层必须是对象");
    expect(() => importSingBoxConfig('{"log":{}}')).toThrow("没有找到 outbounds");
    expect(() => importSingBoxConfig('{"outbounds":[{"type":"direct","tag":"d"}]}')).toThrow("没有可导入");
    const r = importSingBoxConfig('{"outbounds":[{"type":"trojan","tag":"t","server":"a.example.org","server_port":443,"password":"p"},{"type":"shadowsocksr","tag":"old"}]}');
    expect(r.nodes.map((n) => n.tag)).toEqual(["t"]);
    expect(r.notes.join()).toContain("old（shadowsocksr）");
  });

  it("accepts comments in the file", () => {
    const r = importSingBoxConfig('{ // exported\n "outbounds": [{"type":"socks","tag":"s","server":"127.0.0.1","server_port":1080}] }');
    expect(r.nodes[0].tag).toBe("s");
  });
});

describe("importing proxy groups", () => {
  const config = {
    outbounds: [
      { type: "selector", tag: "proxy", outbounds: ["auto", "hk", "a"] },
      { type: "urltest", tag: "auto", outbounds: ["a", "b"] },
      { type: "selector", tag: "hk", outbounds: ["a", "b", "direct"], default: "b" },
      { type: "urltest", tag: "fast", outbounds: ["hk", "c"], interval: "3m", tolerance: 80 },
      { type: "urltest", tag: "empty", outbounds: ["direct"] },
      { type: "trojan", tag: "a", server: "a.example.org", server_port: 443, password: "p" },
      { type: "trojan", tag: "b", server: "b.example.org", server_port: 443, password: "p" },
      { type: "trojan", tag: "c", server: "c.example.org", server_port: 443, password: "p" },
      { type: "direct", tag: "direct" },
    ],
  };
  const r = importSingBoxConfig(JSON.stringify(config));
  const id = (tag: string) => [...r.nodes, ...r.groups].find((x) => x.tag === tag)!.id;

  it("imports user groups with members by id, skipping proxy and auto", () => {
    expect(r.groups.map((g) => g.tag)).toEqual(["hk", "fast"]);
    expect(r.groups[0]).toMatchObject({ type: "selector", members: [id("a"), id("b")], defaultMember: id("b") });
    expect(r.groups[1]).toMatchObject({ type: "urltest", members: [id("hk"), id("c")], interval: "", tolerance: 80 });
  });

  it("takes direct offering from proxy/auto, and explains what was dropped", () => {
    expect(r.nodes.map((n) => [n.tag, n.inGroups])).toEqual([
      ["a", true],
      ["b", true],
      ["c", false],
    ]);
    expect(r.notes.join()).toContain("「empty」没有可导入的成员");
    expect(r.notes.join()).toContain("direct");
  });
});

describe("dedupeTags", () => {
  it("renames clashes with existing and earlier incoming tags", () => {
    const out = dedupeTags([{ tag: "a" }, { tag: "a" }, { tag: "b" }], ["a", "a-2"]);
    expect(out.map((x) => x.tag)).toEqual(["a-3", "a-4", "b"]);
  });
});
