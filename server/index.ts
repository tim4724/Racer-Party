// Bun HTTP server for Racer.
//
// Dev:  Node HTTP server + Vite in middleware mode — one port, full HMR,
//       no child processes. Vite handles JS/CSS transforms and HMR WS.
// Prod: Bun.serve with static files from dist/.
//
// Routes:
//   GET /health           → { status: 'ok' }
//   GET /api/version      → { version, env, commit? }
//   GET /api/qr?text=…    → { size, modules } via `qrcode`
//   GET /api/baseurl      → { baseUrl } using LAN IP discovery
//   GET /                 → display index
//   GET /<ROOM>           → controller index (single 4-letter segment)
//   GET /*                → static (or Vite-served in dev)

import { networkInterfaces } from 'node:os';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, resolve } from 'node:path';
import QRCode from 'qrcode';

const PORT = parseInt(process.env.PORT || '4000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const GIT_SHA = (process.env.GIT_SHA || '').trim();

const ROOT = resolve(import.meta.dir, '..');
const DIST_DIR = join(ROOT, 'dist');
const ROOM_CODE_RE = /^\/[A-Z0-9]{4}$/;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

// CSP — must allow `wasm-unsafe-eval` for Rapier, and the relay WSS endpoint.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'" + (IS_PROD ? '' : " 'unsafe-inline' 'unsafe-eval'"),
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "connect-src 'self' ws://localhost:* http://localhost:* wss://ws.couch-games.com",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

function getLocalIP(): string {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

async function generateQRMatrix(text: string): Promise<{ size: number; modules: number[] }> {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const modules = Array.from(qr.modules.data) as number[];
  const quiet = 1;
  const padded = size + quiet * 2;
  const out = new Array(padded * padded).fill(0);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      out[(row + quiet) * padded + (col + quiet)] = modules[row * size + col];
    }
  }
  return { size: padded, modules: out };
}

// ---- Shared API handler ----
// Returns { status, contentType, body } or null if not an API route.

interface ApiResult {
  status: number;
  body: string;
}

function handleApi(pathname: string, searchParams: URLSearchParams): ApiResult | null | Promise<ApiResult | null> {
  if (pathname === '/health') {
    return { status: 200, body: JSON.stringify({ status: 'ok' }) };
  }
  if (pathname === '/api/version') {
    return {
      status: 200,
      body: JSON.stringify({
        version: APP_VERSION,
        env: NODE_ENV,
        isProduction: IS_PROD,
        commit: GIT_SHA ? GIT_SHA.slice(0, 7) : null,
      }),
    };
  }
  if (pathname === '/api/baseurl') {
    const baseUrl = process.env.BASE_URL || `http://${getLocalIP()}:${PORT}`;
    return { status: 200, body: JSON.stringify({ baseUrl }) };
  }
  if (pathname === '/api/qr') {
    const text = searchParams.get('text');
    if (!text || text.length > 2048) {
      return { status: 400, body: JSON.stringify({ error: !text ? 'Missing text' : 'Too long' }) };
    }
    return generateQRMatrix(text)
      .then((qr) => ({ status: 200, body: JSON.stringify(qr) }))
      .catch(() => ({ status: 500, body: JSON.stringify({ error: 'QR generation failed' }) }));
  }
  return null;
}

// ---- Dev: Node HTTP server + Vite middleware mode ----

async function startDev(): Promise<void> {
  const { createServer: createViteServer } = await import('vite');
  const { createServer: createHttpServer } = await import('node:http');

  const httpServer = createHttpServer();

  const vite = await createViteServer({
    configFile: resolve(ROOT, 'vite.config.ts'),
    server: {
      middlewareMode: true,
      hmr: { server: httpServer },
    },
    appType: 'custom',
  });

  httpServer.on('request', async (req, res) => {
    try {
      const url = new URL(req.url!, `http://localhost:${PORT}`);

      // API routes.
      const api = await handleApi(url.pathname, url.searchParams);
      if (api) {
        res.writeHead(api.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(api.body);
        return;
      }

      // Page routes: / → display, /ROOM → controller.
      if (url.pathname === '/' || ROOM_CODE_RE.test(url.pathname)) {
        const entry = url.pathname === '/' ? 'display' : 'controller';
        const htmlPath = resolve(ROOT, `src/${entry}/index.html`);
        let html = readFileSync(htmlPath, 'utf-8');
        html = await vite.transformIndexHtml(`/${entry}/index.html`, html, req.url);
        html = html.replace('<head>', `<head>\n    <base href="/${entry}/">`);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': CSP,
        });
        res.end(html);
        return;
      }

      // Everything else → Vite (JS, CSS, assets, module transforms, HMR).
      vite.middlewares(req, res);
    } catch (err) {
      vite.ssrFixStacktrace(err as Error);
      console.error('[racer]', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    }
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('[racer] dev server running');
    console.log(`  Local:   http://localhost:${PORT}/`);
    console.log(`  Network: http://${ip}:${PORT}/`);
  });
}

// ---- Production: Bun.serve + static dist/ ----

function serveStatic(pathname: string): Response {
  const safePath = normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  let filePath = join(DIST_DIR, safePath);
  if (!filePath.startsWith(DIST_DIR)) return new Response('Forbidden', { status: 403 });

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }
  if (!existsSync(filePath)) return new Response('Not Found', { status: 404 });

  const ext = extname(filePath).toLowerCase();
  const data = readFileSync(filePath);
  const headers = new Headers({ 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  if (ext === '.html') headers.set('Content-Security-Policy', CSP);
  if (ext === '.html' || ext === '.js' || ext === '.css') {
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  return new Response(new Uint8Array(data), { headers });
}

function startProd(): void {
  const server = Bun.serve({
    port: PORT,
    idleTimeout: 60,
    async fetch(req) {
      try {
        const url = new URL(req.url);

        // API routes.
        const api = await handleApi(url.pathname, url.searchParams);
        if (api) {
          return new Response(api.body, {
            status: api.status,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          });
        }

        // Page routes: / → display, /ROOM → controller.
        let pathname = url.pathname;
        if (pathname === '/') {
          pathname = '/display/index.html';
        } else if (ROOM_CODE_RE.test(pathname)) {
          pathname = '/controller/index.html';
        }

        return serveStatic(pathname);
      } catch (err) {
        console.error('[racer]', err);
        return new Response('Internal Server Error', { status: 500 });
      }
    },
  });

  const ip = getLocalIP();
  console.log(`[racer] production server running`);
  console.log(`  Local:   http://localhost:${server.port}/`);
  console.log(`  Network: http://${ip}:${server.port}/`);
}

// ---- Entrypoint ----

if (IS_PROD) {
  startProd();
} else {
  await startDev();
}
