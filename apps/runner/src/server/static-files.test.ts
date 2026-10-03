import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveStaticFile } from "./static-files.js";

let root: string;
let outside: string;
let server: Server;
let port: number;

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), "swpanel-static-"));
  root = join(base, "web");
  outside = join(base, "secret.txt");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>SWPanel</title>");
  writeFileSync(join(root, "assets", "app-abc123.js"), "console.log(1)");
  writeFileSync(outside, "TOP-SECRET");
  symlinkSync(outside, join(root, "assets", "link.txt"));
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (!serveStaticFile(root, req, res, pathname)) { res.writeHead(404); res.end("nope"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(join(root, ".."), { recursive: true, force: true });
});

function get(path: string, method = "GET"): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    // `path` is sent verbatim (no client-side normalisation) to exercise traversal.
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("static web UI serving", () => {
  it("serves index.html at / without caching and hashed assets as immutable", async () => {
    const index = await get("/");
    expect(index.status).toBe(200);
    expect(index.body).toContain("SWPanel");
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.headers["cache-control"]).toBe("no-store");
    const asset = await get("/assets/app-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(asset.headers["x-content-type-options"]).toBe("nosniff");
  });
  it("answers HEAD without a body and refuses other methods", async () => {
    const head = await get("/", "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect((await get("/", "POST")).status).toBe(404);
  });
  it("404s missing files and never leaves the web root", async () => {
    expect((await get("/missing.js")).status).toBe(404);
    for (const attack of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/..%2fsecret.txt", "/%5c..%5csecret.txt", "/assets/%00.js", "/%E0%A4%A"]) {
      const result = await get(attack);
      expect(result.status, attack).toBe(404);
      expect(result.body, attack).not.toContain("TOP-SECRET");
    }
  });
  it("does not follow a symlink that points outside the web root", async () => {
    const result = await get("/assets/link.txt");
    expect(result.status).toBe(404);
    expect(result.body).not.toContain("TOP-SECRET");
  });
  it("does not serve directories", async () => {
    expect((await get("/assets")).status).toBe(404);
  });
});
