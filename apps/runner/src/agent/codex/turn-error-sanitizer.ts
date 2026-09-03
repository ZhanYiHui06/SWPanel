/**
 * Sanitizer of Codex turn failure messages (Phase 5, P5-3). The raw
 * `turn.error.message` of a failed `turn/completed` notification is technical
 * server text that can embed host paths, URLs and credential-like fragments —
 * the persisted technical session note carries a DETERMINISTIC, bounded and
 * redacted digest of it, NEVER the raw text. The product-facing failure
 * surface stays generic: the adapter throws the typed {@link AgentTurnError}
 * with a fixed message and unchanged code; the sanitized text only ever
 * reaches the technical session record (`runtime/agent-session.json`), never
 * the raw agent log and never product records.
 *
 * The sanitizer is a pure function of the error message (no clocks, no
 * environment-dependent values — same input always yields the same output)
 * and only ever receives the turn `errorMessage`: raw reasoning / item
 * content never enters it, by construction of the adapter wiring.
 *
 * Rules, applied in order:
 * - non-string / absent / blank input → the stable generic diagnostic
 *   {@link CODEX_TURN_FAILED_GENERIC_DIAGNOSTIC};
 * - full URLs (`scheme://...`, any scheme) are redacted wholesale — their
 *   query / fragment can embed tokens and are never split into detail;
 * - likely secrets are redacted: `Bearer` / `Basic` credential values,
 *   JWT-like tokens, and `apiKey` / `token` / `password` / `secret`-style
 *   `key=value` / `key: value` assignments (the value is replaced, the key
 *   name is kept so the diagnostic stays readable). Secret keys may be
 *   underscore/hyphen-prefixed or -suffixed (`DB_PASSWORD`, `x-api-key`,
 *   `API_TOKEN_2`); a quoted value is consumed through its matching closing
 *   quote (spaces included), an unquoted value stops at the first safe
 *   delimiter (whitespace / quote / backtick / `,` / `;` / `)`);
 * - absolute host paths are redacted: Windows drive paths, UNC paths and
 *   POSIX absolute paths. Paths may contain spaces: after a space, a
 *   following chunk is still part of the path when it contains a `\` or `/`
 *   separator, so `C:\Program Files\SolidWorks\x.sldprt` and
 *   `/home/my user/.codex/config` are consumed whole instead of leaving a
 *   raw tail (a `/` preceded by a word character is NOT treated as a path,
 *   so fractions like `10/2` survive);
 * - control characters are removed and every whitespace run collapses to one
 *   space;
 * - the result is truncated to {@link CODEX_TURN_ERROR_SANITIZED_MAX_CHARS}
 *   characters (a truncated tail is marked with "..."), so the persisted
 *   note is always bounded.
 */
export const CODEX_TURN_ERROR_SANITIZED_MAX_CHARS = 512 as const;

/** Stable generic diagnostic for absent / empty / fully-redacted input. */
export const CODEX_TURN_FAILED_GENERIC_DIAGNOSTIC =
  "the Codex turn failed without a technical detail" as const;

