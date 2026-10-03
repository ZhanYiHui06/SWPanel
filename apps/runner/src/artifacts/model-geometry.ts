import type { ModelDetailView } from "@swpanel/contracts";

export type ModelGeometry = NonNullable<ModelDetailView["geometry"]>;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Engineering plausibility envelope of a single machined part (BE-13). */
const MIN_VOLUME_M3 = 1e-9; // 1 mm³
const MAX_VOLUME_M3 = 10;
const MIN_BOX_EDGE_MM = 0.01;
const MAX_BOX_EDGE_MM = 20_000;

/** Explicit CAD mass-property evidence only. Dimension drawings are not volume evidence. */
export function parseModelGeometry(value: unknown, sourceArtifactId: string): ModelGeometry | null {
  if (!record(value) || !record(value.geometry)) return null;
  const geometry = value.geometry;
  if (geometry.schemaVersion !== 1 || geometry.source !== "solidworks-mass-properties") return null;
  if (!record(geometry.volume) || !positive(geometry.volume.value)) return null;
  const scale = geometry.volume.unit === "m3" ? 1 : geometry.volume.unit === "mm3" ? 1e-9 : null;
  if (scale === null) return null;
  const finishedVolumeM3 = geometry.volume.value * scale;
  if (!positive(finishedVolumeM3) || finishedVolumeM3 < MIN_VOLUME_M3 || finishedVolumeM3 > MAX_VOLUME_M3) return null;
  let boundingBoxMm: ModelGeometry["boundingBoxMm"] = null;
  if (geometry.boundingBox !== undefined) {
    const box = geometry.boundingBox;
    if (!record(box) || !positive(box.length) || !positive(box.width) || !positive(box.height)) return null;
    const boxScale = box.unit === "mm" ? 1 : box.unit === "m" ? 1000 : null;
    if (boxScale === null) return null;
    boundingBoxMm = { length: box.length * boxScale, width: box.width * boxScale, height: box.height * boxScale };
    if (!Object.values(boundingBoxMm).every((edge) => positive(edge) && edge >= MIN_BOX_EDGE_MM && edge <= MAX_BOX_EDGE_MM)) {
      return null;
    }
    const envelopeM3 = boundingBoxMm.length * boundingBoxMm.width * boundingBoxMm.height * 1e-9;
    if (!positive(envelopeM3) || finishedVolumeM3 > envelopeM3 * (1 + 1e-6)) return null;
  }
  return { finishedVolumeM3, boundingBoxMm, sourceArtifactId };
}
