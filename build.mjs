// Builds the unpacked extension: esbuild bundles each entry into one file (content
// scripts must be single classic scripts), then static/ and the content stylesheet are
// copied next to them.
//
//   node build.mjs                  build into dist/ (emptied first)
//   node build.mjs --outdir <dir>   build into <dir> (not emptied; used by the tests)
//   node build.mjs --watch          rebuild on change
import * as esbuild from "esbuild";
import { watch } from "node:fs";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    watch: { type: "boolean", default: false },
    outdir: { type: "string" },
  },
});
const outdir = args.outdir ? path.resolve(args.outdir) : path.join(root, "dist");

const common = {
  absWorkingDir: root,
  outdir,
  bundle: true,
  target: "es2022",
  logLevel: "info",
};
const builds = [
  // The service worker is declared with "type": "module" in the manifest.
  { ...common, format: "esm", entryPoints: { background: "src/background/sw.ts" } },
  {
    ...common,
    format: "iife",
    entryPoints: {
      content: "src/content/main.ts",
      "page-bridge": "src/content/page-bridge.ts",
      options: "src/options/options.ts",
    },
  },
];

async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  await cp(path.join(root, "static"), outdir, { recursive: true });
  await copyFile(path.join(root, "src/content/styles.css"), path.join(outdir, "content.css"));
}

// Only the default output is emptied: a mistyped --outdir must never delete anything.
if (!args.outdir) await rm(outdir, { recursive: true, force: true });

if (args.watch) {
  await copyStatic();
  for (const options of builds) await (await esbuild.context(options)).watch();
  // esbuild watches the bundled sources; static files and the stylesheet are not
  // bundled, so copy them again when they change.
  let timer;
  const recopy = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      copyStatic().then(
        () => console.log("[watch] static files copied"),
        (error) => console.error(error),
      );
    }, 100);
  };
  watch(path.join(root, "static"), { recursive: true }, recopy);
  watch(path.join(root, "src/content"), (_event, file) => {
    if (file === "styles.css") recopy();
  });
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  await copyStatic();
}
