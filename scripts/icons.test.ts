import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { BRAND, ICONS, decodePng, encodePng, renderIcon, renderIconFile } from "./icons.ts";

/**
 * The icons, checked against the code that draws them.
 *
 * The committed PNGs are binary, and a binary that has drifted from its
 * generator is a file nobody can safely change. So the comparison is on
 * *pixels*, not bytes: DEFLATE output is allowed to differ between zlib builds,
 * and a suite that failed on a Node upgrade would teach everyone to ignore it.
 */

const publicDir = path.resolve(import.meta.dirname, "..", "client", "public");

function readIcon(file: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(publicDir, file)));
}

describe("the PNG encoder", () => {
  it("round-trips a raster through encode and decode", () => {
    const raster = renderIcon(24, 0.62);
    const decoded = decodePng(encodePng(raster));

    assert.equal(decoded.width, raster.width);
    assert.equal(decoded.height, raster.height);
    assert.deepEqual(decoded.pixels, raster.pixels);
  });

  it("writes a file every PNG reader recognises", () => {
    const bytes = encodePng(renderIcon(8, 0.62));

    // Signature, then IHDR as the first chunk, then IEND as the last.
    assert.deepEqual(Array.from(bytes.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(new TextDecoder().decode(bytes.subarray(12, 16)), "IHDR");
    assert.equal(new TextDecoder().decode(bytes.subarray(bytes.length - 8, bytes.length - 4)), "IEND");
  });
});

describe("the drawn icon", () => {
  it("fills the corners with the brand colour, so nothing is transparent", () => {
    // iOS composites a home screen icon over its own background and does not
    // round transparent edges kindly; every icon here is deliberately opaque and
    // full bleed.
    const raster = renderIcon(64, 0.62);
    const corners = [0, 63, 64 * 63, 64 * 64 - 1];

    for (const index of corners) {
      const pixel = Array.from(raster.pixels.subarray(index * 3, index * 3 + 3));
      assert.deepEqual(pixel, BRAND, `corner pixel ${index}`);
    }
  });

  it("actually draws the mark — the centre is not just background", () => {
    const raster = renderIcon(64, 0.62);
    let light = 0;
    for (let i = 0; i < raster.pixels.length; i += 3) {
      if ((raster.pixels[i] as number) > 200) light += 1;
    }
    // A tick covers a few percent of the canvas. The point is only that it is
    // neither absent nor the whole square.
    assert.ok(light > 100, `expected a visible mark, found ${light} light pixels`);
    assert.ok(light < 64 * 64 * 0.5, `the mark swallowed the icon: ${light} light pixels`);
  });

  it("keeps the maskable icon inside the 80% safe circle", () => {
    // Android crops a maskable icon to a circle of 80% of its width. Anything
    // the tick puts outside that circle can be shaved off on some launchers.
    const spec = ICONS.find((candidate) => candidate.file.includes("maskable"));
    assert.ok(spec, "no maskable icon is declared");

    const size = 128;
    const raster = renderIcon(size, spec.markScale);
    const centre = size / 2;
    const safeRadius = (size * 0.8) / 2;

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const isMark = (raster.pixels[(y * size + x) * 3] as number) > 200;
        if (!isMark) continue;
        const distance = Math.hypot(x + 0.5 - centre, y + 0.5 - centre);
        assert.ok(distance <= safeRadius, `mark pixel at (${x}, ${y}) falls outside the safe circle`);
      }
    }
  });
});

describe("the committed files", () => {
  for (const spec of ICONS) {
    it(`${spec.file} is what scripts/icons.ts draws`, () => {
      const committed = decodePng(readIcon(spec.file));
      const expected = decodePng(renderIconFile(spec));

      assert.equal(committed.width, spec.size);
      assert.equal(committed.height, spec.size);
      assert.deepEqual(
        committed.pixels,
        expected.pixels,
        `${spec.file} is stale — run \`npm run icons\``,
      );
    });
  }

  it("declares the sizes the manifest and iOS ask for", () => {
    const files = ICONS.map((spec) => `${spec.file}:${spec.size}`);
    assert.ok(files.includes("icons/icon-192.png:192"), "AC-8.1 requires a 192px icon");
    assert.ok(files.includes("icons/icon-512.png:512"), "AC-8.1 requires a 512px icon");
    assert.ok(files.includes("apple-touch-icon.png:180"), "AC-8.2 requires an apple-touch-icon");
  });
});
