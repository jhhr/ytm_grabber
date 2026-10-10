import { spawnSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { extensionIdFromManifestKey, extensionIdFromSpkiDer, PRIVATE_KEY_FILE } from "../scripts/gen-key.mjs";

// The ID the native host is registered for (install.ps1 -ExtensionId). It changes only
// if someone replaces the manifest key, which this test is here to notice.
const EXTENSION_ID = "mengelecikhhdpjdebjpokcmhdkhjobj";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(root, "scripts", "gen-key.mjs");
const scratch = mkdtempSync(path.join(tmpdir(), "ytm-gen-key-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Written separately from gen-key.mjs: each nibble of the first 16 digest bytes indexes a-p. */
function idFromDigest(digest: Uint8Array): string {
  const letters = "abcdefghijklmnop";
  let id = "";
  for (const byte of digest.subarray(0, 16)) id += letters[byte >> 4] + letters[byte & 15];
  return id;
}

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

describe("extension ID derivation", () => {
  it("maps the first 16 bytes of SHA-256 to letters a-p", () => {
    // SHA-256("abc") = ba7816bf 8f01cfea 414140de 5dae2223 ... (FIPS 180-2 example).
    expect(extensionIdFromSpkiDer(Buffer.from("abc"))).toBe("lkhibglpipabmpokebebeanofnkocccd");
  });

  it.skipIf(!hasOpenssl)("agrees with OpenSSL on a key OpenSSL generates", () => {
    const pem = path.join(scratch, "openssl-key.pem");
    const der = path.join(scratch, "openssl-pub.der");
    const run = (args: string[]) => {
      const result = spawnSync("openssl", args);
      expect(result.status, result.stderr.toString()).toBe(0);
      return result.stdout;
    };
    run(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", pem]);
    run(["pkey", "-in", pem, "-pubout", "-outform", "DER", "-out", der]);
    const digest = run(["dgst", "-sha256", "-binary", der]);
    const spki = readFileSync(der);

    expect(extensionIdFromSpkiDer(spki)).toBe(idFromDigest(digest));
    // Node's "spki" DER (what gen-key writes) is the SubjectPublicKeyInfo OpenSSL writes.
    const fromNode = createPublicKey(readFileSync(pem)).export({ type: "spki", format: "der" });
    expect(Buffer.compare(fromNode, spki)).toBe(0);
  });

  it("gives the recorded ID for the committed manifest key", () => {
    const { key } = JSON.parse(readFileSync(path.join(root, "static", "manifest.json"), "utf8"));
    const der = Buffer.from(key, "base64");
    const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
    expect(publicKey.asymmetricKeyType).toBe("rsa");
    expect(publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(idFromDigest(createHash("sha256").update(der).digest())).toBe(EXTENSION_ID);
    expect(extensionIdFromManifestKey(key)).toBe(EXTENSION_ID);
  });
});

describe("gen-key script", () => {
  const dir = path.join(scratch, "cli");
  const manifestPath = path.join(dir, "manifest.json");
  const keysDir = path.join(dir, "keys");
  const keyPath = path.join(keysDir, PRIVATE_KEY_FILE);
  const genKey = (...extra: string[]) =>
    spawnSync(process.execPath, [script, "--manifest", manifestPath, "--keys-dir", keysDir, ...extra], {
      encoding: "utf8",
    });
  const readManifest = () => JSON.parse(readFileSync(manifestPath, "utf8"));
  const printedId = (stdout: string) => /Extension ID: ([a-p]{32})/.exec(stdout)?.[1];

  it("writes the key pair, prints the ID, and refuses to replace it without --force", () => {
    mkdirSync(dir, { recursive: true });
    const original = { manifest_version: 3, name: "Test", key: "", version: "1.0" };
    writeFileSync(manifestPath, JSON.stringify(original, null, 2) + "\n");

    const first = genKey();
    expect(first.status, first.stderr).toBe(0);
    const manifest = readManifest();
    expect(Object.keys(manifest)).toEqual(Object.keys(original));
    expect({ ...manifest, key: "" }).toEqual(original);
    expect(printedId(first.stdout)).toBe(extensionIdFromManifestKey(manifest.key));
    const pem = readFileSync(keyPath, "utf8");
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    if (process.platform !== "win32") expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const publicFromPem = createPublicKey(pem).export({ type: "spki", format: "der" }).toString("base64");
    expect(publicFromPem).toBe(manifest.key);

    const manifestText = readFileSync(manifestPath, "utf8");
    const refused = genKey();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--force");
    expect(readFileSync(manifestPath, "utf8")).toBe(manifestText);
    expect(readFileSync(keyPath, "utf8")).toBe(pem);

    // A private key alone also counts as an existing key.
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, key: "" }, null, 2) + "\n");
    expect(genKey().status).toBe(1);
    expect(readFileSync(keyPath, "utf8")).toBe(pem);

    const forced = genKey("--force");
    expect(forced.status, forced.stderr).toBe(0);
    const replaced = readManifest().key;
    expect(replaced).not.toBe(manifest.key);
    expect(printedId(forced.stdout)).toBe(extensionIdFromManifestKey(replaced));
    expect(readFileSync(keyPath, "utf8")).not.toBe(pem);
  }, 60_000);
});
