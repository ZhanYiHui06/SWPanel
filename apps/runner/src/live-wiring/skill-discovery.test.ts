import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkill, skillSearchRoots } from "./skill-discovery.js";

const dirs: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), "swpanel-skill-")); dirs.push(path); return path; };
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
function install(root: string, name: string, manifestName: string = name): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${manifestName}\ndescription: test\n---\n# Test\n`);
  return directory;
}

describe("skill discovery", () => {
  it("finds a skill in the usual per-agent folders", () => {
    for (const folder of [[".codex", "skills"], [".agents", "skills"], [".claude", "skills"], [".cursor", "skills"], [".config", "opencode", "skills"]]) {
      const home = temp();
      const expected = install(join(home, ...folder), "solidworks-autobuild");
      const found = discoverSkill("solidworks-autobuild", { env: {}, homeDir: home, cwd: temp(), bundledRoot: null });
      expect(found?.path).toBe(expected);
    }
  });
  it("prefers the bundled skill, then the project folder, then user folders", () => {
    const home = temp(); const cwd = temp(); const bundled = temp();
    const userCopy = install(join(home, ".codex", "skills"), "solidworks-autobuild");
    const projectCopy = install(join(cwd, ".agents", "skills"), "solidworks-autobuild");
    expect(discoverSkill("solidworks-autobuild", { env: {}, homeDir: home, cwd, bundledRoot: bundled })?.path).toBe(projectCopy);
    const bundledCopy = install(bundled, "solidworks-autobuild");
    expect(discoverSkill("solidworks-autobuild", { env: {}, homeDir: home, cwd, bundledRoot: bundled })?.path).toBe(bundledCopy);
    expect(userCopy).not.toBe(bundledCopy);
  });
  it("honours CODEX_HOME and follows symlinked skill folders", () => {
    const home = temp(); const codexHome = temp(); const real = temp();
    install(real, "solidworks-autobuild");
    mkdirSync(join(codexHome, "skills"), { recursive: true });
    symlinkSync(join(real, "solidworks-autobuild"), join(codexHome, "skills", "solidworks-autobuild"));
    const found = discoverSkill("solidworks-autobuild", { env: { CODEX_HOME: codexHome }, homeDir: home, cwd: temp(), bundledRoot: null });
    expect(found?.path).toBe(join(codexHome, "skills", "solidworks-autobuild"));
  });
  it("ignores folders whose SKILL.md names a different skill, or that lack a manifest", () => {
    const home = temp();
    install(join(home, ".codex", "skills"), "solidworks-autobuild", "something-else");
    mkdirSync(join(home, ".agents", "skills", "solidworks-autobuild"), { recursive: true });
    expect(discoverSkill("solidworks-autobuild", { env: {}, homeDir: home, cwd: temp(), bundledRoot: null })).toBeNull();
  });
  it("rejects unsafe skill names and lists each root once", () => {
    expect(discoverSkill("../etc", { env: {}, homeDir: temp(), cwd: temp(), bundledRoot: null })).toBeNull();
    const roots = skillSearchRoots({ env: {}, homeDir: "/h", cwd: "/h", bundledRoot: null });
    expect(new Set(roots).size).toBe(roots.length);
    expect(roots).toContain(join("/h", ".agents", "skills"));
  });
});
