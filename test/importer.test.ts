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
    expect(JSON.parse(work.endpoint)).toMatchObject({ hostname: "my-mac-2", exit_node: "office-gw", accept_routes: true });
    expect(JSON.parse(work.endpoint).type).toBeUndefined();
  });

  it.each(["full-apple", "combo-ss-shadowtls"])("round-trips nodes and Tailscale through a generated config (%s)", (name) => {
    const profile = sample(name);
    const config = generateConfig(profile) as any;
    const imported = importSingBoxConfig(JSON.stringify(config));
    const rebuilt = generateConfig({ ...profile, nodes: imported.nodes, settings: { ...profile.settings, tailnets: imported.tailnets } }) as any;
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

describe("dedupeTags", () => {
  it("renames clashes with existing and earlier incoming tags", () => {
    const out = dedupeTags([{ tag: "a" }, { tag: "a" }, { tag: "b" }], ["a", "a-2"]);
    expect(out.map((x) => x.tag)).toEqual(["a-3", "a-4", "b"]);
  });
});
