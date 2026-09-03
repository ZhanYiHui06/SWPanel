import type { Drawing, DrawingRevision, RevisionSourceFile } from "@swpanel/domain";
import { TIME } from "./timeline.js";

/**
 * Stable fixture identifiers. Entity ids are deterministic strings so every
 * scenario seed and repository command output is reproducible.
 */
export const DRAWING_IDS = {
  main: "drawing-pdjf480-01-17c-4",
  a: "drawing-pdjf273-02-08",
  b: "drawing-pdjg159-01-03",
  c: "drawing-pdjf508-03-12",
  d: "drawing-pdjf325-04-06"
} as const;

export const REVISION_IDS = {
  mainV1: "rev-main-v1",
  mainV2: "rev-main-v2",
  mainV3: "rev-main-v3",
  aV1: "rev-a-v1",
  aV2: "rev-a-v2",
  bV1: "rev-b-v1",
  cV1: "rev-c-v1",
  cV2: "rev-c-v2",
  dV1: "rev-d-v1"
} as const;

/** Deterministic 64-char hex digest used for fixture files/artifacts. */
export function mockSha256(seed: string): string {
  let hash = "";
  for (let i = 0; i < 64; i += 1) {
    const code = seed.charCodeAt(i % seed.length) + i * 7;
    hash += (code % 16).toString(16);
  }
  return hash;
}

export function buildRevisionSourceFile(input: {
  id: string;
  fileName: string;
  uploadedAt: string;
}): RevisionSourceFile {
  return {
    id: input.id,
    fileName: input.fileName,
    format: "PDF",
    sizeBytes: 1_234_567,
    sha256: mockSha256(input.id),
    relativePath: `revisions/${input.id}/source/${input.fileName}`,
    uploadedAt: input.uploadedAt
  };
}

