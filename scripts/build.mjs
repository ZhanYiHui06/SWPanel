import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/design-source", { recursive: true });
await cp(".design/project.json", "dist/design-source/project.json");

console.log("SWPanel Phase 0 build completed.");
