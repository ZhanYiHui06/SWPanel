import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WCAG 2.x relative-luminance contrast guard for design tokens.
 * Guards against token regressions and against component rules (such as
 * opacity) that silently lighten token text below the AA 4.5:1 threshold.
 */

const stylesDir = dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(join(stylesDir, "tokens.css"), "utf8");
const componentsCss = readFileSync(join(stylesDir, "components.css"), "utf8");

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(hexToRgb(a));
  const l2 = relativeLuminance(hexToRgb(b));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Blends foreground at `opacity` over background, matching CSS alpha compositing. */
function blend(fg: string, bg: string, opacity: number): string {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  const mixed: number[] = f.map((channel, i) => Math.round(opacity * channel + (1 - opacity) * b[i]!));
  return "#" + mixed.map((c) => c.toString(16).padStart(2, "0")).join("");
}

function cssVar(name: string, source: string): string {
  const match = source.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (!match) throw new Error(`missing CSS variable ${name}`);
  return match[1]!.trim();
}

/** Extracts a property value from the first CSS rule whose selector contains `selectorPart`. */
function ruleProperty(selectorPart: string, property: string, source: string): string | undefined {
  const selectorMatch = new RegExp(`([^{}]*${selectorPart}[^{}]*)\\{([^}]*)\\}`);
  const match = source.match(selectorMatch);
  if (!match) return undefined;
  const propMatch = match[2]!.match(new RegExp(`${property}\\s*:\\s*([^;]+);`));
  return propMatch?.[1]?.trim();
}

describe("design tokens meet WCAG AA contrast on their subtle surfaces", () => {
  it("--success-text on --success-subtle passes 4.5:1", () => {
    const fg = cssVar("--success-text", tokensCss);
    const bg = cssVar("--success-subtle", tokensCss);
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["--success-text", "--success-subtle"],
    ["--warning-text", "--warning-subtle"],
    ["--error-text", "--error-subtle"],
    ["--info-text", "--info-subtle"],
    ["--neutral-text", "--neutral-subtle"]
  ])("%s on %s passes 4.5:1 at full strength", (fgVar, bgVar) => {
    const fg = cssVar(fgVar, tokensCss);
    const bg = cssVar(bgVar, tokensCss);
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("inline-notice text contrast", () => {
  it("keeps .inline-notice-text at full token strength (no opacity dimming)", () => {
    // Regression: `opacity: 0.85` blended --success-text #067647 over
    // --success-subtle #ecfdf3 to #298a61 at 4.06:1, failing Axe.
    const opacity = ruleProperty("inline-notice-text", "opacity", componentsCss);
    expect(opacity).toBeUndefined();
  });

  it("effective text color still passes 4.5:1 when the text rule is applied", () => {
    for (const [fgVar, bgVar] of [
      ["--success-text", "--success-subtle"],
      ["--warning-text", "--warning-subtle"],
      ["--error-text", "--error-subtle"],
      ["--info-text", "--info-subtle"],
      ["--neutral-text", "--neutral-subtle"]
    ] as const) {
      const fg = cssVar(fgVar, tokensCss);
      const bg = cssVar(bgVar, tokensCss);
      const opacity = ruleProperty("inline-notice-text", "opacity", componentsCss);
      const effective = opacity === undefined ? fg : blend(fg, bg, Number(opacity));
      expect(contrastRatio(effective, bg), `${fgVar} over ${bgVar} as inline-notice text`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
