import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RUNTIME_ROOT_BASE,
  DEFAULT_RUNTIME_ROOT_DIRNAME,
  defaultRuntimeRoot,
  isAbsoluteLocalPath,
  isUncOrNetworkPath,
  resolveRuntimeRootConfig,
  RuntimeRootConfigError,
  TEST_RUNTIME_ROOT_CLI_FLAG,
  validateRuntimeRootPath
} from "./runtime-root.js";

const FLAG = TEST_RUNTIME_ROOT_CLI_FLAG;

describe("defaultRuntimeRoot", () => {
  it("derives %LOCALAPPDATA%\\JANGHI\\SWPanel on win32", () => {
    expect(
      defaultRuntimeRoot("win32", () => "C:\\Users\\alice\\AppData\\Local")
    ).toBe(path.join("C:\\Users\\alice\\AppData\\Local", "JANGHI", "SWPanel"));
    expect(DEFAULT_RUNTIME_ROOT_BASE).toBe("JANGHI");
    expect(DEFAULT_RUNTIME_ROOT_DIRNAME).toBe("SWPanel");
  });

  it("fails loudly when LOCALAPPDATA is missing on win32", () => {
    expect(() => defaultRuntimeRoot("win32", () => undefined)).toThrow(RuntimeRootConfigError);
    expect(() => defaultRuntimeRoot("win32", () => "   ")).toThrow(RuntimeRootConfigError);
  });
});

describe("path classification helpers", () => {
  it("detects UNC / network paths", () => {
    expect(isUncOrNetworkPath("\\\\server\\share\\swpanel")).toBe(true);
    expect(isUncOrNetworkPath("//server/share")).toBe(true);
    expect(isUncOrNetworkPath("C:\\Users\\alice")).toBe(false);
    expect(isUncOrNetworkPath("C:/Users/alice")).toBe(false);
  });

  it("accepts absolute local paths and rejects relative/UNC ones", () => {
    expect(isAbsoluteLocalPath("C:\\Users\\alice")).toBe(true);
    expect(isAbsoluteLocalPath("C:/Users/alice")).toBe(true);
    expect(isAbsoluteLocalPath("relative/path")).toBe(false);
    expect(isAbsoluteLocalPath("\\\\server\\share")).toBe(false);
  });
});

describe("validateRuntimeRootPath", () => {
  it("accepts and canonicalizes an absolute local path", () => {
    const result = validateRuntimeRootPath("C:\\Users\\alice\\AppData\\Local\\TEMP\\swpanel-test");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(path.isAbsolute(result.root)).toBe(true);
    }
  });

  it.each([
    ["relative path", "swpanel\\test-root"],
    ["UNC path", "\\\\server\\share\\swpanel"],
    ["POSIX-style UNC", "//server/share"],
    ["empty string", ""],
    ["NUL byte", "C:\\swpanel\0evil"]
  ])("rejects %s", (_label, candidate) => {
    expect(validateRuntimeRootPath(candidate).ok).toBe(false);
  });
});

describe("resolveRuntimeRootConfig", () => {
  const localAppData = () => "C:\\Users\\alice\\AppData\\Local";

  it("returns the default OS-derived root without the CLI argument", () => {
    const config = resolveRuntimeRootConfig([], { isPackaged: true, platform: "win32", getLocalAppData: localAppData });
    expect(config.kind).toBe("default");
    expect(config.root).toContain("JANGHI");
    expect(config.root).toContain("SWPanel");
  });

  it("accepts exactly one canonical test-root argument on an unpackaged launch", () => {
    const root = "C:\\temp\\swpanel-e2e-root";
    const config = resolveRuntimeRootConfig([`${FLAG}=${root}`], {
      isPackaged: false,
      platform: "win32",
      getLocalAppData: localAppData
    });
    expect(config.kind).toBe("test");
    expect(config.root).toBe(path.resolve(root));
  });

  it("refuses the test root on a packaged launch", () => {
    expect(() =>
      resolveRuntimeRootConfig([`${FLAG}=C:\\temp\\root`], {
        isPackaged: true,
        platform: "win32",
        getLocalAppData: localAppData
      })
    ).toThrow(RuntimeRootConfigError);
  });

  it.each([
    ["duplicate arguments", [`${FLAG}=C:\\a`, `${FLAG}=C:\\b`]],
    ["separate-value form", [FLAG, "C:\\a"]],
    ["empty value", [`${FLAG}=`]],
    ["flag extension", [`${FLAG}-extra=C:\\a`]]
  ])("rejects %s", (_label, argv) => {
    expect(() =>
      resolveRuntimeRootConfig(argv, { isPackaged: false, platform: "win32", getLocalAppData: localAppData })
    ).toThrow(RuntimeRootConfigError);
  });

  it("ignores variant spellings (cased/underscore) and falls back to the default root", () => {
    // Matching the development-renderer CLI posture, variant spellings never
    // match the exact flag: they are ignored and the default OS root is used.
    for (const argv of [
      ["--SWPANEL-TEST-RUNTIME-ROOT=C:\\a"],
      ["--swpanel_test_runtime_root=C:\\a"]
    ]) {
      const config = resolveRuntimeRootConfig(argv, {
        isPackaged: false,
        platform: "win32",
        getLocalAppData: localAppData
      });
      expect(config.kind).toBe("default");
    }
  });

  it("rejects a relative or UNC test root even on an unpackaged launch", () => {
    expect(() =>
      resolveRuntimeRootConfig([`${FLAG}=relative/root`], {
        isPackaged: false,
        platform: "win32",
        getLocalAppData: localAppData
      })
    ).toThrow(RuntimeRootConfigError);
    expect(() =>
      resolveRuntimeRootConfig([`${FLAG}=\\\\server\\share`], {
        isPackaged: false,
        platform: "win32",
        getLocalAppData: localAppData
      })
    ).toThrow(RuntimeRootConfigError);
  });
});
