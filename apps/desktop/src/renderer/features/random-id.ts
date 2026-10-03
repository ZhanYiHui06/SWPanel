/**
 * Random identifiers that also work outside secure contexts.
 *
 * `crypto.randomUUID` is only exposed on HTTPS / localhost; `getRandomValues`
 * is available everywhere, so it is the fallback (and `Math.random` the last
 * resort when no Web Crypto exists at all, e.g. exotic test environments).
 */

/** RFC 4122 version-4 UUID. */
export function randomId(): string {
  const webCrypto = typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto;
  if (webCrypto !== undefined && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (webCrypto !== undefined && typeof webCrypto.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
