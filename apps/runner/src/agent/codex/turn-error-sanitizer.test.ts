import { describe, expect, it } from "vitest";

import {
  CODEX_TURN_ERROR_SANITIZED_MAX_CHARS,
  CODEX_TURN_FAILED_GENERIC_DIAGNOSTIC,
  sanitizeCodexTurnErrorMessage
} from "./turn-error-sanitizer.js";

describe("sanitizeCodexTurnErrorMessage (P5-3)", () => {
  it("maps absent / empty / non-string input to the stable generic diagnostic", () => {
    expect(sanitizeCodexTurnErrorMessage(undefined)).toBe(CODEX_TURN_FAILED_GENERIC_DIAGNOSTIC);
    expect(sanitizeCodexTurnErrorMessage("")).toBe(CODEX_TURN_FAILED_GENERIC_DIAGNOSTIC);
    expect(sanitizeCodexTurnErrorMessage("   \t\n  ")).toBe(CODEX_TURN_FAILED_GENERIC_DIAGNOSTIC);
    expect(sanitizeCodexTurnErrorMessage(null)).toBe(CODEX_TURN_FAILED_GENERIC_DIAGNOSTIC);
    expect(sanitizeCodexTurnErrorMessage(42)).toBe(CODEX_TURN_FAILED_GENERIC_DIAGNOSTIC);
    expect(sanitizeCodexTurnErrorMessage({})).toBe(CODEX_TURN_FAILED_GENERIC_DIAGNOSTIC);
    expect(sanitizeCodexTurnErrorMessage([])).toBe(CODEX_TURN_FAILED_GENERIC_DIAGNOSTIC);
  });

  it("redacts Windows drive paths", () => {
    const out = sanitizeCodexTurnErrorMessage("failed at C:\\Users\\me\\.codex\\logs\\runner.log");
    expect(out).not.toContain("C:\\Users");
    expect(out).not.toContain(".codex");
    expect(out).not.toContain("runner.log");
    expect(out).toContain("failed at");
    // Forward-slash drive paths are redacted too.
    const forward = sanitizeCodexTurnErrorMessage("file C:/work/input/drawing.png missing");
    expect(forward).not.toContain("C:/work");
    expect(forward).not.toContain("drawing.png");
  });

  it("redacts Windows drive paths containing spaces whole, keeping surrounding prose", () => {
    const out = sanitizeCodexTurnErrorMessage(
      "failed to open C:\\Program Files\\SolidWorks\\x.sldprt because it is locked"
    );
    expect(out).not.toContain("Program Files");
    expect(out).not.toContain("SolidWorks");
    expect(out).not.toContain("x.sldprt");
    expect(out).toContain("failed to open");
    expect(out).toContain("because it is locked");

    const home = sanitizeCodexTurnErrorMessage(
      "could not read C:\\Users\\John Doe\\.codex\\config.toml while starting"
    );
    expect(home).not.toContain("John Doe");
    expect(home).not.toContain("config.toml");
    expect(home).toContain("while starting");

    const forward = sanitizeCodexTurnErrorMessage("D:/Work Projects/drawing.png is missing");
    expect(forward).not.toContain("Work Projects");
    expect(forward).not.toContain("drawing.png");
    expect(forward).toContain("is missing");
  });

  it("redacts UNC paths containing spaces whole, keeping surrounding prose", () => {
    const out = sanitizeCodexTurnErrorMessage(
      "cannot open \\\\nas\\share\\My Docs\\file.txt after retries"
    );
    expect(out).not.toContain("nas");
    expect(out).not.toContain("share");
    expect(out).not.toContain("My Docs");
    expect(out).not.toContain("file.txt");
    expect(out).toContain("cannot open");
    expect(out).toContain("after retries");
  });

  it("redacts POSIX absolute paths containing spaces whole, keeping surrounding prose", () => {
    const out = sanitizeCodexTurnErrorMessage("failed at /home/my user/.codex/config after retries");
    expect(out).not.toContain("my user");
    expect(out).not.toContain(".codex");
    expect(out).not.toContain("config");
    expect(out).toContain("failed at");
    expect(out).toContain("after retries");
  });

  it("redacts UNC paths", () => {
    const out = sanitizeCodexTurnErrorMessage("cannot open \\\\nas\\share\\run\\file.txt");
    expect(out).not.toContain("nas");
    expect(out).not.toContain("file.txt");
    expect(out).toContain("cannot open");
  });

  it("redacts POSIX absolute paths but never fractions or relative segments", () => {
    const out = sanitizeCodexTurnErrorMessage("failed at /home/me/.codex/config.json");
    expect(out).not.toContain("/home/me");
    expect(out).not.toContain("config.json");
    expect(out).toContain("failed at");
    // A `/` directly after a word character is a fraction/date, not a path.
    expect(sanitizeCodexTurnErrorMessage("ratio 10/2 ok")).toBe("ratio 10/2 ok");
    expect(sanitizeCodexTurnErrorMessage("date 2026/08/15 ok")).toBe("date 2026/08/15 ok");
    // A bare relative segment is not an absolute path.
    expect(sanitizeCodexTurnErrorMessage("relative a/b/c ok")).toBe("relative a/b/c ok");
  });

  it("redacts full URLs wholesale, including query and fragment", () => {
    const out = sanitizeCodexTurnErrorMessage(
      "see https://api.example.com/v1/runs?token=abc&key=xyz#frag for details"
    );
    expect(out).not.toContain("api.example.com");
    expect(out).not.toContain("token=abc");
    expect(out).not.toContain("key=xyz");
    expect(out).toContain("see");
    expect(out).toContain("for details");
    expect(sanitizeCodexTurnErrorMessage("fetch http://host/x?a=1")).not.toContain("host");
    expect(sanitizeCodexTurnErrorMessage("local file:///C:/Users/me/x.txt")).not.toContain(
      "C:/Users"
    );
  });

  it("redacts Bearer / Basic credential values and JWT-like tokens", () => {
    expect(sanitizeCodexTurnErrorMessage("Authorization: Bearer abc.def.ghi")).not.toContain(
      "abc.def.ghi"
    );
    expect(sanitizeCodexTurnErrorMessage("auth Basic dXNlcjpwYXNz")).not.toContain(
      "dXNlcjpwYXNz"
    );
    expect(
      sanitizeCodexTurnErrorMessage(
        "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5_NXgL0n3I9PlFUP0THsR8U"
      )
    ).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("redacts JWT-like tokens with short third (signature) segments", () => {
    for (const signature of ["short", "abc", "s1"]) {
      const out = sanitizeCodexTurnErrorMessage(
        `token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${signature}`
      );
      expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(out).toBe("token <redacted>");
    }
  });

  it("redacts apiKey / token / password / secret assignment values but keeps the key names", () => {
    const out = sanitizeCodexTurnErrorMessage(
      'api_key=sk-live-1234567890abcdef token:abc123 password=hunter2 secret="s3cr3t" x-api-key: k-999'
    );
    expect(out).not.toContain("sk-live-1234567890abcdef");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("s3cr3t");
    expect(out).not.toContain("k-999");
    // The diagnostic stays readable: key names are preserved.
    expect(out).toContain("api_key");
    expect(out).toContain("token");
    expect(out).toContain("password");
    expect(out).toContain("secret");
  });

  it("redacts env-style secret keys (underscore/hyphen wrapped, plural) and keeps the key names", () => {
    const out = sanitizeCodexTurnErrorMessage(
      "DB_PASSWORD=hunter2 API_TOKEN=abc123 MY_SECRET=s3cr3t ACCESS_TOKEN=t1 CLIENT_SECRET=c1 " +
        "PRIVATE_KEY=pk1 X_API_KEY=k1 TOKENS=abc,def db_password=x DB_PASSWORD_2=y my-token=z " +
        "auth_token=r client_secret=s private-key=t API_KEYS=u token-list=v"
    );
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("s3cr3t");
    expect(out).not.toContain("pk1");
    expect(out).not.toContain("k1");
    expect(out).not.toContain("TOKENS=abc");
    // Key names survive so the diagnostic stays readable.
    expect(out).toContain("DB_PASSWORD=<redacted>");
    expect(out).toContain("API_TOKEN=<redacted>");
    expect(out).toContain("MY_SECRET=<redacted>");
    expect(out).toContain("ACCESS_TOKEN=<redacted>");
    expect(out).toContain("CLIENT_SECRET=<redacted>");
    expect(out).toContain("PRIVATE_KEY=<redacted>");
    expect(out).toContain("X_API_KEY=<redacted>");
    expect(out).toContain("TOKENS=<redacted>");
    expect(out).toContain("db_password=<redacted>");
    expect(out).toContain("DB_PASSWORD_2=<redacted>");
    expect(out).toContain("my-token=<redacted>");
    expect(out).toContain("auth_token=<redacted>");
    expect(out).toContain("client_secret=<redacted>");
    expect(out).toContain("private-key=<redacted>");
    expect(out).toContain("API_KEYS=<redacted>");
    expect(out).toContain("token-list=<redacted>");
  });

  it("consumes quoted secret values fully through the matching closing quote", () => {
    const double = sanitizeCodexTurnErrorMessage('DB_PASSWORD="hunter2 pass" ok');
    expect(double).not.toContain("hunter2");
    expect(double).not.toContain("pass");
    expect(double).toBe("DB_PASSWORD=<redacted> ok");

    const single = sanitizeCodexTurnErrorMessage("CLIENT_SECRET='a b c' done");
    expect(single).not.toContain("a b c");
    expect(single).toBe("CLIENT_SECRET=<redacted> done");

    // An unterminated quote consumes to the end rather than leaking the value.
    const unterminated = sanitizeCodexTurnErrorMessage(
      'secret="unterminated value with spaces'
    );
    expect(unterminated).not.toContain("unterminated");
    expect(unterminated).toBe("secret=<redacted>");
  });

  it("stops unquoted secret values at safe delimiters without destroying following prose", () => {
    const out = sanitizeCodexTurnErrorMessage("token=abc123,next=1 and count=2 ok");
    expect(out).not.toContain("abc123");
    expect(out).toContain("token=<redacted>,next=1");
    expect(out).toContain("count=2");
    expect(out).toContain("ok");
  });

  it("redacts secret values that are themselves paths with spaces", () => {
    const out = sanitizeCodexTurnErrorMessage(
      "password=C:\\Program Files\\secret.bin saved"
    );
    expect(out).not.toContain("Program Files");
    expect(out).not.toContain("secret.bin");
    expect(out).toBe("password=<redacted> saved");
  });

  it("normalizes control characters and whitespace runs", () => {
    const out = sanitizeCodexTurnErrorMessage("line1\r\n\t line2\u0000line3  \u0007 line4");
    expect(out).toBe("line1 line2 line3 line4");
  });

  it("does not destroy fractions, dates, relative segments or ordinary prose", () => {
    // Fractions / dates / relative segments (existing guarantees, re-checked).
    expect(sanitizeCodexTurnErrorMessage("ratio 10/2 ok")).toBe("ratio 10/2 ok");
    expect(sanitizeCodexTurnErrorMessage("date 2026/08/15 ok")).toBe("date 2026/08/15 ok");
    expect(sanitizeCodexTurnErrorMessage("relative a/b/c ok")).toBe("relative a/b/c ok");
    // Ordinary prose, dotted versions and plain key=value pairs survive.
    expect(
      sanitizeCodexTurnErrorMessage(
        "the build failed with error code 42 and status pending"
      )
    ).toBe("the build failed with error code 42 and status pending");
    expect(sanitizeCodexTurnErrorMessage("file x.txt and y.txt are missing")).toBe(
      "file x.txt and y.txt are missing"
    );
    expect(sanitizeCodexTurnErrorMessage("count=2 next=1 plain=3")).toBe("count=2 next=1 plain=3");
    expect(sanitizeCodexTurnErrorMessage("version 1.2.3 ok")).toBe("version 1.2.3 ok");
    expect(sanitizeCodexTurnErrorMessage("at 12:30 the password was wrong")).toBe(
      "at 12:30 the password was wrong"
    );
  });

  it("bounds the output length deterministically", () => {
    const long = "plain failure text " + "x".repeat(10_000);
    const out = sanitizeCodexTurnErrorMessage(long);
    expect(out.length).toBeLessThanOrEqual(CODEX_TURN_ERROR_SANITIZED_MAX_CHARS);
    expect(out.endsWith("...")).toBe(true);
    // Deterministic: the same input always produces the same output.
    expect(sanitizeCodexTurnErrorMessage(long)).toBe(out);
  });

  it("is deterministic: identical inputs produce identical outputs", () => {
    const message =
      "failed: C:\\Users\\me\\x.log token=abc Authorization: Bearer tok.xyz https://h/q?k=v";
    expect(sanitizeCodexTurnErrorMessage(message)).toBe(sanitizeCodexTurnErrorMessage(message));
  });

  it("redacts secrets even when they span the length cap boundary", () => {
    const message =
      "long prefix " +
      "y".repeat(450) +
      " then token=sk-live-verysecretvalue C:\\Users\\me\\secret.log trailing";
    const out = sanitizeCodexTurnErrorMessage(message);
    expect(out).not.toContain("sk-live-verysecretvalue");
    expect(out).not.toContain("C:\\Users\\me");
    expect(out.length).toBeLessThanOrEqual(CODEX_TURN_ERROR_SANITIZED_MAX_CHARS);
  });
});
