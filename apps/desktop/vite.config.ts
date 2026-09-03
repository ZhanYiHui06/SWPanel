import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { DEVELOPMENT_CONTENT_SECURITY_POLICY } from "./src/main/security.js";

const desktopRoot = fileURLToPath(new URL(".", import.meta.url));
const contentSecurityPolicyMetaPattern =
  /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]+("\s*\/?>)/;

function electronDevelopmentCsp(): Plugin {
  return {
    name: "swpanel:electron-development-csp",
    apply: "serve",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace(
          contentSecurityPolicyMetaPattern,
          `$1${DEVELOPMENT_CONTENT_SECURITY_POLICY}$2`
        );
      }
    }
  };
}

export default defineConfig({
  root: desktopRoot,
  base: "./",
  plugins: [electronDevelopmentCsp(), react()],
  build: {
    outDir: path.join(desktopRoot, "dist/renderer"),
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
