import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Of } from "../test-utils.js";

/** Test-only measured-log fixture for disposable HTTP integration databases. */
export function registerGeometryFixture(dataRoot: string, modelId: string, volumeM3 = 0.031): void {
  const db = new DatabaseSync(join(dataRoot, "state", "swpanel.db"));
  try {
    const row = db.prepare("SELECT a.id,a.relative_path,m.validation_summary_json FROM artifacts a JOIN models m ON m.id=a.model_id WHERE m.id=? AND a.kind='BUILD_VALIDATION_LOG'").get(modelId) as { id: string; relative_path: string; validation_summary_json: string };
    const summary = JSON.parse(row.validation_summary_json) as { solidWorksVersion: string };
    const bytes = Buffer.from(JSON.stringify({ solidWorksVersion: summary.solidWorksVersion, rebuildStatus: "PASSED", geometry: { schemaVersion: 1, source: "solidworks-mass-properties", volume: { value: volumeM3, unit: "m3" } } }));
    writeFileSync(join(dataRoot, "workspaces", row.relative_path), bytes);
    db.prepare("UPDATE artifacts SET size_bytes=?,sha256=? WHERE id=?").run(bytes.length, sha256Of(bytes), row.id);
  } finally { db.close(); }
}
