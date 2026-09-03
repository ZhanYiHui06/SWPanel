import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * WP6 browser E2E: installs an EXPLICIT fake `window.swpanel` bridge before the
 * renderer boots, then drives the Drawing-management UI end to end. Phase 1
 * screenshot/deep-link tests stay deterministic through the mock adapter
 * (no bridge installed -> dev-only explicit mock path).
 *
 * The fake bridge is fully self-contained (serialized into the page) and logs
 * every call to `window.__swpanelFake.calls` so the tests can assert the
 * workflow never touches run.* — the WP6 bridge surface structurally has no
 * run.create.
 */

const viewport = { width: 1366, height: 768 };

interface FakeInitRevision {
  id: string;
  sequence: number;
  fileName: string;
  uploadedAt: string;
  facts?: unknown[];
  feedback?: unknown[];
}

interface FakeInitDrawing {
  id: string;
  drawingNumber: string;
  name: string;
  currentRevisionId?: string;
  createdAt: string;
  updatedAt: string;
  revisions: FakeInitRevision[];
}

interface FakePick {
  token: string;
  fileName: string;
  format: string;
  sizeBytes: number;
  sha256: string;
}

interface FakeInitOptions {
  seed: FakeInitDrawing[];
  settings: { dataRoot: string; workspaceRoot: string; constraint: string; updatedAt: string };
  fail: string[];
  pick: FakePick | null;
}

interface FakeSourceFile {
  id: string;
  fileName: string;
  format: string;
  sizeBytes: number;
  sha256: string;
  relativePath: string;
  uploadedAt: string;
}

interface FakeRevision {
  id: string;
  drawingId: string;
  sequence: number;
  fileName: string;
  uploadedAt: string;
  sizeBytes: number;
  currentApprovedModelId: string | null;
  createdAt: string;
  updatedAt: string;
  sourceFile: FakeSourceFile;
}

