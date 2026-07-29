import { deflateSync, inflateSync } from "node:zlib";

/**
 * The app icons, drawn in code.
 *
 * PWA icons are not decoration here: iOS only exempts a *home screen* web app
 * from its seven day storage eviction, and a home screen web app needs an icon.
 * So the icons are part of the data-protection story, and they had to come from
 * somewhere.
 *
 * They come from here rather than from a design tool or an npm package, for the
 * reason this project has not gained a dependency since Phase 1: a 512px PNG of
 * a tick is a few hundred lines of arithmetic, and `node:zlib` already ships the
 * only hard part (DEFLATE). Committing a binary nobody can regenerate is how a
 * repository ends up with assets it cannot change.
 *
 * Everything below is pure: `renderIcon` returns pixels, `encodePng` returns
 * bytes, `decodePng` turns them back. `scripts/generate-icons.ts` is the only
 * part that writes files, and `scripts/icons.test.ts` checks that the bytes
 * committed under `client/public/` are still the bytes this file produces.
 */

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

/** A raster of 8-bit RGB pixels, row major. No alpha — every icon is opaque. */
export type Raster = {
  width: number;
  height: number;
  /** `width * height * 3` bytes. */
  pixels: Uint8Array;
};

export type Rgb = [number, number, number];

/**
 * The app's blue, and the one the heatmap already uses for its middle step
 * (`--heat-2` in styles.css). The icon is the first thing the user sees of the
 * app on their home screen; it should be the same colour as the thing they open.
 */
export const BRAND: Rgb = [0x2a, 0x78, 0xd6];
const MARK: Rgb = [0xff, 0xff, 0xff];

/**
 * The tick, in the unit square.
 *
 * Three points, two segments. Drawn as a distance field rather than as a path so
 * that anti-aliasing falls out of the arithmetic instead of needing a rasteriser.
 */
const STROKE = [
  [0.06, 0.55],
  [0.38, 0.86],
  [0.94, 0.14],
] as const;

/** Stroke thickness, as a fraction of the mark's box. */
const STROKE_WIDTH = 0.19;

/** Distance from a point to a line segment. */
function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;

  // Degenerate segment: fall back to the distance to the point itself.
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));

  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * A square icon: brand background, white tick.
 *
 * `markScale` is the fraction of the canvas the tick's box occupies, centred.
 * It is the whole difference between the plain icon and the maskable one — a
 * maskable icon must survive being cropped to a circle of 80% of its width, and
 * a centred square of side `s` fits inside that circle only while `s * √2 ≤ 0.8`.
 */
export function renderIcon(size: number, markScale: number): Raster {
  const pixels = new Uint8Array(size * size * 3);

  const box = size * markScale;
  const originX = (size - box) / 2;
  const originY = (size - box) / 2;
  const halfWidth = (STROKE_WIDTH * box) / 2;

  // Segment endpoints in device pixels, so the inner loop is plain arithmetic.
  const points = STROKE.map(([x, y]) => [originX + x * box, originY + y * box] as const);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      let distance = Infinity;
      for (let i = 0; i + 1 < points.length; i += 1) {
        const a = points[i] as readonly [number, number];
        const b = points[i + 1] as readonly [number, number];
        distance = Math.min(distance, distanceToSegment(px, py, a[0], a[1], b[0], b[1]));
      }

      // One pixel of feather across the edge: coverage 1 well inside the stroke,
      // 0 well outside, linear in between.
      const coverage = Math.max(0, Math.min(1, halfWidth + 0.5 - distance));

      const offset = (y * size + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const background = BRAND[channel] as number;
        const foreground = MARK[channel] as number;
        pixels[offset + channel] = Math.round(background + (foreground - background) * coverage);
      }
    }
  }

  return { width: size, height: size, pixels };
}

// ---------------------------------------------------------------------------
// PNG
//
// Colour type 2 (truecolour, 8 bits), filter 0 on every scanline. That is the
// simplest conforming PNG there is, and it keeps `decodePng` below short enough
// to be obviously correct — which matters, because the test compares *pixels*
// rather than bytes. Comparing bytes would make the suite depend on the exact
// zlib build that produced the committed files.
// ---------------------------------------------------------------------------

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);

  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function encodePng(raster: Raster): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, raster.width);
  view.setUint32(4, raster.height);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0; // compression: deflate
  header[11] = 0; // filter method: adaptive (we always choose 0)
  header[12] = 0; // interlace: none

  const stride = raster.width * 3;
  const raw = new Uint8Array((stride + 1) * raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 — none
    raw.set(raster.pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  return concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * The inverse, for the test. Only understands what `encodePng` writes — anything
 * else throws rather than guessing.
 */
export function decodePng(bytes: Uint8Array): Raster {
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error("not a PNG: bad signature");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  let offset = SIGNATURE.length;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];

  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (data[8] !== 8 || data[9] !== 2) throw new Error("unsupported PNG: expected 8-bit truecolour");
      if (data[12] !== 0) throw new Error("unsupported PNG: interlaced");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset += 12 + length;
  }

  const raw = new Uint8Array(inflateSync(concat(idat)));
  const stride = width * 3;
  const pixels = new Uint8Array(stride * height);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error(`unsupported PNG: scanline filter ${String(filter)}`);
    pixels.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }

  return { width, height, pixels };
}

// ---------------------------------------------------------------------------
// What gets written
// ---------------------------------------------------------------------------

export type IconSpec = {
  /** Path under `client/public/`. */
  file: string;
  size: number;
  markScale: number;
  why: string;
};

/**
 * Every icon the app ships, and why each one exists.
 *
 * `apple-touch-icon.png` sits at the root rather than under `icons/` because iOS
 * probes `/apple-touch-icon.png` when it cannot find a `<link>` — and the whole
 * point of this file is that adding to the home screen must not fail.
 */
export const ICONS: IconSpec[] = [
  { file: "icons/icon-192.png", size: 192, markScale: 0.62, why: "manifest, purpose any" },
  { file: "icons/icon-512.png", size: 512, markScale: 0.62, why: "manifest, purpose any / install prompt" },
  {
    file: "icons/icon-maskable-512.png",
    size: 512,
    // 0.50 * √2 = 0.71 of the width, inside the 0.8 safe circle a maskable icon
    // is cropped to. At 0.62 the tick's corners would be shaved off on Android.
    markScale: 0.5,
    why: "manifest, purpose maskable",
  },
  { file: "apple-touch-icon.png", size: 180, markScale: 0.62, why: "iOS home screen" },
];

export function renderIconFile(spec: IconSpec): Uint8Array {
  return encodePng(renderIcon(spec.size, spec.markScale));
}
