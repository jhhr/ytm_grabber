// Writes static/icons/icon-<size>.png: a white download arrow on a violet rounded square.
// No image tools are needed: shapes are sampled 4x4 per pixel (anti-aliasing) and saved
// as RGBA PNGs with node:zlib. Run `node scripts/make-icons.mjs` after changing the design.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZES = [16, 32, 48, 128];
const BACKGROUND = [0x5b, 0x3c, 0xc4];
const GLYPH = [0xff, 0xff, 0xff];
const SAMPLES = 4;

// Shapes in unit coordinates (0..1, y down).
function inBackground(x, y) {
  const margin = 0.03;
  const radius = 0.22;
  const half = 0.5 - margin;
  const dx = Math.max(Math.abs(x - 0.5) - (half - radius), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (half - radius), 0);
  return Math.abs(x - 0.5) <= half && Math.abs(y - 0.5) <= half && dx * dx + dy * dy <= radius * radius;
}

function inGlyph(x, y) {
  const shaft = x >= 0.41 && x <= 0.59 && y >= 0.16 && y <= 0.5;
  // Arrow head: triangle with its base at y = 0.42 and its tip at (0.5, 0.72).
  const head = y >= 0.42 && y <= 0.72 && Math.abs(x - 0.5) <= 0.29 * ((0.72 - y) / 0.3);
  const tray = x >= 0.2 && x <= 0.8 && y >= 0.78 && y <= 0.88;
  return shaft || head || tray;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let covered = 0;
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          if (!inBackground(x, y)) continue;
          const colour = inGlyph(x, y) ? GLYPH : BACKGROUND;
          covered++;
          for (let c = 0; c < 3; c++) sum[c] += colour[c];
        }
      }
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) rgba[i + c] = covered ? Math.round(sum[c] / covered) : 0;
      rgba[i + 3] = Math.round((255 * covered) / (SAMPLES * SAMPLES));
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // colour type RGBA
  // Bytes 10-12 (compression, filter method, interlace) stay 0.
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    // Each row starts with its filter type, 0 = none.
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "static", "icons");
mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = path.join(outDir, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
