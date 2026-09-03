import { cleanup, render as renderDom, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { render } from "../test/render.js";
import {
  Card,
  DataTable,
  EmptyState,
  InlineNotice,
  PropertyList,
  SearchInput,
  Select,
  Tabs
} from "../index.js";

afterEach(cleanup);

describe("Card", () => {
  it("composes header, body and footer", () => {
    const html = render(
      <Card>
        <Card.Header>
          <Card.Title>原始图纸</Card.Title>
        </Card.Header>
        <Card.Body>内容</Card.Body>
        <Card.Footer>页脚</Card.Footer>
      </Card>
    );
    expect(html).toContain('class="card"');
    expect(html).toContain('class="card-header"');
    expect(html).toContain('class="card-title"');
    expect(html).toContain('class="card-body"');
    expect(html).toContain('class="card-footer"');
  });

  it("supports compact and flush body padding", () => {
    expect(render(<Card.Body padding="compact">x</Card.Body>)).toContain('class="card-body compact"');
    expect(render(<Card.Body padding="flush">x</Card.Body>)).toContain('class="card-body card-body-flush"');
  });
});

describe("InlineNotice", () => {
  it("renders tone class and content", () => {
    const html = render(
      <InlineNotice tone="warning" title="等待人工审核">
        请在 SolidWorks 中检查后确认。
      </InlineNotice>
    );
    expect(html).toContain('class="inline-notice warning"');
    expect(html).toContain("等待人工审核");
    expect(html).toContain("请在 SolidWorks 中检查后确认。");
  });

  it("defaults to the neutral tone", () => {
    const html = render(<InlineNotice>说明</InlineNotice>);
    expect(html).toContain('class="inline-notice"');
    expect(html).toContain('data-tone="neutral"');
  });

  it("omits the icon when explicitly disabled", () => {
    const html = render(<InlineNotice icon={null}>说明</InlineNotice>);
    expect(html).not.toContain("inline-notice-icon");
  });
});

describe("EmptyState", () => {
  it("renders title, description and optional action", () => {
    const html = render(
      <EmptyState
        title="当前版本暂无正式模型"
        description="完成自动建模并通过人工审核后，可生成内部成本测算报告。"
        action={<button type="button">发起建模</button>}
      />
    );
    expect(html).toContain('class="empty-state"');
    expect(html).toContain("当前版本暂无正式模型");
    expect(html).toContain("empty-state-icon");
    expect(html).toContain("发起建模");
  });
});

describe("PropertyList", () => {
  it("renders key/value rows with mono values", () => {
    const html = render(
      <PropertyList
        items={[
          { key: "图号", value: "PDJF480.01.17C-4", mono: true },
          { key: "状态", value: "待审核" }
        ]}
      />
    );
    expect(html).toContain('class="property-list"');
    expect(html).toContain('class="property-key"');
    expect(html).toContain('class="property-value mono"');
    expect(html).toContain("PDJF480.01.17C-4");
  });
});

describe("SearchInput", () => {
  it("renders a search input with a magnifier icon", () => {
    const html = render(<SearchInput placeholder="搜索图号 / 名称" />);
    expect(html).toContain('class="search-input"');
    expect(html).toContain('type="search"');
    expect(html).toContain("搜索图号 / 名称");
    expect(html).toContain("search-input-icon");
  });

  it("adds the wide class when requested", () => {
    expect(render(<SearchInput wide />)).toContain('class="search-input wide"');
  });
});

describe("Select", () => {
  it("renders options with placeholder", () => {
    const html = render(
      <Select
        placeholder="请选择材料"
        options={[
          { label: "42CrMo", value: "42CrMo" },
          { label: "45#钢", value: "45" }
        ]}
      />
    );
    expect(html).toContain('class="form-select"');
    expect(html).toContain("请选择材料");
    expect(html).toContain('value="42CrMo"');
  });
});

describe("DataTable", () => {
  const columns = [
    { header: "图号", key: "number", cellClass: "mono" as const, width: "32%" },
    { header: "状态", key: "status" }
  ];

  it("renders a data-sheet table with header and cells", () => {
    const html = render(
      <DataTable
        label="图纸列表"
        columns={columns}
        keyColumn="number"
        rows={[{ number: "PDJF480.01.17C-4", status: "待审核" }]}
      />
    );
    expect(html).toContain('class="data-sheet"');
    expect(html).toContain("<th");
    expect(html).toContain("PDJF480.01.17C-4");
    expect(html).toContain("col-mono");
  });

  it("activates interactive rows with mouse, Enter and Space", async () => {
    const rowClick = vi.fn();
    const user = userEvent.setup();
    renderDom(
      <DataTable
        label="图纸列表"
        columns={columns}
        keyColumn="number"
        rows={[{ number: "A-1", status: "x" }]}
        rowClick={rowClick}
      />
    );
    const row = screen.getByRole("button", { name: "A-1 x" });

    await user.click(row);
    expect(rowClick).toHaveBeenLastCalledWith({ number: "A-1", status: "x" }, 0);

    row.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(rowClick).toHaveBeenCalledTimes(3);
  });

  it("does not activate a row when a nested control is clicked", async () => {
    const rowClick = vi.fn();
    const user = userEvent.setup();
    renderDom(
      <DataTable
        label="图纸列表"
        columns={columns}
        keyColumn="number"
        rows={[{ number: "A-1", status: <button type="button">编辑</button> }]}
        rowClick={rowClick}
      />
    );

    await user.click(screen.getByRole("button", { name: "编辑" }));
    expect(rowClick).not.toHaveBeenCalled();
  });

  it("renders plain rows when rowClick is absent", () => {
    const html = render(
      <DataTable
        label="图纸列表"
        columns={columns}
        keyColumn="number"
        rows={[{ number: "A-1", status: "x" }]}
      />
    );
    expect(html).not.toContain("clickable");
  });
});

describe("Tabs", () => {
  const options = [
    { value: "first", label: "第一项", panel: "第一项内容", disabled: true },
    { value: "second", label: "第二项", panel: "第二项内容" },
    { value: "third", label: "第三项", panel: "第三项内容" }
  ] as const;

  it("selects the first enabled option and links every tab to a unique panel", () => {
    renderDom(<Tabs label="示例标签页" options={options} defaultValue="first" />);

    const tabs = screen.getAllByRole("tab");
    const panels = screen.getAllByRole("tabpanel", { hidden: true });
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.tabIndex).toBe(0);
    expect(panels[1]?.hidden).toBe(false);

    const controls = tabs.map((tab) => tab.getAttribute("aria-controls"));
    expect(new Set(controls).size).toBe(options.length);
    for (const [index, tab] of tabs.entries()) {
      const panel = panels[index];
      expect(tab.getAttribute("aria-controls")).toBe(panel?.id);
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
    }
  });

  it("creates stable panel relationships when callers only provide tab labels", () => {
    renderDom(
      <Tabs
        label="无内容标签页"
        options={[
          { value: "one", label: "一" },
          { value: "two", label: "二" }
        ]}
      />
    );

    const tabs = screen.getAllByRole("tab");
    const panels = screen.getAllByRole("tabpanel", { hidden: true });
    expect(tabs).toHaveLength(2);
    expect(panels).toHaveLength(2);
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panels[0]?.id);
    expect(tabs[1]?.getAttribute("aria-controls")).toBe(panels[1]?.id);
  });

  it("roves focus with Arrow, Home and End without focusing disabled tabs", async () => {
    const user = userEvent.setup();
    renderDom(<Tabs label="示例标签页" options={options} />);
    const tabs = screen.getAllByRole("tab");

    tabs[1]?.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs[2]?.tabIndex).toBe(0);

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tabs[1]);

    await user.keyboard("{End}");
    expect(document.activeElement).toBe(tabs[2]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(tabs[1]);
  });

  it("selects a focused tab with Enter and Space", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderDom(<Tabs label="示例标签页" options={options} onChange={onChange} />);
    const tabs = screen.getAllByRole("tab");

    tabs[2]?.focus();
    await user.keyboard("{Enter}");
    expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith("third");

    tabs[1]?.focus();
    await user.keyboard(" ");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith("second");
  });
});
