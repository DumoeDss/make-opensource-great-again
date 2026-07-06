/**
 * Same-origin static serving of the built `@mosga/ui` at `/ui` (design D2).
 * Serving the built dist from the daemon means the browser calls the API on the
 * same origin — zero CORS. The dist path is resolved at RUNTIME and its absence
 * is reported clearly (the daemon serves the API before the UI is built; a
 * missing build must not degrade to a silent 404 / blank page).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

const require = createRequire(import.meta.url);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve the `@mosga/ui` dist directory, or null if it cannot be located / is
 * not built. `MOSGA_UI_DIST` overrides discovery (useful for tests / custom
 * layouts). Otherwise the ui package is resolved via its `package.json` and its
 * sibling `dist/` used.
 */
export function resolveUiDist(): string | null {
  const override = process.env.MOSGA_UI_DIST;
  if (override) {
    return fs.existsSync(path.join(override, 'index.html')) ? override : null;
  }
  try {
    const pkgJson = require.resolve('@mosga/ui/package.json');
    const dist = path.join(path.dirname(pkgJson), 'dist');
    return fs.existsSync(path.join(dist, 'index.html')) ? dist : null;
  } catch {
    return null;
  }
}

/** True for any request path the static server owns. */
export function isUiPath(pathname: string): boolean {
  return pathname === '/ui' || pathname.startsWith('/ui/');
}

/**
 * Serve a `/ui`-prefixed request from `distPath`. Path traversal outside the
 * dist is rejected; unknown sub-paths fall back to `index.html` so the SPA can
 * handle client routing.
 */
export function serveUi(distPath: string, pathname: string, res: ServerResponse): void {
  let rel = pathname.replace(/^\/ui\/?/, '');
  if (rel === '') rel = 'index.html';

  const resolved = path.resolve(distPath, rel);
  const distResolved = path.resolve(distPath);
  if (resolved !== distResolved && !resolved.startsWith(distResolved + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  let filePath = resolved;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // SPA fallback — unknown routes render index.html.
    filePath = path.join(distPath, 'index.html');
  }

  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'content-length': data.length });
  res.end(data);
}

/** The clear error shown when a `/ui` request arrives but no build exists. */
export function uiNotBuiltMessage(): string {
  return (
    'The @mosga/ui build was not found. Build the UI first: run `npm run build ' +
    '-w @mosga/ui` (or set MOSGA_UI_DIST to a directory containing index.html). ' +
    'The API is available under /api regardless.'
  );
}
