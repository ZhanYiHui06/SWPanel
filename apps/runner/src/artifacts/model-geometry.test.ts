import { describe, expect, it } from "vitest";
import { parseModelGeometry } from "./model-geometry.js";

describe("CAD geometry evidence", () => {
  it("requires an explicit CAD source and volume unit", () => {
    expect(parseModelGeometry([{ value: 480, unit: "mm" }], "a")).toBeNull();
    expect(parseModelGeometry({ geometry: { volume: { value: 100 } } }, "a")).toBeNull();
    expect(parseModelGeometry({ geometry: { schemaVersion: 1, source: "fixture", volume: { value: 1, unit: "m3" } } }, "a")).toBeNull();
  });
  it("converts measured volume and bounds independently", () => {
    expect(parseModelGeometry({ geometry: { schemaVersion: 1, source: "solidworks-mass-properties", volume: { value: 500000, unit: "mm3" }, boundingBox: { unit: "m", length: 0.1, width: 0.1, height: 0.1 } } }, "a")).toEqual({ finishedVolumeM3: 0.0005, boundingBoxMm: { length: 100, width: 100, height: 100 }, sourceArtifactId: "a" });
  });
  it("rejects impossible or nonfinite geometry", () => {
    for (const value of [0, -1, Infinity, NaN]) expect(parseModelGeometry({ geometry: { schemaVersion: 1, source: "solidworks-mass-properties", volume: { value, unit: "m3" } } }, "a")).toBeNull();
    expect(parseModelGeometry({ geometry: { schemaVersion: 1, source: "solidworks-mass-properties", volume: { value: 2, unit: "m3" }, boundingBox: { unit: "m", length: 1, width: 1, height: 1 } } }, "a")).toBeNull();
  });
  it("rejects volumes and bounding boxes outside the engineering envelope", () => {
    const log = (volume: number, unit: string, boundingBox?: object) => ({
      geometry: { schemaVersion: 1, source: "solidworks-mass-properties", volume: { value: volume, unit }, ...(boundingBox === undefined ? {} : { boundingBox }) }
    });
    expect(parseModelGeometry(log(1e-300, "m3"), "a")).toBeNull();
    expect(parseModelGeometry(log(1e30, "m3"), "a")).toBeNull();
    expect(parseModelGeometry(log(11, "m3"), "a")).toBeNull();
    expect(parseModelGeometry(log(0.5, "mm3"), "a")).toBeNull();
    expect(parseModelGeometry(log(0.031, "m3", { unit: "m", length: 1e6, width: 1e6, height: 1e6 }), "a")).toBeNull();
    expect(parseModelGeometry(log(0.031, "m3"), "a")).toMatchObject({ finishedVolumeM3: 0.031 });
  });
});