/** Full URLs (`https://…`, `file:///…`, …) — redacted wholesale. */
const URL_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`<>]+/g;

/** `Bearer <token>` / `Basic <base64>` credential values. */
const AUTH_CREDENTIAL_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Standalone JWT-like tokens (`eyJ…` base64url segments). The third (signature)
 * segment may legitimately be short, so it only needs 2 chars — a short
 * signature must never leak.
 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{2,}\b/g;

/**
 * `apiKey` / `token` / `password` / `secret`-style assignments (value
 * redacted, key name preserved). The key may be wrapped in underscore/hyphen
 * segments (`DB_PASSWORD`, `x-api-key`, `MY_SECRET_2`) or be a plural form
 * (`TOKENS`). A quoted value is consumed through its matching closing quote
 * (spaces included; an unterminated quote consumes to the next quote or end);
 * an unquoted value stops at the first safe delimiter and may additionally
 * consume space-joined chunks that continue a path (contain a `\` or `/`), so
 * `password=C:\Program Files\secret.bin` is never split into a leaky tail.
 */
const SECRET_ASSIGNMENT_PATTERN =
  /\b((?:\w*[_-])?(?:tokens|token|secrets|secret|passwords|password|passwd|pwd|api[_-]?keys?|access[_-]?tokens?|auth[_-]?tokens?|client[_-]?secrets?|private[_-]?keys?)(?:[_-]\w*)?)\s*[:=]\s*(?:["'][^"']*["']?|[^\s"'`;,)]+(?: [^\s"'`;,)]*[\\/][^\s"'`;,)]*)*)/gi;

/**
 * Windows drive paths: `C:\…` and `C:/…`. Chunks after a space are consumed
 * when they contain a `\` or `/` separator, so paths with spaces
 * (`C:\Program Files\SolidWorks\x.sldprt`) are redacted whole.
 */
const WINDOWS_DRIVE_PATH_PATTERN =
  /\b[A-Za-z]:[\\/][^\s"'`<>]+(?: [^\s"'`<>]*[\\/][^\s"'`<>]*)*/g;

/** UNC paths: `\\server\share\…` (spaces consumed the same way). */
const UNC_PATH_PATTERN = /\\\\[^\s"'`<>]+(?: [^\s"'`<>]*[\\/][^\s"'`<>]*)*/g;

/**
 * POSIX absolute paths (`/usr/bin/codex`, `/home/my user/.codex/config`). The
 * lookbehind requires the leading `/` NOT to follow a word character, so
 * fractions (`10/2`) and date fragments (`2026/08`) are never treated as
 * paths. Chunks after a space are consumed when they continue the path with a
 * `\` or `/` separator.
 */
const POSIX_PATH_PATTERN =
  /(?<![A-Za-z0-9_])(?:\/[^\s"'`<>]+(?: [^\s"'`<>]*[\\/][^\s"'`<>]*)*)+/g;

const TRUNCATION_SUFFIX = "..." as const;

/**
 * Replaces control characters (C0 minus tab/LF/CR, DEL) with a space, then
 * collapses every whitespace run to one space and trims. Written as a code
 * loop (not a control-character regex) so the source carries no control
 * characters and the lint rule `no-control-regex` stays satisfied.
 */
function normalizeText(text: string): string {
  const output: string[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isC0Control = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    if (isC0Control || code === 0x7f) {
      output.push(" ");
    } else {
      output.push(ch);
    }
  }
  return output.join("").replace(/\s+/g, " ").trim();
}

/**
 * Returns the deterministic, bounded and redacted digest of a Codex turn
 * failure message. See the module doc comment for the exact rules.
 */
export function sanitizeCodexTurnErrorMessage(value: unknown): string {
  if (typeof value !== "string") return CODEX_TURN_FAILED_GENERIC_DIAGNOSTIC;
  let text = value;
  // URLs first: their path / query / fragment may embed secrets, and the
  // later path patterns must never re-match pieces of a URL.
  text = text.replace(URL_PATTERN, "<url>");
  text = text.replace(AUTH_CREDENTIAL_PATTERN, (_match, scheme: string) => `${scheme} <redacted>`);
  text = text.replace(JWT_PATTERN, "<redacted>");
  text = text.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (_match, key: string) => `${key}=<redacted>`
  );
  text = text.replace(WINDOWS_DRIVE_PATH_PATTERN, "<path>");
  text = text.replace(UNC_PATH_PATTERN, "<path>");
  text = text.replace(POSIX_PATH_PATTERN, "<path>");
  // Normalize: control characters become spaces, every whitespace run
  // collapses to one space.
  text = normalizeText(text);
  if (text.length === 0) return CODEX_TURN_FAILED_GENERIC_DIAGNOSTIC;
  if (text.length > CODEX_TURN_ERROR_SANITIZED_MAX_CHARS) {
    text =
      text.slice(0, CODEX_TURN_ERROR_SANITIZED_MAX_CHARS - TRUNCATION_SUFFIX.length) +
      TRUNCATION_SUFFIX;
  }
  return text;
}
