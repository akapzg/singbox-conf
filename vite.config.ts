import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The page makes no network requests and loads nothing from other origins. In production builds
// the browser enforces that: everything but same-origin scripts/styles is blocked, `fetch`/XHR/
// WebSocket included. Not applied to the dev server, whose hot reload needs a WebSocket.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const contentSecurityPolicy = (): Plugin => ({
  name: "content-security-policy",
  apply: "build",
  transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" }],
});

// Relative base so the built `dist/` works from any path or straight from disk-backed static hosting.
export default defineConfig({
  base: "./",
  plugins: [react(), contentSecurityPolicy()],
});