interface FakeDrawing {
  id: string;
  drawingNumber: string;
  name: string;
  currentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FakeState {
  drawings: FakeDrawing[];
  revisions: FakeRevision[];
  facts: Record<string, unknown>[];
  feedback: Record<string, unknown>[];
  settings: { dataRoot: string; workspaceRoot: string; constraint: string; updatedAt: string };
}

/** Installed BEFORE the app loads; must be fully self-contained. */
function installFakeBridge(init: FakeInitOptions) {
  const ok = (data: unknown) => ({ ok: true, data });
  const fail = (code: string, message: string) => ({ ok: false, error: { code, message } });
  const calls: string[] = [];
  const failures = new Set(init.fail);
  const state: FakeState = {
    drawings: [],
    revisions: [],
    facts: [],
    feedback: [],
    settings: { ...init.settings }
  };
  let pick: FakePick | null = init.pick;
  let drawingSeq = 0;
  let factSeq = 0;
  let feedbackSeq = 0;

  /** Ids that never collide with seeded fact/feedback ids (unique React keys). */
  const nextFactId = () => {
    let id: string;
    do {
      factSeq += 1;
      id = `fact-${factSeq}`;
    } while (state.facts.some((fact) => (fact as { id: string }).id === id));
    return id;
  };
  const nextFeedbackId = () => {
    let id: string;
    do {
      feedbackSeq += 1;
      id = `feedback-${feedbackSeq}`;
    } while (state.feedback.some((entry) => (entry as { id: string }).id === id));
    return id;
  };

  const label = (sequence: number) => `V${sequence}`;
  const guard = (method: string, build: () => unknown) => {
    if (failures.has(method)) return fail("RUNNER_UNAVAILABLE", `${method} 暂时不可用（模拟失败）`);
    try {
      return ok(build());
    } catch (error) {
      const code = error instanceof Object && "code" in error ? String(error.code) : "INTERNAL";
      return fail(code, error instanceof Error ? error.message : String(error));
    }
  };
  const record = (method: string, payload?: unknown) =>
    calls.push(payload === undefined ? method : `${method}:${JSON.stringify(payload)}`);

  const findDrawing = (drawingId: string): FakeDrawing => {
    const drawing = state.drawings.find((candidate) => candidate.id === drawingId);
    if (drawing === undefined) {
      throw Object.assign(new Error(`drawing ${drawingId} not found`), { code: "NOT_FOUND" });
    }
    return drawing;
  };
  const findRevision = (revisionId: string): FakeRevision => {
    const revision = state.revisions.find((candidate) => candidate.id === revisionId);
    if (revision === undefined) {
      throw Object.assign(new Error(`revision ${revisionId} not found`), { code: "NOT_FOUND" });
    }
    return revision;
  };
  const sourceFileOf = (revision: {
    drawingId: string;
    id: string;
    fileName: string;
    uploadedAt: string;
    sizeBytes: number;
  }): FakeSourceFile => ({
    id: `file-${revision.id}`,
    fileName: revision.fileName,
    format: "PDF",
    sizeBytes: revision.sizeBytes,
    sha256: "a".repeat(64),
    relativePath: `library/drawings/${revision.drawingId}/revisions/${revision.id}/source/${revision.fileName}`,
    uploadedAt: revision.uploadedAt
  });

  for (const seed of init.seed) {
    const drawing: FakeDrawing = {
      id: seed.id,
      drawingNumber: seed.drawingNumber,
      name: seed.name,
      currentRevisionId: seed.currentRevisionId ?? seed.revisions.at(-1)?.id ?? null,
      createdAt: seed.createdAt,
      updatedAt: seed.updatedAt
    };
    state.drawings.push(drawing);
    for (const revisionSeed of seed.revisions) {
      const revision: FakeRevision = {
        id: revisionSeed.id,
        drawingId: seed.id,
        sequence: revisionSeed.sequence,
        fileName: revisionSeed.fileName,
        uploadedAt: revisionSeed.uploadedAt,
        sizeBytes: 1_234_567,
        currentApprovedModelId: null,
        createdAt: revisionSeed.uploadedAt,
        updatedAt: revisionSeed.uploadedAt,
        sourceFile: {
          id: `file-${revisionSeed.id}`,
          fileName: revisionSeed.fileName,
          format: "PDF",
          sizeBytes: 1_234_567,
          sha256: "a".repeat(64),
          relativePath: `library/drawings/${seed.id}/revisions/${revisionSeed.id}/source/${revisionSeed.fileName}`,
          uploadedAt: revisionSeed.uploadedAt
        }
      };
      state.revisions.push(revision);
      for (const fact of revisionSeed.facts ?? []) state.facts.push(fact as Record<string, unknown>);
      for (const entry of revisionSeed.feedback ?? []) state.feedback.push(entry as Record<string, unknown>);
    }
  }

  const listItems = () =>
    state.drawings
      .map((drawing) => {
        const revisions = state.revisions.filter((revision) => revision.drawingId === drawing.id);
        const current = revisions.find((revision) => revision.id === drawing.currentRevisionId);
        const latest = revisions.at(-1);
        return {
          drawingId: drawing.id,
          drawingNumber: drawing.drawingNumber,
          name: drawing.name,
          currentRevisionId: drawing.currentRevisionId,
          currentRevisionLabel: current === undefined ? null : label(current.sequence),
          currentApprovedModelId: null,
          runStatus: null,
          updatedAt: drawing.updatedAt,
          totalRevisionCount: revisions.length,
          latestRevisionLabel: latest === undefined ? null : label(latest.sequence),
          hasOpenClarification: false
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const toDetail = (drawingId: string) => {
    const drawing = findDrawing(drawingId);
    const revisions = state.revisions.filter((revision) => revision.drawingId === drawing.id);
    return {
      drawing: {
        drawingId: drawing.id,
        drawingNumber: drawing.drawingNumber,
        name: drawing.name,
        currentRevisionId: drawing.currentRevisionId,
        createdAt: drawing.createdAt,
        updatedAt: drawing.updatedAt
      },
      revisions: revisions
        .sort((a, b) => a.sequence - b.sequence)
        .map((revision) => ({
          revisionId: revision.id,
          revisionLabel: label(revision.sequence),
          isCurrent: revision.id === drawing.currentRevisionId,
          currentApprovedModelId: revision.currentApprovedModelId,
          isCurrentApprovedModel: false,
          createdAt: revision.createdAt,
          updatedAt: revision.updatedAt
        }))
    };
  };

  const toHistory = (drawingId: string) => {
    const drawing = findDrawing(drawingId);
    const revisions = state.revisions.filter((revision) => revision.drawingId === drawing.id);
    return {
      drawingId: drawing.id,
      drawingNumber: drawing.drawingNumber,
      name: drawing.name,
      currentRevisionId: drawing.currentRevisionId,
      revisions: revisions
        .sort((a, b) => a.sequence - b.sequence)
        .map((revision) => ({
          revisionId: revision.id,
          revisionLabel: label(revision.sequence),
          isCurrent: revision.id === drawing.currentRevisionId,
          sourceFile: {
            fileName: revision.sourceFile.fileName,
            format: revision.sourceFile.format,
            sizeBytes: revision.sourceFile.sizeBytes,
            sha256: revision.sourceFile.sha256,
            uploadedAt: revision.sourceFile.uploadedAt
          },
          createdAt: revision.createdAt
        }))
    };
  };

  const toRevisionDetail = (drawingId: string, revisionId: string) => {
    const drawing = findDrawing(drawingId);
    const revision = findRevision(revisionId);
    return {
      revision: {
        revisionId: revision.id,
        revisionLabel: label(revision.sequence),
        drawingId: drawing.id,
        drawingNumber: drawing.drawingNumber,
        drawingName: drawing.name,
        isCurrent: drawing.currentRevisionId === revision.id,
        currentApprovedModelId: null,
        sourceFile: {
          fileName: revision.sourceFile.fileName,
          format: revision.sourceFile.format,
          sizeBytes: revision.sourceFile.sizeBytes,
          uploadedAt: revision.sourceFile.uploadedAt
        },
        createdAt: revision.createdAt
      },
      runs: [],
      models: [],
      costReports: [],
      facts: state.facts.filter((fact) => fact.revisionId === revisionId),
      modelingFeedback: state.feedback.filter((entry) => entry.revisionId === revisionId)
    };
  };

  const toRevisionHistory = (drawingId: string, revisionId: string) => {
    const drawing = findDrawing(drawingId);
    const revision = findRevision(revisionId);
    return {
      revisionId: revision.id,
      revisionLabel: label(revision.sequence),
      drawingId: drawing.id,
      drawingNumber: drawing.drawingNumber,
      isCurrent: drawing.currentRevisionId === revision.id,
      createdAt: revision.createdAt,
      updatedAt: revision.updatedAt,
      facts: state.facts.filter((fact) => fact.revisionId === revisionId),
      modelingFeedback: state.feedback.filter((entry) => entry.revisionId === revisionId)
    };
  };

  const api = Object.freeze({
    metadata: Object.freeze({ platform: "test", versions: Object.freeze({ chrome: "1", electron: "1" }) }),
    health: Object.freeze({
      get: () => Promise.resolve(ok({ status: "READY", serverInstanceId: "fake", error: null }))
    }),
    files: Object.freeze({
      selectDrawingFile: () => {
        record("files.selectDrawingFile");
        if (pick === null) return Promise.resolve(ok({ canceled: true, file: null }));
        return Promise.resolve(ok({ canceled: false, file: pick }));
      }
    }),
    drawings: Object.freeze({
      list: () => {
        record("drawings.list");
        return Promise.resolve(guard("drawings.list", () => listItems()));
      },
      getHistory: (drawingId: string) => {
        record("drawings.getHistory", drawingId);
        return Promise.resolve(guard("drawings.getHistory", () => toHistory(drawingId)));
      },
      getDetail: (drawingId: string) => {
        record("drawings.getDetail", drawingId);
        return Promise.resolve(guard("drawings.getDetail", () => toDetail(drawingId)));
      },
      getRevisionHistory: (drawingId: string, revisionId: string) => {
        record("drawings.getRevisionHistory", { drawingId, revisionId });
        return Promise.resolve(guard("drawings.getRevisionHistory", () => toRevisionHistory(drawingId, revisionId)));
      },
      getRevisionDetail: (drawingId: string, revisionId: string) => {
        record("drawings.getRevisionDetail", { drawingId, revisionId });
        return Promise.resolve(guard("drawings.getRevisionDetail", () => toRevisionDetail(drawingId, revisionId)));
      },
      importDrawing: (input: { drawingNumber: string; name: string; selectedFileToken: string; createdAt: string }) => {
        record("drawings.importDrawing", input);
        return Promise.resolve(
          guard("drawings.importDrawing", () => {
            drawingSeq += 1;
            const drawingId = `drawing-${drawingSeq}`;
            const revisionId = `rev-${drawingId}-1`;
            const drawing: FakeDrawing = {
              id: drawingId,
              drawingNumber: input.drawingNumber,
              name: input.name,
              currentRevisionId: revisionId,
              createdAt: input.createdAt,
              updatedAt: input.createdAt
            };
            const revision: FakeRevision = {
              id: revisionId,
              drawingId,
              sequence: 1,
              fileName: `${input.drawingNumber}.pdf`,
              uploadedAt: input.createdAt,
              sizeBytes: 1_234_567,
              currentApprovedModelId: null,
              createdAt: input.createdAt,
              updatedAt: input.createdAt,
              sourceFile: sourceFileOf({ drawingId, id: revisionId, fileName: `${input.drawingNumber}.pdf`, uploadedAt: input.createdAt, sizeBytes: 1_234_567 })
            };
            state.drawings.push(drawing);
            state.revisions.push(revision);
            return { drawing, revision, sourceFile: revision.sourceFile };
          })
        );
      },
      addRevision: (input: { drawingId: string; selectedFileToken: string; createdAt: string }) => {
        record("drawings.addRevision", input);
        return Promise.resolve(
          guard("drawings.addRevision", () => {
            const drawing = findDrawing(input.drawingId);
            const revisions = state.revisions.filter((revision) => revision.drawingId === drawing.id);
            const sequence = revisions.reduce((max, revision) => Math.max(max, revision.sequence), 0) + 1;
            const revisionId = `rev-${drawing.id}-${sequence}`;
            const revision: FakeRevision = {
              id: revisionId,
              drawingId: drawing.id,
              sequence,
              fileName: `V${sequence}.pdf`,
              uploadedAt: input.createdAt,
              sizeBytes: 1_234_567,
              currentApprovedModelId: null,
              createdAt: input.createdAt,
              updatedAt: input.createdAt,
              sourceFile: sourceFileOf({ drawingId: drawing.id, id: revisionId, fileName: `V${sequence}.pdf`, uploadedAt: input.createdAt, sizeBytes: 1_234_567 })
            };
            state.revisions.push(revision);
            drawing.updatedAt = input.createdAt;
            return { revision, sourceFile: revision.sourceFile };
          })
        );
      },
      setCurrentRevision: (input: { drawingId: string; revisionId: string; updatedAt: string }) => {
        record("drawings.setCurrentRevision", input);
        return Promise.resolve(
          guard("drawings.setCurrentRevision", () => {
            const drawing = findDrawing(input.drawingId);
            findRevision(input.revisionId);
            drawing.currentRevisionId = input.revisionId;
            drawing.updatedAt = input.updatedAt;
            return { ...drawing };
          })
        );
      },
      addRevisionFact: (input: { revisionId: string; field: string; value: string; unit?: string; source: string; createdAt: string }) => {
        record("drawings.addRevisionFact", input);
        return Promise.resolve(
          guard("drawings.addRevisionFact", () => {
            const fact = {
              id: nextFactId(),
              revisionId: input.revisionId,
              field: input.field,
              value: input.value,
              ...(input.unit === undefined ? {} : { unit: input.unit }),
              source: input.source,
              createdAt: input.createdAt
            };
            state.facts.push(fact);
            return fact;
          })
        );
      },
      addModelingFeedback: (input: { revisionId: string; content: string; createdAt: string }) => {
        record("drawings.addModelingFeedback", input);
        return Promise.resolve(
          guard("drawings.addModelingFeedback", () => {
            const entry = {
              id: nextFeedbackId(),
              revisionId: input.revisionId,
              content: input.content,
              source: "USER_SUPPLEMENT",
              createdAt: input.createdAt
            };
            state.feedback.push(entry);
            return entry;
          })
        );
      }
    }),
    storage: Object.freeze({
      getSettings: () => {
        record("storage.getSettings");
        return Promise.resolve(guard("storage.getSettings", () => ({ settings: { ...state.settings } })));
      },
      updateSettings: (input: { settings: FakeState["settings"] }) => {
        record("storage.updateSettings", input);
        return Promise.resolve(
          guard("storage.updateSettings", () => {
            state.settings = { ...input.settings };
            return { settings: { ...state.settings } };
          })
        );
      }
    })
  });

  const target = globalThis as typeof globalThis & {
    swpanel?: typeof api;
    __swpanelFake?: {
      calls: string[];
      state: FakeState;
      clearFailure: (method: string) => void;
      setPick: (next: FakePick | null) => void;
    };
  };
  target.swpanel = api;
  target.__swpanelFake = {
    calls,
    state,
    clearFailure: (method: string) => {
      failures.delete(method);
    },
    setPick: (next: FakePick | null) => {
      pick = next;
    }
  };
}

const DEFAULT_SETTINGS = {
  dataRoot: "%LOCALAPPDATA%\\JANGHI\\SWPanel",
  workspaceRoot: "%LOCALAPPDATA%\\JANGHI\\SWPanel\\workspaces",
  constraint: "LOCAL_FIXED_NTFS",
  updatedAt: "2026-08-13T00:00:00.000Z"
};

const DEFAULT_PICK: FakePick = {
  token: "swsel_00000000000000000000000000000000",
  fileName: "PDJF001.01.pdf",
  format: "PDF",
  sizeBytes: 1_234_567,
  sha256: "0".repeat(64)
};

const SEED_DRAWING_A: FakeInitDrawing = {
  id: "drawing-a",
  drawingNumber: "PDJF001.01",
  name: "轧辊（一）",
  currentRevisionId: "rev-a-1",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  revisions: [
    { id: "rev-a-1", sequence: 1, fileName: "PDJF001.01.pdf", uploadedAt: "2026-08-12T00:00:00.000Z" },
    { id: "rev-a-2", sequence: 2, fileName: "PDJF001.01_V2.pdf", uploadedAt: "2026-08-12T01:00:00.000Z" }
  ]
};

interface FakeInspect {
  calls: string[];
  state: {
    drawings: Array<{ currentRevisionId: string | null }>;
    revisions: unknown[];
    facts: unknown[];
    feedback: unknown[];
    settings: { dataRoot: string; workspaceRoot: string };
  };
}

async function fake(page: Page): Promise<FakeInspect> {
  return page.evaluate(() => (globalThis as typeof globalThis & { __swpanelFake: FakeInspect }).__swpanelFake);
}

async function expectNoRunActivity(page: Page) {
  const bridgeFake = await fake(page);
  expect(bridgeFake.calls.filter((call) => call.startsWith("run."))).toEqual([]);
}

async function expectCleanPage(page: Page) {
  await expect(page.locator("[data-route-id]")).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    document.documentElement.dataset.phase2FontsReady = "true";
  });
  await expect(page.locator("html")).toHaveAttribute("data-phase2-fonts-ready", "true");
}

test.describe("WP6 browser Drawing workflow (explicit fake bridge)", () => {
  test("library renders real bridge drawings with search and filter", async ({ page }) => {
    await page.addInitScript(installFakeBridge, {
      seed: [
        SEED_DRAWING_A,
        {
          id: "drawing-b",
          drawingNumber: "PDJG002.02",
          name: "阶梯轴",
          createdAt: "2026-08-12T02:00:00.000Z",
          updatedAt: "2026-08-12T02:00:00.000Z",
          revisions: [{ id: "rev-b-1", sequence: 1, fileName: "PDJG002.02.pdf", uploadedAt: "2026-08-12T02:00:00.000Z" }]
        }
      ],
      settings: DEFAULT_SETTINGS,
      fail: [],
      pick: DEFAULT_PICK
    });
    await page.setViewportSize(viewport);
    await page.goto("/#/drawings", { waitUntil: "networkidle" });
    await expect(page.getByRole("link", { name: "PDJF001.01", exact: true })).toBeVisible();

    await page.getByRole("searchbox", { name: "搜索图号或名称" }).fill("阶梯轴");
    await expect(page.getByRole("link", { name: "PDJG002.02", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "PDJF001.01", exact: true })).toHaveCount(0);
    await page.getByRole("searchbox", { name: "搜索图号或名称" }).fill("");
    await page.getByRole("button", { name: "尚未建模" }).click();
    await expect(page.getByText("尚未建模").first()).toBeVisible();
    await expectNoRunActivity(page);
  });

  test("empty Runner library shows the real empty state", async ({ page }) => {
    await page.addInitScript(installFakeBridge, { seed: [], settings: DEFAULT_SETTINGS, fail: [], pick: DEFAULT_PICK });
    await page.setViewportSize(viewport);
    await page.goto("/#/drawings", { waitUntil: "networkidle" });
    await expect(page.getByText("图纸库还是空的")).toBeVisible();
    await expect(page.getByRole("link", { name: "PDJF001.01", exact: true })).toHaveCount(0);
  });

  test("upload/import through the visible UI imports the file and navigates to the Drawing", async ({ page }) => {
    await page.addInitScript(installFakeBridge, { seed: [], settings: DEFAULT_SETTINGS, fail: [], pick: DEFAULT_PICK });
    await page.setViewportSize(viewport);
    await page.goto("/#/drawings", { waitUntil: "networkidle" });
    await expect(page.getByText("图纸库还是空的")).toBeVisible();

    await page.getByRole("button", { name: "上传图纸" }).first().click();
    const dialog = page.getByRole("dialog", { name: "上传图纸" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "选择图纸文件" }).click();
    await expect(dialog.getByText("PDJF001.01.pdf")).toBeVisible();

    await dialog.getByLabel("图号").fill("PDJF100.01");
    await dialog.getByLabel("名称").fill("新轧辊");
    await dialog.getByRole("button", { name: "导入图纸" }).click();

    await expect(page.getByRole("heading", { name: "PDJF100.01" })).toBeVisible();
    const bridgeFake = await fake(page);
    expect(bridgeFake.state.drawings).toHaveLength(1);
    expect(bridgeFake.calls.some((call) => call.startsWith("drawings.importDrawing"))).toBe(true);
    // The WP6 workflow never creates a Run: no run.* call exists and no Run UI.
    await expectNoRunActivity(page);
    await expect(page.getByText(/Run [R]\d/)).toHaveCount(0);
  });

  test("cancelling the import dialog does nothing", async ({ page }) => {
    await page.addInitScript(installFakeBridge, { seed: [], settings: DEFAULT_SETTINGS, fail: [], pick: DEFAULT_PICK });
    await page.setViewportSize(viewport);
    await page.goto("/#/drawings", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "上传图纸" }).first().click();
    let dialog = page.getByRole("dialog", { name: "上传图纸" });
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByRole("button", { name: "上传图纸" }).first().click();
    dialog = page.getByRole("dialog", { name: "上传图纸" });
    await dialog.getByRole("button", { name: "选择图纸文件" }).click();
    await expect(dialog.getByText("PDJF001.01.pdf")).toBeVisible();
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(dialog).toHaveCount(0);

    const bridgeFake = await fake(page);
    expect(bridgeFake.state.drawings).toHaveLength(0);
    expect(bridgeFake.calls.some((call) => call.startsWith("drawings.importDrawing"))).toBe(false);
  });

  test("library error state offers retry and recovers", async ({ page }) => {
    await page.addInitScript(installFakeBridge, {
      seed: [SEED_DRAWING_A],
      settings: DEFAULT_SETTINGS,
      fail: ["drawings.list"],
      pick: DEFAULT_PICK
    });
    await page.setViewportSize(viewport);
    await page.goto("/#/drawings", { waitUntil: "networkidle" });
    await expect(page.getByText("图纸库加载失败")).toBeVisible();
    await page.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __swpanelFake?: { clearFailure: (method: string) => void };
      };
      target.__swpanelFake?.clearFailure("drawings.list");
    });
    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.getByRole("link", { name: "PDJF001.01", exact: true })).toBeVisible();
  });

  test("overview shows history with the current indicator, adds a Revision and sets it current", async ({ page }) => {
    await page.addInitScript(installFakeBridge, {
      seed: [SEED_DRAWING_A],
      settings: DEFAULT_SETTINGS,
      fail: [],
      pick: DEFAULT_PICK
    });
    await page.setViewportSize(viewport);
    await page.goto("/#/drawings/drawing-a/revisions/rev-a-1/overview", { waitUntil: "networkidle" });

    await expect(page.getByText("版本历史")).toBeVisible();
    await expect(page.getByText("PDJF001.01.pdf", { exact: true })).toBeVisible();
    await expect(page.getByText("当前").first()).toBeVisible();

    // 新增版本 through the visible UI (current pointer untouched).
    await page.getByRole("button", { name: "新增版本" }).click();
    const dialog = page.getByRole("dialog", { name: "新增版本" });
    await dialog.getByRole("button", { name: "选择图纸文件" }).click();
    await dialog.getByRole("button", { name: "确认新增版本" }).click();
    await expect(page.getByText("版本历史")).toBeVisible();
    const afterAdd = await fake(page);
    expect(afterAdd.state.revisions).toHaveLength(3);
    expect(afterAdd.state.drawings[0]?.currentRevisionId).toBe("rev-a-1");

    // Set V2 current via the visible UI.
    await page.getByRole("button", { name: "设为当前版本" }).first().click();
    await expect(page.getByText(/已设为当前版本/)).toBeVisible();
    const afterSet = await fake(page);
    expect(afterSet.state.drawings[0]?.currentRevisionId).toBe("rev-a-2");
    await expectNoRunActivity(page);
  });

  test("memory page adds a fact and feedback through the visible forms", async ({ page }) => {
    await page.addInitScript(installFakeBridge, {
      seed: [
        {
          ...SEED_DRAWING_A,
          revisions: [
            {
              id: "rev-a-1",
              sequence: 1,
              fileName: "PDJF001.01.pdf",
              uploadedAt: "2026-08-12T00:00:00.000Z",
              facts: [
                { id: "fact-1", revisionId: "rev-a-1", field: "材料", value: "42CrMo", source: "USER_SUPPLEMENT", createdAt: "2026-08-12T00:10:00.000Z" }
              ]
            }
          ]
        }
      ],
      settings: DEFAULT_SETTINGS,
      fail: [],
      pick: DEFAULT_PICK
    });
    await page.setViewportSize(viewport);
    await page.goto("/#/drawings/drawing-a/revisions/rev-a-1/memory", { waitUntil: "networkidle" });

    await expect(page.getByText("42CrMo")).toBeVisible();

    await page.getByRole("button", { name: "添加事实" }).click();
    let dialog = page.getByRole("dialog", { name: "添加工程事实" });
    await dialog.getByLabel("字段名称").fill("中心孔深度");
    await dialog.getByLabel("值").fill("85 mm");
    await dialog.getByLabel("单位").fill("mm");
    await dialog.getByRole("button", { name: "保存事实" }).click();
    await expect(page.getByText("中心孔深度")).toBeVisible();

    await page.getByRole("button", { name: "添加反馈" }).click();
    dialog = page.getByRole("dialog", { name: "添加建模反馈" });
    await dialog.getByLabel("反馈内容").fill("注意 R5 圆角方向");
    await dialog.getByRole("button", { name: "保存反馈" }).click();
    await expect(page.getByText(/注意 R5 圆角方向/)).toBeVisible();

    const bridgeFake = await fake(page);
    expect(bridgeFake.state.facts).toHaveLength(2);
    expect(bridgeFake.state.feedback).toHaveLength(1);
    await expectNoRunActivity(page);
  });

  test("settings loads real storage settings and saves the workspace root", async ({ page }) => {
    await page.addInitScript(installFakeBridge, {
      seed: [],
      settings: {
        dataRoot: "D:\\SWPanelData",
        workspaceRoot: "D:\\SWPanelData\\workspaces",
        constraint: "LOCAL_FIXED_NTFS",
        updatedAt: "2026-08-13T00:00:00.000Z"
      },
      fail: [],
      pick: DEFAULT_PICK
    });
    await page.setViewportSize(viewport);
    await page.goto("/#/settings", { waitUntil: "networkidle" });

    const dataRoot = page.getByLabel("数据目录");
    await expect(dataRoot).toHaveValue("D:\\SWPanelData");
    await expect(dataRoot).toHaveAttribute("readonly", "");

    const workspace = page.getByLabel("Workspace 路径");
    await workspace.fill("D:\\SWPanelData\\workspaces2");
    await page.getByRole("button", { name: "保存存储设置" }).click();
    await expect(page.getByText("存储设置已保存")).toBeVisible();

    const bridgeFake = await fake(page);
    expect(bridgeFake.state.settings.workspaceRoot).toBe("D:\\SWPanelData\\workspaces2");
    expect(bridgeFake.state.settings.dataRoot).toBe("D:\\SWPanelData");
  });

  test("deep-links with dynamic real ids (no fixture assumptions)", async ({ page }) => {
    await page.addInitScript(installFakeBridge, {
      seed: [{ ...SEED_DRAWING_A, id: "9f8e7d6c-1234-4abc-8def-001122334455" }],
      settings: DEFAULT_SETTINGS,
      fail: [],
      pick: DEFAULT_PICK
    });
    await page.setViewportSize(viewport);
    await page.goto("/#/drawings/9f8e7d6c-1234-4abc-8def-001122334455/revisions/rev-a-1/overview", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "PDJF001.01" })).toBeVisible();
    await expect(page.getByText("版本历史")).toBeVisible();
  });

  test("WP6 dialogs, forms and error states pass axe accessibility", async ({ page }) => {
    await page.addInitScript(installFakeBridge, {
      seed: [SEED_DRAWING_A],
      settings: DEFAULT_SETTINGS,
      fail: [],
      pick: DEFAULT_PICK
    });
    await page.setViewportSize(viewport);

    // Library + import dialog.
    await page.goto("/#/drawings", { waitUntil: "networkidle" });
    await expectCleanPage(page);
    await page.getByRole("button", { name: "上传图纸" }).first().click();
    await expect(page.getByRole("dialog", { name: "上传图纸" })).toBeVisible();
    let results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, "drawings + import dialog axe violations").toEqual([]);

    // Memory page + fact dialog.
    await page.goto("/#/drawings/drawing-a/revisions/rev-a-1/memory", { waitUntil: "networkidle" });
    await expectCleanPage(page);
    await page.getByRole("button", { name: "添加事实" }).click();
    await expect(page.getByRole("dialog", { name: "添加工程事实" })).toBeVisible();
    results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, "memory + fact dialog axe violations").toEqual([]);

    // Not-found error state.
    await page.goto("/#/drawings/does-not-exist/revisions/rev-x-1/overview", { waitUntil: "networkidle" });
    await expect(page.getByText("图纸不存在或已被删除")).toBeVisible();
    results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, "not-found error state axe violations").toEqual([]);
  });
});
