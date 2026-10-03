import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { CostDataSnapshot } from "@swpanel/domain";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeDrawingRepository } from "../features/bridge-repository/bridge-drawing-repository.js";
import { DrawingRepositoryProvider } from "../features/bridge-repository/drawing-repository-provider.js";
import { BridgeCostRepository } from "../features/cost-repository/bridge-cost-repository.js";
import { CostRepositoryProvider } from "../features/cost-repository/cost-repository-provider.js";
import { createFakeBridge } from "../test/fake-bridge.js";
import { CostDataPage } from "./CostDataPage.js";

function setup() {
  const fake = createFakeBridge();
  const costRepo = new BridgeCostRepository(fake.api);
  const update = vi.spyOn(costRepo, "updateCostData");
  render(<DrawingRepositoryProvider repository={new BridgeDrawingRepository(fake.api)}><CostRepositoryProvider repository={costRepo}><CostDataPage /></CostRepositoryProvider></DrawingRepositoryProvider>);
  return { costRepo, update };
}
const fill = async (user: ReturnType<typeof userEvent.setup>, label: string, value: string) => {
  await user.clear(screen.getByLabelText(label));
  await user.type(screen.getByLabelText(label), value);
};
afterEach(cleanup);

describe("企业成本数据管理", () => {
  it("新增材料验证必填和重名，保存明确单位及完整快照", async () => {
    const user = userEvent.setup();
    const { costRepo, update } = setup();
    const baseline = await costRepo.getEffectiveCostData();
    await user.click(await screen.findByRole("button", { name: "新增材料" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText("名称不能为空")).toBeInTheDocument();
    await fill(user, "名称", baseline.materials[0]!.name);
    await fill(user, "采购价格", "6800");
    await fill(user, "密度", "7.8");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText("名称不能为空，同一分类内不能重名")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    await fill(user, "名称", "新钢材");
    await user.selectOptions(screen.getByLabelText("价格单位"), "元/kg");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("新钢材");
    const saved = update.mock.calls[0]![0];
    expect(saved.materials.at(-1)).toMatchObject({ name: "新钢材", purchasePrice: 6800, priceUnit: "元/kg", density: 7.8, densityUnit: "g/cm³" });
    expect(saved.fixedCosts).toEqual(baseline.fixedCosts);
    expect(saved.allowances).toEqual(baseline.allowances);
    expect(saved.customFields).toEqual(baseline.customFields);
    expect(baseline.materials).toHaveLength(saved.materials.length - 1);
  });

  it("材料可编辑，删除确认前不修改快照", async () => {
    const user = userEvent.setup();
    const { costRepo, update } = setup();
    const baseline = await costRepo.getEffectiveCostData();
    const row = (await screen.findByText(baseline.materials[0]!.name)).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "编辑" }));
    await fill(user, "名称", "调整后材料");
    await fill(user, "采购价格", "7000");
    await user.click(screen.getByRole("button", { name: "保存" }));
    const renamed = (await screen.findByText("调整后材料")).closest("tr")!;
    expect(update.mock.calls[0]![0].materials[0]).toMatchObject({ id: baseline.materials[0]!.id, purchasePrice: 7000 });
    await user.click(within(renamed).getByRole("button", { name: "删除" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("历史报告保留原有快照");
    expect(update).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByText("调整后材料")).not.toBeInTheDocument());
    expect(update.mock.calls[1]![0].materials).toHaveLength(baseline.materials.length - 1);
  });

  it("固定成本增删改支持每批计费和默认参与设置", async () => {
    const user = userEvent.setup();
    const { update } = setup();
    await screen.findByRole("button", { name: "新增材料" });
    await user.click(screen.getByRole("tab", { name: "固定成本" }));
    await user.click(screen.getByRole("button", { name: "新增成本项" }));
    await fill(user, "名称", "整批运输");
    await fill(user, "金额 (¥)", "200");
    await user.selectOptions(screen.getByLabelText("计费基准"), "PER_BATCH");
    await user.selectOptions(screen.getByLabelText("默认参与测算"), "false");
    await user.click(screen.getByRole("button", { name: "保存" }));
    const row = (await screen.findByText("整批运输")).closest("tr")!;
    expect(update.mock.calls[0]![0].fixedCosts.at(-1)).toMatchObject({ amount: 200, basis: "PER_BATCH", defaultEnabled: false });
    await user.click(within(row).getByRole("button", { name: "编辑" }));
    await fill(user, "金额 (¥)", "220");
    await user.click(screen.getByRole("button", { name: "保存" }));
    const updatedRow = (await screen.findByText("¥220.00")).closest("tr")!;
    await user.click(within(updatedRow).getByRole("button", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByText("整批运输")).not.toBeInTheDocument());
    expect(update).toHaveBeenCalledTimes(3);
  });

  it("加工余量只改数值并保留每个方向与mm语义", async () => {
    const user = userEvent.setup();
    const { costRepo, update } = setup();
    const baseline = await costRepo.getEffectiveCostData();
    await screen.findByRole("button", { name: "新增材料" });
    await user.click(screen.getByRole("tab", { name: "加工余量" }));
    await user.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    const definition = baseline.allowances[0]!;
    await fill(user, `${definition.allowances[0]!.name} (mm)`, "32");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]![0].allowances[0]).toMatchObject({ id: definition.id, stockType: definition.stockType, allowances: [{ ...definition.allowances[0], valueMm: 32 }, ...definition.allowances.slice(1)] });
  });

  it("自定义字段增删改固定为DISPLAY_ONLY并禁止重复保存", async () => {
    const user = userEvent.setup();
    const { costRepo, update } = setup();
    await screen.findByRole("button", { name: "新增材料" });
    await user.click(screen.getByRole("tab", { name: "自定义字段" }));
    await user.click(screen.getByRole("button", { name: "新增自定义字段" }));
    await fill(user, "名称", "运输备注");
    await fill(user, "字段标识", "transport-note");
    await fill(user, "字段值", "按实际记录");
    let finish!: (snapshot: CostDataSnapshot) => void;
    update.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await user.dblClick(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    expect(screen.getByLabelText("字段值")).toBeDisabled();
    expect(update).toHaveBeenCalledOnce();
    const submitted = update.mock.calls[0]![0];
    await act(async () => {
      await costRepo.updateCostData(submitted);
      finish(submitted);
    });
    update.mockClear();
    const row = (await screen.findByText("运输备注")).closest("tr")!;
    expect(submitted.customFields.at(-1)).toMatchObject({ key: "transport-note", semantics: "DISPLAY_ONLY" });
    await user.click(within(row).getByRole("button", { name: "编辑" }));
    await fill(user, "字段值", "已确认");
    await user.click(screen.getByRole("button", { name: "保存" }));
    const updatedRow = (await screen.findByText("已确认")).closest("tr")!;
    await user.click(within(updatedRow).getByRole("button", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByText("运输备注")).not.toBeInTheDocument());
  });
});
