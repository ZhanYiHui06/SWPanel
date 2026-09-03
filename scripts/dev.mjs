import { spawn } from "node:child_process";

const workspaceRoot = new URL("../", import.meta.url);
const developmentUrl = "http://127.0.0.1:5173";
const children = new Set();
let stopping = false;

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 */
function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: workspaceRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
    ...options
  });
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    if (!stopping && code !== 0) {
      stop(code ?? 1);
    }
  });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    child.kill();
  }
  process.exitCode = code;
}

async function waitForRenderer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(developmentUrl);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Renderer did not start at ${developmentUrl}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop());
}

const electronBuild = run("npm", ["run", "build:electron", "--workspace", "@swpanel/desktop"]);
const buildCode = await new Promise((resolve) => electronBuild.once("exit", resolve));
if (buildCode !== 0) {
  stop(typeof buildCode === "number" ? buildCode : 1);
} else {
  run("npm", ["run", "dev:renderer", "--workspace", "@swpanel/desktop"]);
  await waitForRenderer();
  // The development renderer is authorized ONLY by this dedicated CLI argument
  // on an unpackaged launch; SWPANEL_RENDERER_URL / SWPANEL_DEVELOPMENT_RENDERER
  // environment variables are completely ignored by the main process.
  run("electron", [
    "apps/desktop/dist/main/main.js",
    "--swpanel-development-renderer=http://127.0.0.1:5173/"
  ]);
}
