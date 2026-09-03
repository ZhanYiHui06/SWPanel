import { describe, expect, it } from "vitest";

import {
  applyPipeDaclToServer,
  applyPipeDaclWithIcacls,
  PIPE_DACL_ACE_MASK,
  readPipeDaclEvidence,
  SYSTEM_SID,
  verifyPipeDacl
} from "./acl.js";

const USER_SID = "S-1-5-21-1000000000-2000000000-3000000000-1111";
const FULL = PIPE_DACL_ACE_MASK;

function evidence(aces: readonly { sid: string; mask: number }[]) {
  return { ownerSid: USER_SID, systemSid: SYSTEM_SID, aces };
}

describe("verifyPipeDacl (strict current-user + SYSTEM rule)", () => {
  it("accepts exactly {current user, SYSTEM} with the full access mask", () => {
    const result = verifyPipeDacl(
      evidence([
        { sid: USER_SID, mask: FULL },
        { sid: SYSTEM_SID, mask: FULL }
      ])
    );
    expect(result).toEqual({ ok: true });
  });

  it("accepts either ACE ordering and duplicate-free duplicates", () => {
    const result = verifyPipeDacl(
      evidence([
        { sid: SYSTEM_SID, mask: FULL },
        { sid: USER_SID, mask: FULL }
      ])
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a DACL missing the current user SID", () => {
    const result = verifyPipeDacl(evidence([{ sid: SYSTEM_SID, mask: FULL }]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(USER_SID);
    }
  });

  it("rejects a DACL missing the SYSTEM SID", () => {
    const result = verifyPipeDacl(evidence([{ sid: USER_SID, mask: FULL }]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(SYSTEM_SID);
    }
  });

  it("rejects Everyone (S-1-1-0)", () => {
    const result = verifyPipeDacl(
      evidence([
        { sid: USER_SID, mask: FULL },
        { sid: SYSTEM_SID, mask: FULL },
        { sid: "S-1-1-0", mask: FULL }
      ])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("S-1-1-0");
    }
  });

  it("rejects NT AUTHORITY\\ANONYMOUS LOGON (S-1-5-7)", () => {
    const result = verifyPipeDacl(
      evidence([
        { sid: USER_SID, mask: FULL },
        { sid: SYSTEM_SID, mask: FULL },
        { sid: "S-1-5-7", mask: FULL }
      ])
    );
    expect(result.ok).toBe(false);
  });

  it("rejects Authenticated Users (S-1-5-11)", () => {
    const result = verifyPipeDacl(
      evidence([
        { sid: USER_SID, mask: FULL },
        { sid: SYSTEM_SID, mask: FULL },
        { sid: "S-1-5-11", mask: FULL }
      ])
    );
    expect(result.ok).toBe(false);
  });

  it("rejects BUILTIN\\Users (S-1-5-32-545) and BUILTIN\\Administrators (S-1-5-32-544)", () => {
    for (const broadSid of ["S-1-5-32-545", "S-1-5-32-544"]) {
      const result = verifyPipeDacl(
        evidence([
          { sid: USER_SID, mask: FULL },
          { sid: SYSTEM_SID, mask: FULL },
          { sid: broadSid, mask: FULL }
        ])
      );
      expect(result.ok).toBe(false);
    }
  });

  it("rejects any other stray SID outside {current user, SYSTEM}", () => {
    const result = verifyPipeDacl(
      evidence([
        { sid: USER_SID, mask: FULL },
        { sid: SYSTEM_SID, mask: FULL },
        { sid: "S-1-5-21-1234-5678-9012-9999", mask: FULL }
      ])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("other than {current user, SYSTEM}");
    }
  });

  it("rejects ACEs carrying anything other than the full access mask", () => {
    const result = verifyPipeDacl(
      evidence([
        { sid: USER_SID, mask: FULL },
        { sid: SYSTEM_SID, mask: 0x00020089 } // read + synchronize only
      ])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unexpected access masks");
    }
  });
});

describe("applyPipeDaclToServer (platform gate)", () => {
  it("returns WINDOWS_ONLY_UNSUPPORTED on non-Windows platforms without claiming protection", async () => {
    const result = await applyPipeDaclToServer("/tmp/swpanel-test.sock", { platform: "linux" });
    expect(result.status).toBe("WINDOWS_ONLY_UNSUPPORTED");
    expect(result.reason).toContain("Windows Named Pipes exist only on win32");
    expect(result.aces).toBeUndefined();
  });

  it("returns WINDOWS_ONLY_UNSUPPORTED on darwin", async () => {
    const result = await applyPipeDaclToServer("/tmp/swpanel-test.sock", { platform: "darwin" });
    expect(result.status).toBe("WINDOWS_ONLY_UNSUPPORTED");
  });

  it("throws from readPipeDaclEvidence on non-Windows platforms", async () => {
    await expect(
      readPipeDaclEvidence("/tmp/swpanel-test.sock", { platform: "linux" })
    ).rejects.toThrow(/can only be captured on win32/);
  });
});

describe("applyPipeDaclWithIcacls (documented truthful fallback)", () => {
  it("spawns icacls and rejects on a non-zero exit", async () => {
    // The fallback is documented as NOT working on this host (error 87); it is
    // kept only so the WP4 brief's proposed fallback is represented truthfully.
    await expect(applyPipeDaclWithIcacls("\\\\.\\pipe\\swpanel.test.nonexistent")).rejects.toThrow(
      /icacls/
    );
  });
});
