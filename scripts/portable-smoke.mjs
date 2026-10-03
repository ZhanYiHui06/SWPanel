// Smoke test of an assembled portable folder, using ITS OWN node.exe and python.exe.
//   node scripts/portable-smoke.mjs portable/SWPanel
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "portable/SWPanel");
const exe = process.platform === "win32" ? ".exe" : "";
const nodeBin = path.join(root, "node", `node${exe}`);
const pythonBin = path.join(root, "python", `python${exe}`);
const port = 3190;

/** @param {string} message */
function fail(message) { console.error(`SMOKE FAILED: ${message}`); process.exitCode = 1; }

// 1. The bundled Python can import everything the product needs.
const modules = ["pypdfium2", "PIL", "pydantic", "ezdxf", "matplotlib", "comtypes", "mcp"];
if (process.platform === "win32") modules.push("win32com.client", "pythoncom");
const imports = spawnSync(pythonBin, ["-c", `import ${modules.join(", ")}; print("python imports ok")`], { encoding: "utf8" });
console.log(imports.stdout, imports.stderr);
if (imports.status !== 0) { fail("bundled python imports"); process.exit(1); }

// 2. The server starts with the bundled Node and serves both the UI and the API.
const dataRoot = mkdtempSync(path.join(tmpdir(), "swpanel-smoke-"));
const server = spawn(nodeBin, [path.join(root, "app", "apps", "runner", "dist", "start-server.js")], {
  env: { ...process.env, PORT: String(port), SWPANEL_DATA_ROOT: dataRoot, PATH: `${path.join(root, "python")}${path.delimiter}${process.env.PATH}` },
  stdio: ["ignore", "pipe", "pipe"]
});
let log = "";
server.stdout.on("data", (chunk) => { log += chunk; });
server.stderr.on("data", (chunk) => { log += chunk; });

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return await response.json();
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("server did not become healthy");
}

try {
  const health = await waitForHealth();
  console.log("health", JSON.stringify(health));
  const index = await fetch(`http://127.0.0.1:${port}/`);
  const html = await index.text();
  if (!index.ok || !html.includes('id="root"')) fail(`GET / did not return the web UI (${index.status})`);
  const asset = /src="(\.?\/?assets\/[^"]+\.js)"/.exec(html)?.[1];
  if (asset === undefined) fail("index.html does not reference a script asset");
  else {
    const script = await fetch(new URL(asset.replace(/^\.?\//, "/"), `http://127.0.0.1:${port}`));
    if (!script.ok) fail(`asset ${asset} -> ${script.status}`);
  }
  const settings = await (await fetch(`http://127.0.0.1:${port}/api/settings/auth-mode`)).json();
  if (settings.ok !== true) fail("settings API not reachable");
  console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE OK");
} catch (error) {
  fail(String(error));
  console.error(log);
} finally {
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(dataRoot, { recursive: true, force: true });
}
