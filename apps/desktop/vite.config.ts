import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Web development CSP - decouple from Electron security module
const WEB_DEVELOPMENT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws://127.0.0.1:5173 http://127.0.0.1:*",
  "object-src 'self'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'self'"
].join("; ");

const desktopRoot = fileURLToPath(new URL(".", import.meta.url));
const contentSecurityPolicyMetaPattern =
  /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]+("\s*\/?>)/;

function webCsp(development: boolean): Plugin {
  return {
    name: "swpanel:web-csp",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace(
          contentSecurityPolicyMetaPattern,
          `$1${development ? WEB_DEVELOPMENT_CONTENT_SECURITY_POLICY : WEB_DEVELOPMENT_CONTENT_SECURITY_POLICY.replace("script-src 'self' 'unsafe-inline'", "script-src 'self'").replace("connect-src 'self' ws://127.0.0.1:5173 http://127.0.0.1:*", "connect-src 'self'")}$2`
        );
      }
    }
  };
}

export default defineConfig(({ command, mode }) => ({
  root: desktopRoot,
  base: "./",
  plugins: [...(command === "serve" || mode === "web" ? [webCsp(command === "serve")] : []), react()],
  build: {
    outDir: path.join(desktopRoot, "dist/renderer"),
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true
      }
    }
  }
}));
