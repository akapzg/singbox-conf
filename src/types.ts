export interface ProxyNode {
  id: string;
  /** Outbound/endpoint tag. */
  tag: string;
  /** Outbound or endpoint body as JSON with comments; `type` picks the protocol, `tag` is filled in. */
  body: string;
  /** Offer it in the `proxy` selector and the `auto` url-test group. */
  inGroups: boolean;
}

export type Platform = "apple" | "android" | "linux" | "windows";
export type RemoteDnsProvider = "google" | "cloudflare" | "quad9";
export type RemoteDnsProtocol = "tls" | "https";

export interface Tailnet {
  id: string;
  /** Endpoint tag; the DNS server tag is `<tag>-dns`. */
  tag: string;
  /** Endpoint body as JSON (comments allowed). `type` and `tag` are filled in by the generator. */
  endpoint: string;
  /** Resolve MagicDNS names and the tailnet's DNS route suffixes through it. */
  magicDns: boolean;
  /** Also use the tailnet's default (global) resolvers for names routed to it. */
  acceptDefaultResolvers: boolean;
  /** Lines as entered: extra domain suffixes resolved by this tailnet's DNS (split DNS). */
  dnsDomains: string[];
  /** Lines as entered: extra domains or IP prefixes routed through this tailnet. */
  routes: string[];
  /** Offer the endpoint as a choice in the `proxy` selector (e.g. to use an exit node). */
  asProxy: boolean;
}

export interface Settings {
  platform: Platform;
  defaultMode: "GFWList" | "Non-CN" | "Global" | "Direct";
  remoteDns: { provider: RemoteDnsProvider; protocol: RemoteDnsProtocol };
  /** EDNS client subnet sent with queries to the remote resolver; empty disables it. */
  clientSubnet: string;
  /** Clash API listen address; empty disables the API. */
  clashController: string;
  clashSecret: string;
  /** Lines as entered: domains (with subdomains) that always go direct except in Global mode. */
  directDomains: string[];
  /** Lines as entered: domains or IP prefixes that always go through the proxy. */
  proxyRules: string[];
  tailnets: Tailnet[];
  /** Resolve `lancache.steamcontent.com` locally and keep Steam downloads direct in Non-CN mode. */
  steam: boolean;
  /** Reject QUIC to gateway.icloud.com so iCloud falls back to TCP through the rules. */
  blockIcloudQuic: boolean;
}

export interface Profile {
  version: 2;
  nodes: ProxyNode[];
  settings: Settings;
}
