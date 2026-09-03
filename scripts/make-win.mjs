import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeWinInstaller } from "./installer.mjs";

export { makeWinInstaller } from "./installer.mjs";

function isEntryPoint() {
  const invoked = process.argv[1];
  return (
    invoked !== undefined &&
    path.resolve(invoked) === fileURLToPath(import.meta.url)
  );
}

if (isEntryPoint()) {
  try {
    const result = await makeWinInstaller();
    if (result.ok) {
      console.log("make:win chain complete.");
      console.log(`Installers published to ${result.installersPath}.`);
      console.log(`Installer audit report: ${result.reportPath}`);
    } else {
      console.error(
        `make:win aborted at stage "${result.stage}"` +
          (result.exitCode !== undefined ? ` (exit ${result.exitCode})` : "") +
          "."
      );
      if (result.error !== undefined) {
        console.error(result.error);
      }
      if (result.runDir !== undefined) {
        console.error(
          `The failed installer run output remains under the temporary directory ${result.runDir} ` +
            "and was never published to installers."
        );
      }
      process.exitCode = result.exitCode ?? 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
