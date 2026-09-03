import { describe, expect, it } from "vitest";

import { render } from "../test/render.js";
import * as icons from "./index.js";

describe("SWPanel icon set", () => {
  it("exports every icon as a component producing an SVG", () => {
    const entries = Object.entries(icons);
    expect(entries.length).toBeGreaterThan(10);

    for (const [name, component] of entries) {
      if (typeof component !== "function") continue;
      const html = render(component({}));
      expect(html, `icon ${name} should render <svg>`).toContain("<svg");
    }
  });

  it("renders the prototype baseline style: 16x16 viewBox, no fill, currentColor stroke", () => {
    const html = render(<icons.HomeIcon />);
    expect(html).toContain('viewBox="0 0 16 16"');
    expect(html).toContain('fill="none"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-width="1.3"');
    expect(html).toContain('width="16"');
    expect(html).toContain('height="16"');
  });

  it("marks icons as aria-hidden and supports a custom size", () => {
    const html = render(<icons.SearchIcon size={14} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('width="14"');
    expect(html).toContain('height="14"');
  });

  it("preserves the prototype's filled glyphs (Play, MoreHorizontal)", () => {
    expect(render(<icons.PlayIcon />)).toContain('fill="currentColor"');
    expect(render(<icons.MoreHorizontalIcon />)).toContain('fill="currentColor"');
  });

  it("keeps the navigation icon set required by the prototype sidebar", () => {
    for (const icon of [icons.HomeIcon, icons.FileIcon, icons.GridIcon, icons.CostIcon, icons.SettingsIcon]) {
      expect(icon, "sidebar icon should exist").toBeTypeOf("function");
    }
  });
});