export function buildDrawing(input: {
  id: string;
  drawingNumber: string;
  name: string;
  currentRevisionId: string;
  createdAt: string;
  updatedAt: string;
}): Drawing {
  return {
    id: input.id,
    drawingNumber: input.drawingNumber,
    name: input.name,
    currentRevisionId: input.currentRevisionId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
}

export function buildRevision(input: {
  id: string;
  drawingId: string;
  sequence: number;
  sourceFile: RevisionSourceFile;
  currentApprovedModelId: string | null;
  createdAt: string;
  updatedAt: string;
}): DrawingRevision {
  return {
    id: input.id,
    drawingId: input.drawingId,
    sequence: input.sequence,
    sourceFile: input.sourceFile,
    currentApprovedModelId: input.currentApprovedModelId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
}

/**
 * Builds the canonical five-drawing world (main + A/B/C/D from the UI content
 * fixtures). The main drawing V3 revision's `currentApprovedModelId` is
 * scenario-dependent and therefore injected.
 */
export function buildPrimaryWorld(mainCurrentApprovedModelId: string | null): {
  drawings: Drawing[];
  revisions: DrawingRevision[];
} {
  const mainV1 = buildRevision({
    id: REVISION_IDS.mainV1,
    drawingId: DRAWING_IDS.main,
    sequence: 1,
    sourceFile: buildRevisionSourceFile({
      id: "file-main-v1",
      fileName: "PDJF480.01.17C-4_V1.pdf",
      uploadedAt: TIME.v1Uploaded
    }),
    currentApprovedModelId: null,
    createdAt: TIME.v1Uploaded,
    updatedAt: TIME.v1Uploaded
  });

  const mainV2 = buildRevision({
    id: REVISION_IDS.mainV2,
    drawingId: DRAWING_IDS.main,
    sequence: 2,
    sourceFile: buildRevisionSourceFile({
      id: "file-main-v2",
      fileName: "PDJF480.01.17C-4_V2.pdf",
      uploadedAt: TIME.v2Uploaded
    }),
    currentApprovedModelId: null,
    createdAt: TIME.v2Uploaded,
    updatedAt: TIME.v2Uploaded
  });

  const mainV3 = buildRevision({
    id: REVISION_IDS.mainV3,
    drawingId: DRAWING_IDS.main,
    sequence: 3,
    sourceFile: buildRevisionSourceFile({
      id: "file-main-v3",
      fileName: "PDJF480.01.17C-4.pdf",
      uploadedAt: TIME.v3Uploaded
    }),
    currentApprovedModelId: mainCurrentApprovedModelId,
    createdAt: TIME.v3Uploaded,
    updatedAt: TIME.v3Uploaded
  });

  const aV1 = buildRevision({
    id: REVISION_IDS.aV1,
    drawingId: DRAWING_IDS.a,
    sequence: 1,
    sourceFile: buildRevisionSourceFile({
      id: "file-a-v1",
      fileName: "PDJF273.02.08_V1.pdf",
      uploadedAt: "2026-08-05T09:00:00.000Z"
    }),
    currentApprovedModelId: null,
    createdAt: "2026-08-05T09:00:00.000Z",
    updatedAt: "2026-08-05T09:00:00.000Z"
  });

  const aV2 = buildRevision({
    id: REVISION_IDS.aV2,
    drawingId: DRAWING_IDS.a,
    sequence: 2,
    sourceFile: buildRevisionSourceFile({
      id: "file-a-v2",
      fileName: "PDJF273.02.08.pdf",
      uploadedAt: "2026-08-08T10:00:00.000Z"
    }),
    currentApprovedModelId: "model-a-m01",
    createdAt: "2026-08-08T10:00:00.000Z",
    updatedAt: "2026-08-08T10:00:00.000Z"
  });

  const bV1 = buildRevision({
    id: REVISION_IDS.bV1,
    drawingId: DRAWING_IDS.b,
    sequence: 1,
    sourceFile: buildRevisionSourceFile({
      id: "file-b-v1",
      fileName: "PDJG159.01.03.pdf",
      uploadedAt: "2026-08-07T13:00:00.000Z"
    }),
    currentApprovedModelId: null,
    createdAt: "2026-08-07T13:00:00.000Z",
    updatedAt: "2026-08-07T13:00:00.000Z"
  });

  const cV1 = buildRevision({
    id: REVISION_IDS.cV1,
    drawingId: DRAWING_IDS.c,
    sequence: 1,
    sourceFile: buildRevisionSourceFile({
      id: "file-c-v1",
      fileName: "PDJF508.03.12_V1.pdf",
      uploadedAt: "2026-08-06T09:00:00.000Z"
    }),
    currentApprovedModelId: null,
    createdAt: "2026-08-06T09:00:00.000Z",
    updatedAt: "2026-08-06T09:00:00.000Z"
  });

  const cV2 = buildRevision({
    id: REVISION_IDS.cV2,
    drawingId: DRAWING_IDS.c,
    sequence: 2,
    sourceFile: buildRevisionSourceFile({
      id: "file-c-v2",
      fileName: "PDJF508.03.12.pdf",
      uploadedAt: "2026-08-08T15:00:00.000Z"
    }),
    currentApprovedModelId: "model-c-m01",
    createdAt: "2026-08-08T15:00:00.000Z",
    updatedAt: "2026-08-08T15:00:00.000Z"
  });

  const dV1 = buildRevision({
    id: REVISION_IDS.dV1,
    drawingId: DRAWING_IDS.d,
    sequence: 1,
    sourceFile: buildRevisionSourceFile({
      id: "file-d-v1",
      fileName: "PDJF325.04.06.pdf",
      uploadedAt: "2026-08-07T11:00:00.000Z"
    }),
    currentApprovedModelId: "model-d-m01",
    createdAt: "2026-08-07T11:00:00.000Z",
    updatedAt: "2026-08-07T11:00:00.000Z"
  });

  const drawings: Drawing[] = [
    buildDrawing({
      id: DRAWING_IDS.main,
      drawingNumber: "PDJF480.01.17C-4",
      name: "轧辊（二）",
      currentRevisionId: REVISION_IDS.mainV3,
      createdAt: TIME.mainCreated,
      updatedAt: TIME.v3Uploaded
    }),
    buildDrawing({
      id: DRAWING_IDS.a,
      drawingNumber: "PDJF273.02.08",
      name: "定径辊",
      currentRevisionId: REVISION_IDS.aV2,
      createdAt: "2026-08-05T09:00:00.000Z",
      updatedAt: "2026-08-08T10:00:00.000Z"
    }),
    buildDrawing({
      id: DRAWING_IDS.b,
      drawingNumber: "PDJG159.01.03",
      name: "阶梯轴",
      currentRevisionId: REVISION_IDS.bV1,
      createdAt: "2026-08-07T13:00:00.000Z",
      updatedAt: "2026-08-07T13:00:00.000Z"
    }),
    buildDrawing({
      id: DRAWING_IDS.c,
      drawingNumber: "PDJF508.03.12",
      name: "连轧辊",
      currentRevisionId: REVISION_IDS.cV2,
      createdAt: "2026-08-06T09:00:00.000Z",
      updatedAt: "2026-08-08T15:00:00.000Z"
    }),
    buildDrawing({
      id: DRAWING_IDS.d,
      drawingNumber: "PDJF325.04.06",
      name: "矫直辊",
      currentRevisionId: REVISION_IDS.dV1,
      createdAt: "2026-08-07T11:00:00.000Z",
      updatedAt: "2026-08-07T11:00:00.000Z"
    })
  ];

  return { drawings, revisions: [mainV1, mainV2, mainV3, aV1, aV2, bV1, cV1, cV2, dV1] };
}
