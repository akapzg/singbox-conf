import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The page makes no network requests and loads nothing from other origins. In production builds
// the browser enforces that: only same-origin scripts, styles and fonts load, and `fetch`/XHR/
// WebSocket are blocked outright. Inline styles are allowed: UI libraries (Base UI, CodeMirror) set
// them, and with no way to send data out (connect/img/font limited to self) and no HTML injection
// point, CSS injection has nothing to exfiltrate through. Not applied to the dev server, whose hot
// reload needs a WebSocket.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
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
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});
