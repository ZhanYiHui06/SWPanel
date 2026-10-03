// Assembles the Windows portable package: Node + Python runtimes, the built web UI
// and runner, the SolidWorks skill and start.bat, then zips it.
//
//   node scripts/build-portable.mjs [--skip-runtime] [--no-zip]
//
// Prerequisite: `npm run build:web` (packages + web renderer). `--skip-runtime`
// leaves out the downloaded Node/Python (layout dry-run on any OS).
import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const withRuntime = !args.has("--skip-runtime");
const zipIt = !args.has("--no-zip");

const PYTHON_VERSION = "3.12.10";
const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py";
const NODE_URL = `https://nodejs.org/dist/${process.version}/node-${process.version}-win-x64.zip`;

/**
 * @param {string} command
 * @param {string[]} commandArgs
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 */
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} failed (${result.status ?? result.error?.message})`);
}

/**
 * @param {string} url
 * @param {string} destination
 */
async function download(url, destination) {
  console.log(`download ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed ${response.status}: ${url}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

function bundleId() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" });
  return git.status === 0 ? git.stdout.trim() : new Date().toISOString().replace(/\D/g, "").slice(0, 12);
}

const id = bundleId();
const stage = path.join(repo, "portable");
const root = path.join(stage, "SWPanel");
const app = path.join(root, "app");

const required = [
  "apps/runner/dist/start-server.js",
  "apps/desktop/dist/renderer/index.html",
  "packages/contracts/dist/index.js",
  "packages/domain/dist/index.js"
];
for (const file of required) {
  if (!existsSync(path.join(repo, file))) throw new Error(`missing ${file}; run \`npm run build:web\` first`);
}

await rm(stage, { recursive: true, force: true });
await mkdir(app, { recursive: true });

// Runner + web UI keep the repository layout so import.meta-relative lookups work.
await cp(path.join(repo, "apps/runner/dist"), path.join(app, "apps/runner/dist"), { recursive: true });
await cp(path.join(repo, "apps/runner/package.json"), path.join(app, "apps/runner/package.json"));
await cp(path.join(repo, "apps/desktop/dist/renderer"), path.join(app, "apps/desktop/dist/renderer"), { recursive: true });
// Workspace packages become real folders (no symlinks in the zip).
for (const name of ["contracts", "domain"]) {
  const target = path.join(app, "node_modules/@swpanel", name);
  await mkdir(target, { recursive: true });
  await cp(path.join(repo, "packages", name, "package.json"), path.join(target, "package.json"));
  await cp(path.join(repo, "packages", name, "dist"), path.join(target, "dist"), { recursive: true });
}
await cp(path.join(repo, "skills/solidworks-autobuild"), path.join(app, "skills/solidworks-autobuild"), {
  recursive: true,
  filter: (source) => !/(^|[\\/])(__pycache__|\.git|\.pytest_cache)([\\/]|$)/.test(source) && !source.endsWith(".pyc")
});
await writeFile(path.join(app, "skills/solidworks-autobuild/.swpanel-bundle-id"), `${id}\n`);

await cp(path.join(repo, "scripts/portable/start.bat"), path.join(root, "start.bat"));
await cp(path.join(repo, "scripts/portable/README-WINDOWS.txt"), path.join(root, "README-WINDOWS.txt"));
await writeFile(path.join(root, "VERSION.txt"), `commit ${id}\nnode ${process.version}\npython ${PYTHON_VERSION}\n`);

if (withRuntime) {
  const tmp = path.join(stage, "downloads");
  await mkdir(tmp, { recursive: true });

  // Node: only node.exe is needed (the server has no npm dependencies).
  const nodeZip = path.join(tmp, "node.zip");
  await download(NODE_URL, nodeZip);
  await mkdir(path.join(root, "node"), { recursive: true });
  run("tar", ["-xf", nodeZip, "-C", path.join(root, "node"), "--strip-components=1", `node-${process.version}-win-x64/node.exe`]);

  // Python: embeddable distribution + pip + the skill's requirements.
  const python = path.join(root, "python");
  const pythonZip = path.join(tmp, "python.zip");
  await download(PYTHON_EMBED_URL, pythonZip);
  await mkdir(python, { recursive: true });
  run("tar", ["-xf", pythonZip, "-C", python]);
  const pth = (await readdir(python)).find((name) => /^python\d+\._pth$/.test(name));
  if (pth === undefined) throw new Error("embedded python ._pth not found");
  const stem = pth.replace("._pth", "");
  // `import site` is required so pip-installed packages and pywin32's .pth are honoured.
  await writeFile(path.join(python, pth), `${stem}.zip\n.\nLib\\site-packages\nimport site\n`);
  const getPip = path.join(tmp, "get-pip.py");
  await download(GET_PIP_URL, getPip);
  const pythonExe = path.join(python, "python.exe");
  run(pythonExe, [getPip, "--no-warn-script-location", "--disable-pip-version-check"]);
  run(pythonExe, [
    "-m", "pip", "install", "--no-warn-script-location", "--disable-pip-version-check", "--no-cache-dir",
    "-r", path.join(repo, "skills/solidworks-autobuild/requirements.txt"),
    "pypdfium2==4.30.0", "Pillow==11.3.0"
  ]);
  await rm(tmp, { recursive: true, force: true });
}

console.log(`assembled ${root}`);
if (zipIt) {
  const zip = path.join(stage, `SWPanel-win-x64-${id}.zip`);
  await rm(zip, { force: true });
  run("tar", ["-a", "-cf", zip, "-C", stage, "SWPanel"]);
  console.log(`zip ${zip}`);
}
