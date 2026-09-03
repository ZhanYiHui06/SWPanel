/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { render } from "../test/render.js";
import { Button, StatusBadge } from "../index.js";
import { iconBaseProps, iconStrokeProps } from "../icons/factory.js";

const componentStyles = readFileSync(
  `${process.cwd()}/src/styles/components.css`,
  "utf8"
);

describe("Button", () => {
  it("renders a button with the base and variant classes", () => {
    const html = render(<Button variant="primary" size="sm">开始自动建模</Button>);
    expect(html).toContain('class="btn btn-primary btn-sm"');
    expect(html).toContain("开始自动建模");
    expect(html).toContain("type=\"button\"");
  });

  it("defaults to the secondary variant and medium size", () => {
    const html = render(<Button>打开</Button>);
    expect(html).toContain('class="btn btn-secondary"');
  });

  it("renders an anchor when href is provided", () => {
    const html = render(<Button href="/drawings">图纸库</Button>);
    expect(html).toContain('href="/drawings"');
    expect(html).toContain('class="btn btn-secondary"');
    expect(html).not.toContain("type=\"button\"");
  });

  it("applies disabled to the button element", () => {
    const html = render(<Button disabled>不可用</Button>);
    expect(html).toContain("disabled");
  });
});

describe("StatusBadge", () => {
  it("renders the CSS variant class and data attributes", () => {
    const html = render(<StatusBadge variant="running">执行中</StatusBadge>);
    expect(html).toContain('class="status-badge running"');
    expect(html).toContain('data-variant="running"');
    expect(html).toContain('data-tone="info"');
  });

  it("maps every public variant to its semantic tone and styled CSS class", () => {
    const cases: Array<[Parameters<typeof StatusBadge>[0]["variant"], string, string]> = [
      ["running", "info", "running"],
      ["queued", "info", "queued"],
      ["completed", "success", "completed"],
      ["approved", "success", "approved"],
      ["pending-review", "warning", "pending-review"],
      ["clarification", "warning", "clarification"],
      ["failed", "error", "failed"],
      ["rejected", "error", "rejected"],
      ["cancelled", "neutral", "cancelled"],
      ["no-model", "neutral", "no-model"],
      ["current", "neutral", "current-rev"]
    ];
    for (const [variant, tone, cssClass] of cases) {
      const html = render(<StatusBadge variant={variant}>x</StatusBadge>);
      expect(html).toContain(`data-tone="${tone}"`);
      expect(html).toContain(`class="status-badge ${cssClass}"`);
      expect(componentStyles).toContain(`.status-badge.${cssClass}`);
    }
  });

  it("supports the small and large size classes", () => {
    expect(render(<StatusBadge variant="completed" size="sm">x</StatusBadge>)).toContain(
      "status-badge-sm"
    );
    expect(render(<StatusBadge variant="completed" size="lg">x</StatusBadge>)).toContain(
      "status-badge-lg"
    );
  });
});

describe("icon factory constants", () => {
  it("freezes the prototype baseline svg attributes", () => {
    expect(iconBaseProps).toEqual({
      viewBox: "0 0 16 16",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg"
    });
    expect(iconStrokeProps.strokeWidth).toBe(1.3);
  });
});
