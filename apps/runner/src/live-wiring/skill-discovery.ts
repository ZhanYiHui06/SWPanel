import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DiscoveredSkill {
  /** Absolute path of the skill directory (as found, symlinks are not resolved). */
  readonly path: string;
  /** The skills root it was found in, for display. */
  readonly root: string;
}

export interface SkillSearchOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly cwd?: string;
  /** Skills shipped with this repository; `null` disables the bundled lookup. */
  readonly bundledRoot?: string | null;
}

/** The `skills/` folder of this checkout (apps/runner/{src,dist}/live-wiring -> repo root). */
function defaultBundledRoot(): string {
  return fileURLToPath(new URL("../../../../skills", import.meta.url));
}

/**
 * Skill roots searched in priority order: the repository's bundled skills
 * (matches the product version), the project-level `.agents/skills`, then the
 * per-user folders used by Codex and other coding agents.
 */
export function skillSearchRoots(options: SkillSearchOptions = {}): string[] {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const bundled = options.bundledRoot === undefined ? defaultBundledRoot() : options.bundledRoot;
  const roots = [
    ...(bundled === null ? [] : [bundled]),
    join(cwd, ".agents", "skills"),
    ...(env.CODEX_HOME?.trim() ? [join(env.CODEX_HOME.trim(), "skills")] : []),
    join(home, ".codex", "skills"),
    join(home, ".agents", "skills"),
    join(home, ".claude", "skills"),
    join(home, ".cursor", "skills"),
    join(home, ".gemini", "skills"),
    join(home, ".config", "opencode", "skills"),
    join(home, ".config", "agents", "skills")
  ];
  return [...new Set(roots)];
}

function isSkillDirectory(directory: string, skillName: string): boolean {
  try {
    if (!statSync(directory).isDirectory()) return false;
    const manifest = join(directory, "SKILL.md");
    if (!statSync(manifest).isFile()) return false;
    // The frontmatter name must match, so a same-named but different skill is never picked.
    const head = readFileSync(manifest, "utf8").slice(0, 4096);
    return new RegExp(`^name:\\s*["']?${skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*$`, "m").test(head);
  } catch {
    return false;
  }
}

/** Finds the named skill in the usual agent skill folders; null when none has it. */
export function discoverSkill(skillName: string, options: SkillSearchOptions = {}): DiscoveredSkill | null {
  if (!/^[A-Za-z0-9._-]+$/.test(skillName)) return null;
  for (const root of skillSearchRoots(options)) {
    const candidate = join(root, skillName);
    if (existsSync(candidate) && isSkillDirectory(candidate, skillName)) {
      try { realpathSync(candidate); } catch { continue; }
      return { path: candidate, root: dirname(candidate) };
    }
  }
  return null;
}
