// Generates the Call Guard PWA icons (dependency-free PNG encoder). node scripts/dev/make-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [18, 25, 43];       // ≈ --background (dark navy)
const SHIELD = [56, 200, 214];  // ≈ --primary (teal)
const TICK = [12, 20, 36];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

// Shield outline in unit coordinates.
const shield = [];
shield.push([0.25, 0.25], [0.5, 0.17], [0.75, 0.25], [0.75, 0.48]);
for (let i = 1; i <= 16; i++) {
  const t = i / 16; // right side curving to the tip
  shield.push([0.75 * (1 - t) ** 2 + 2 * 0.73 * t * (1 - t) + 0.5 * t * t, 0.48 * (1 - t) ** 2 + 2 * 0.72 * t * (1 - t) + 0.85 * t * t]);
}
for (let i = 1; i <= 16; i++) {
  const t = i / 16;
  shield.push([0.5 * (1 - t) ** 2 + 2 * 0.27 * t * (1 - t) + 0.25 * t * t, 0.85 * (1 - t) ** 2 + 2 * 0.72 * t * (1 - t) + 0.48 * t * t]);
}
const inPoly = (x, y, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const distSeg = (px, py, [ax, ay], [bx, by]) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};
const tick = [[0.37, 0.5], [0.46, 0.6], [0.64, 0.4]];

function render(size, { rounded }) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const S = 4; // supersampling
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const u = (x + (sx + 0.5) / S) / size, v = (y + (sy + 0.5) / S) / size;
        let col = BG, alpha = 1;
        if (rounded) {
          const rad = 0.22, cx = Math.min(Math.max(u, rad), 1 - rad), cy = Math.min(Math.max(v, rad), 1 - rad);
          if (Math.hypot(u - cx, v - cy) > rad) alpha = 0;
        }
        if (inPoly(u, v, shield)) col = SHIELD;
        if (Math.min(distSeg(u, v, tick[0], tick[1]), distSeg(u, v, tick[1], tick[2])) < 0.035) col = TICK;
        r += col[0] * alpha; g += col[1] * alpha; b += col[2] * alpha; a += alpha;
      }
      const n = S * S, o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0; raw[o + 1] = a ? Math.round(g / a) : 0; raw[o + 2] = a ? Math.round(b / a) : 0; raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const out = new URL("../../app/protect/_assets/", import.meta.url);
writeFileSync(new URL("icon-192.png", out), render(192, { rounded: false }));
writeFileSync(new URL("icon-512.png", out), render(512, { rounded: false }));
writeFileSync(new URL("apple-touch-icon.png", out), render(180, { rounded: false }));
writeFileSync(new URL("badge-96.png", out), render(96, { rounded: true }));
console.log("icons written");
