// A throwaway self-signed certificate for the mock servers, made with openssl at test start in a
// temporary directory (no key is ever committed). Chromium is launched with
// --ignore-certificate-errors, so nothing has to trust it; the names are there for readers of a
// trace.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const YTM_HOST = "music.youtube.com";
export const LYRICS_HOST = "lyrics.api.dacubeking.com";
export const UNISON_HOST = "unison.betterlyrics.org";
export const MOCK_HOSTS = [YTM_HOST, LYRICS_HOST, UNISON_HOST] as const;

export interface Certificate {
  key: string;
  cert: string;
}

export function makeCertificate(dir: string): Certificate {
  const keyFile = path.join(dir, "e2e-key.pem");
  const certFile = path.join(dir, "e2e-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "2",
      "-subj",
      "/CN=ytm-grabber-e2e",
      "-addext",
      `subjectAltName=${MOCK_HOSTS.map((host) => `DNS:${host}`).join(",")}`,
    ],
    { stdio: "pipe" },
  );
  return { key: readFileSync(keyFile, "utf8"), cert: readFileSync(certFile, "utf8") };
}
