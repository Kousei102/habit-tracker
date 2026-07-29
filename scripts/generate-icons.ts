import fs from "node:fs";
import path from "node:path";
import { ICONS, renderIconFile } from "./icons.ts";

/**
 * Writes the app icons into `client/public/`.
 *
 * Run with `npm run icons`. The output is committed, so a clean clone can build
 * and serve without running this — but `scripts/icons.test.ts` fails if the
 * committed files stop matching what `scripts/icons.ts` draws, which is what
 * keeps "generated in the repository" from decaying into "a binary nobody dares
 * touch".
 */

const publicDir = path.resolve(import.meta.dirname, "..", "client", "public");

for (const spec of ICONS) {
  const target = path.join(publicDir, spec.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const bytes = renderIconFile(spec);
  fs.writeFileSync(target, bytes);
  console.log(`${spec.file}  ${spec.size}x${spec.size}  ${bytes.length} bytes  (${spec.why})`);
}
