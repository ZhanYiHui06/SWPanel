import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["src/**/*.test.ts"],
    // SQLite migrations and the Windows named-pipe ACL read-back are slow on CI runners.
    testTimeout: 30_000
  }
});
