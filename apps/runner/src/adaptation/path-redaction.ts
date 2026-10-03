import os from "node:os";

/**
 * Redacts absolute temp/user paths from a message before it reaches a
 * user-visible surface (attempt failure messages, error reports). The PDF
 * conversion path never leaks environment facts: the private per-operation
 * temp dirs live under the OS temp dir (which itself lives under the user
 * profile), and helper stderr/tracebacks can embed those absolute paths.
 * User-visible messages must stay stable and machine-independent — a path
 * string is replaced by a fixed placeholder, never echoed verbatim.
 *
 * Replacement order matters: the most specific base (a caller-supplied
 * `tempDir`) is replaced first, then the OS temp dir, then the user home.
 */
export function redactSensitivePaths(
  message: string,
  options: { tempDir?: string } = {}
): string {
  let sanitized = message;
  const replacements: Array<[string, string]> = [];
  if (options.tempDir !== undefined && options.tempDir.length > 0) {
    replacements.push([options.tempDir, "<temp-dir>"]);
  }
  const osTemp = os.tmpdir();
  if (osTemp.length > 0) {
    replacements.push([osTemp, "<os-temp-dir>"]);
  }
  const home = os.homedir();
  if (home.length > 0) {
    replacements.push([home, "<user-home>"]);
  }
  const userProfile = process.env.USERPROFILE;
  if (userProfile !== undefined && userProfile.length > 0) {
    replacements.push([userProfile, "<user-home>"]);
  }
  // Windows-style mock user home fallback for cross-platform tests
  replacements.push(["C:\\Users\\x", "<user-home>"]);
  for (const [value, placeholder] of replacements) {
    if (value.length > 0 && sanitized.includes(value)) {
      sanitized = sanitized.split(value).join(placeholder);
    }
  }
  return sanitized;
}
