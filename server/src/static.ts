import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Context } from "hono";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

async function sendFile(filePath: string, immutable: boolean): Promise<Response> {
  const data = await fsp.readFile(filePath);
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": contentTypeFor(filePath),
      // Vite fingerprints files under /assets, so they can be cached forever.
      // index.html must not be, or a deploy keeps serving the old bundle.
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}

/**
 * Serves the built SPA from `distDir` — the same path a deployment uses, which
 * is why the E2E harness boots the server alone with no dev server in front.
 *
 * Requests for a path with no file extension fall back to index.html so that
 * client-side routes survive a reload; requests for a missing asset stay 404.
 */
export function createClientStaticHandler(distDir: string) {
  const root = path.resolve(distDir);
  const indexHtml = path.join(root, "index.html");

  return async function serveClient(c: Context): Promise<Response> {
    if (!isFile(indexHtml)) {
      return c.text(
        `client build not found at ${root}. Run \`npm run build\` first, or use \`npm run dev\` for the Vite dev server.`,
        503,
      );
    }

    const pathname = decodeURIComponent(new URL(c.req.url).pathname);
    const requested = path.resolve(root, `.${path.posix.normalize(pathname)}`);

    // Refuse anything that escapes the dist directory (`..`, absolute paths).
    const insideRoot = requested === root || requested.startsWith(root + path.sep);

    if (insideRoot && requested !== root && isFile(requested)) {
      const immutable = path.relative(root, requested).split(path.sep)[0] === "assets";
      return await sendFile(requested, immutable);
    }

    // SPA fallback, but only for document-ish paths: a missing .js or .png must
    // not resolve to HTML, or the browser fails with a confusing MIME error.
    if (path.extname(pathname) === "" || pathname === "/") {
      return await sendFile(indexHtml, false);
    }

    return c.text("Not Found", 404);
  };
}
