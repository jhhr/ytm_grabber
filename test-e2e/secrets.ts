// The fake secrets the mock Better Lyrics page sends the way BL sends its real ones: a Turnstile
// JWT as the `token=` field of the stream's form body (a second one for BL's retry after a 403)
// and an identity in Unison's `x-key-id` header. The server log must show them arriving (so they
// really were in flight past the debugger) while the extension's storage and every console line
// must not contain them.

export const E2E_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJFMkUtRklSU1QtVE9LRU4ifQ.ZTJlLWZpcnN0LXNpZ25hdHVyZQ";
export const E2E_RETRY_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJFMkUtUkVUUlktVE9LRU4ifQ.ZTJlLXJldHJ5LXNpZ25hdHVyZQ";
export const E2E_KEY_ID = "E2E-SECRET-KEY-ID-4f2a91";

export const E2E_SECRETS = [E2E_TOKEN, E2E_RETRY_TOKEN, E2E_KEY_ID] as const;

/**
 * Strings that betray `secret` in `text`: the secret itself and the middle of its base64 encoding
 * at each of the three byte alignments (CDP hands a form body over as base64 in
 * `postDataEntries`, so a body kept by mistake would show up that way). The first and last base64
 * groups are dropped, since the bytes around the secret change them.
 */
export function secretNeedles(secret: string): string[] {
  const needles = [secret];
  for (let pad = 0; pad < 3; pad++) {
    const encoded = Buffer.from("\0".repeat(pad) + secret, "latin1").toString("base64").replace(/=+$/, "");
    needles.push(encoded.slice(4, -4));
  }
  return needles;
}

/** The secrets (by name) found in `text`; empty when it holds none of them in any form. */
export function secretsIn(text: string): string[] {
  const names = ["E2E_TOKEN", "E2E_RETRY_TOKEN", "E2E_KEY_ID"];
  return E2E_SECRETS.flatMap((secret, index) => (secretNeedles(secret).some((needle) => text.includes(needle)) ? [names[index]] : []));
}
