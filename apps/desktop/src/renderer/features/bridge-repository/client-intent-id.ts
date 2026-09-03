/**
 * Opaque client intent id for retryable fact/feedback mutations (WP6).
 *
 * The Renderer mints EXACTLY ONE id per form submission and reuses it only for
 * retries of the identical submission (the dialogs pair the id with the
 * submitted payload signature). Main converts the id into the Runner's
 * idempotency key and re-validates the exact token shape (`swint_` + 32
 * lowercase hex chars) — arbitrary or unbounded strings are never trusted. The
 * id itself never appears in the Runner wire command.
 */

import { CLIENT_INTENT_ID_PREFIX } from "../../../main/bridge/bridge-contract.js";

/** Mints a fresh opaque intent id matching `CLIENT_INTENT_ID_PATTERN`. */
export function newClientIntentId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${CLIENT_INTENT_ID_PREFIX}${hex}`;
}
