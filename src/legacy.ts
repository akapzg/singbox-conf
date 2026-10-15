// Version 1 profiles described servers with a Hysteria2/VLESS form. Kept only to migrate them.

export interface Hysteria2Options {
  enabled: boolean;
  /** Port ranges for port hopping, e.g. ["20000:50000"]. */
  ports: string[];
  hopInterval: string;
  upMbps: number;
  downMbps: number;
  password: string;
  /** TLS server name; empty means use the server host. */
  sni: string;
}

export interface VlessOptions {
  enabled: boolean;
  port: number;
  uuid: string;
  flow: string;
  /** TLS server name; empty means use the server host. */
  sni: string;
  alpn: string[];
}

export interface LegacyServer {
  id: string;
  /** Used as the outbound tag prefix: `<name>-hy2`, `<name>-vless`. */
  name: string;
  host: string;
  hy2: Hysteria2Options;
  vless: VlessOptions;
}


const LEGACY_DEFAULTS = {
  hy2: { enabled: true, ports: ["20000:50000"], hopInterval: "30s", upMbps: 50, downMbps: 300, password: "", sni: "" },
  vless: { enabled: true, port: 443, uuid: "", flow: "xtls-rprx-vision", sni: "", alpn: ["h2", "http/1.1"] },
};

/** Convert v1 form servers into JSON nodes that generate the same outbounds. */
export function legacyServersToNodes(servers: Partial<LegacyServer>[]): { tag: string; body: string }[] {
  const nodes: { tag: string; body: string }[] = [];
  const json = (o: object) => JSON.stringify(o, null, 2);
  for (const raw of servers) {
    const name = raw.name ?? "";
    const host = raw.host ?? "";
    const hy2 = { ...LEGACY_DEFAULTS.hy2, ...(raw.hy2 ?? {}) };
    const vless = { ...LEGACY_DEFAULTS.vless, ...(raw.vless ?? {}) };
    if (hy2.enabled) {
      nodes.push({
        tag: `${name}-hy2`,
        body: json({
          type: "hysteria2",
          server: host,
          server_ports: hy2.ports,
          hop_interval: hy2.hopInterval,
          up_mbps: hy2.upMbps,
          down_mbps: hy2.downMbps,
          password: hy2.password,
          tls: { enabled: true, server_name: hy2.sni || host },
        }),
      });
    }
    if (vless.enabled) {
      nodes.push({
        tag: `${name}-vless`,
        body: json({
          type: "vless",
          server: host,
          server_port: vless.port,
          uuid: vless.uuid,
          ...(vless.flow ? { flow: vless.flow } : {}),
          tls: { enabled: true, server_name: vless.sni || host, ...(vless.alpn.length ? { alpn: vless.alpn } : {}) },
        }),
      });
    }
  }
  return nodes;
}
