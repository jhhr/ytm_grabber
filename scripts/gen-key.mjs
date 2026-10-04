// Creates the RSA key that pins the extension ID: the base64 DER public key goes into
// static/manifest.json "key", the private key (PEM, only needed to pack a .crx) into keys/
// (gitignored). The ID is what install.ps1 registers for native messaging, so this
// refuses to replace an existing key unless given --force.
//
//   npm run gen-key [-- --force] [-- --manifest <file> --keys-dir <dir>]
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const PRIVATE_KEY_FILE = "extension-key.pem";

/**
 * Chrome's extension ID: SHA-256 of the DER SubjectPublicKeyInfo, first 16 bytes as
 * 32 hex digits, each digit 0-f written as a letter a-p.
 * @param {Uint8Array} der
 * @returns {string}
 */
export function extensionIdFromSpkiDer(der) {
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

/**
 * @param {string} manifestKey the manifest's "key": base64 DER SubjectPublicKeyInfo
 * @returns {string}
 */
export function extensionIdFromManifestKey(manifestKey) {
  return extensionIdFromSpkiDer(Buffer.from(manifestKey, "base64"));
}

function main() {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { values: args } = parseArgs({
    options: {
      force: { type: "boolean", default: false },
      manifest: { type: "string", default: path.join(root, "static", "manifest.json") },
      "keys-dir": { type: "string", default: path.join(root, "keys") },
    },
  });
  const manifestPath = path.resolve(args.manifest);
  const keyPath = path.resolve(args["keys-dir"], PRIVATE_KEY_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (!args.force && (manifest.key || existsSync(keyPath))) {
    const id = manifest.key ? extensionIdFromManifestKey(manifest.key) : "(none in manifest)";
    console.error(
      `A key already exists (extension ID ${id}). Replacing it changes the extension ID, ` +
        `so the native host must be registered again. Use --force to replace it.`,
    );
    process.exitCode = 1;
    return;
  }

  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  mkdirSync(path.dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  manifest.key = publicKey.toString("base64");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`Wrote the public key to ${manifestPath}`);
  console.log(`Wrote the private key to ${keyPath} (keep it out of git)`);
  console.log(`Extension ID: ${extensionIdFromSpkiDer(publicKey)}`);
}

// Run only as a script, not when the tests import the functions above. Node itself
// resolves the entry module this way (realpath, then file URL).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
