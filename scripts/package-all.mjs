import path from "node:path";
import { fileURLToPath } from "node:url";

import { packageAll } from "./packaging.mjs";

export { packageAll } from "./packaging.mjs";

function isEntryPoint() {
  const invoked = process.argv[1];
  return (
    invoked !== undefined &&
    path.resolve(invoked) === fileURLToPath(import.meta.url)
  );
}

if (isEntryPoint()) {
  try {
    const result = await packageAll();
    if (result.ok) {
      console.log("package:win chain complete.");
    } else {
      console.error(
        `package:win aborted at stage "${result.stage}"` +
          (result.exitCode !== undefined ? ` (exit ${result.exitCode})` : "") +
          "."
      );
      if (result.error !== undefined) {
        console.error(result.error);
      }
      if (result.runDir !== undefined) {
        console.error(
          `The failed run output remains under the temporary directory ${result.runDir} ` +
            "and was never published to out."
        );
      }
      process.exitCode = result.exitCode ?? 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
