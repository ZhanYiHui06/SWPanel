import type { RunRepository } from "../db/run-repository.js";
import type { RunWorkspaceLedger } from "../ledger/run-workspace-ledger.js";
import { InvalidArgumentError, NotFoundError } from "../errors.js";

export interface RegisteredFile { content: Buffer; fileName: string; mimeType: string }
export function readRegisteredArtifact(runs: RunRepository, workspace: RunWorkspaceLedger, modelId: string, artifactId: string): RegisteredFile {
  const artifact = runs.getModelArtifact(modelId, artifactId);
  if (artifact === null) throw new NotFoundError("Model artifact was not found");
  const prefix = `runs/${artifact.runId}/attempt-`;
  if (!artifact.relativePath.startsWith(prefix)) throw new InvalidArgumentError("Artifact path is outside its run workspace");
  const match = /^(\d{3,})\/(.+)$/.exec(artifact.relativePath.slice(prefix.length));
  if (match === null) throw new InvalidArgumentError("Artifact path has no valid attempt identity");
  const attemptSequence = Number(match[1]);
  if (RunWorkspaceAttemptLabel(attemptSequence) !== match[1]) throw new InvalidArgumentError("Artifact attempt identity is not canonical");
  const file = workspace.readOwnedFile({ runId: artifact.runId, attemptSequence, relativePath: match[2]! });
  if (file === null) throw new NotFoundError("Registered artifact file is missing");
  if (file.sizeBytes !== artifact.sizeBytes || file.sha256 !== artifact.sha256) throw new InvalidArgumentError("Registered artifact integrity verification failed");
  const mimeType = artifact.kind === "MODEL_PREVIEW_PNG" ? "image/png" : artifact.fileName.toLowerCase().endsWith(".png") ? "image/png" : artifact.fileName.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
  return { content: file.content, fileName: artifact.fileName, mimeType };
}
function RunWorkspaceAttemptLabel(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new InvalidArgumentError("Artifact attempt sequence is invalid");
  return String(sequence).padStart(3, "0");
}
