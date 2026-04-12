// Bun HTTP server for Racer.
//
// In dev (NODE_ENV !== 'production'), spawns Vite as a child process and
// proxies non-API requests to it for HMR. In production, serves the static
// build from `dist/`.
//
// Routes:
//   GET /health           → { status: 'ok' }
//   GET /api/version      → { version, env, commit? }
//   GET /api/qr?text=…    → { size, modules } via `qrcode`
//   GET /api/baseurl      → { baseUrl } using LAN IP discovery
//   GET /                 → display index
//   GET /<ROOM>           → controller index (single 4-letter segment)
//   GET /*                → static (or proxied to Vite in dev)

import { spawn, type ChildProcess } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, normalize, resolve } from 'node:path';
import QRCode from 'qrcode';

const PORT = parseInt(process.env.PORT || '4000', 10);
const VITE_PORT = parseInt(process.env.VITE_PORT || '5173', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const GIT_SHA = (process.env.GIT_SHA || '').trim();

const ROOT = resolve(import.meta.dir, '..');
const DIST_DIR = join(ROOT, 'dist');

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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
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

// In dev: spawn Vite and proxy to it.
let viteProcess: ChildProcess | null = null;
async function ensureVite(): Promise<void> {
  if (IS_PROD || viteProcess) return;
  console.log(`[racer] starting Vite on :${VITE_PORT}`);
  viteProcess = spawn(
    'bunx',
    ['vite', '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env } },
  );
  viteProcess.on('exit', (code) => {
    console.error(`[racer] vite exited with code ${code}`);
    viteProcess = null;
  });
  // Wait for Vite to be reachable. Any HTTP response (even 404) means it's up.
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${VITE_PORT}/display/`, {
        signal: AbortSignal.timeout(800),
      });
      if (r.status > 0) return;
    } catch {
      // ignore — Vite isn't listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.warn('[racer] vite did not respond after 10s; requests will likely fail');
}

async function proxyToVite(req: Request, baseHref: string | null = null): Promise<Response> {
  const url = new URL(req.url);
  const target = `http://127.0.0.1:${VITE_PORT}${url.pathname}${url.search}`;
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      redirect: 'manual',
    });
    const headers = new Headers(upstream.headers);
    const isHtml = (headers.get('content-type') || '').includes('text/html');
    if (isHtml) {
      headers.set('Content-Security-Policy', CSP);
      // Inject <base href> so relative asset URLs (./style.css, ./main.ts) resolve
      // against the Vite mount point even though the browser URL is "/".
      if (baseHref) {
        let html = await upstream.text();
        html = html.replace(/<head>/i, `<head>\n    <base href="${baseHref}">`);
        headers.delete('content-length');
        return new Response(html, { status: upstream.status, headers });
      }
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    return new Response(`Vite proxy error: ${(err as Error).message}`, { status: 502 });
  }
}

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

// Party-Sockets room codes are 4 chars: uppercase letters + digits.
const ROOM_CODE_RE = /^\/[A-Z0-9]{4}$/;

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname = url.pathname;

  // --- API routes ---
  if (pathname === '/health') {
    return jsonResponse({ status: 'ok' });
  }
  if (pathname === '/api/version') {
    return jsonResponse({
      version: APP_VERSION,
      env: NODE_ENV,
      isProduction: IS_PROD,
      commit: GIT_SHA ? GIT_SHA.slice(0, 7) : null,
    });
  }
  if (pathname === '/api/baseurl') {
    const baseUrl = process.env.BASE_URL || `http://${getLocalIP()}:${PORT}`;
    return jsonResponse({ baseUrl });
  }
  if (pathname === '/api/qr') {
    const text = url.searchParams.get('text');
    if (!text || text.length > 2048) {
      return jsonResponse({ error: !text ? 'Missing text' : 'Too long' }, 400);
    }
    try {
      return jsonResponse(await generateQRMatrix(text));
    } catch {
      return jsonResponse({ error: 'QR generation failed' }, 500);
    }
  }

  // --- Path rewriting ---
  // Display = root, controller = single uppercase 4-letter room code.
  // We rewrite the *upstream* path but keep the user-visible URL unchanged.
  // In dev we inject a <base href> so the HTML's relative asset URLs still
  // resolve against Vite's mount point.
  let upstreamPath = pathname;
  let baseHref: string | null = null;
  if (pathname === '/') {
    upstreamPath = '/display/index.html';
    baseHref = '/display/';
  } else if (ROOM_CODE_RE.test(pathname)) {
    upstreamPath = '/controller/index.html';
    baseHref = '/controller/';
  }

  // --- Serve ---
  if (IS_PROD) {
    // Production HTML uses absolute /assets/* paths from Vite build, so no
    // base href injection is needed.
    return serveStatic(upstreamPath);
  }
  // Dev: proxy to Vite, with optional base href injection for HTML.
  const proxyReq = new Request(`http://127.0.0.1:${VITE_PORT}${upstreamPath}${url.search}`, req);
  return proxyToVite(proxyReq, baseHref);
}

if (!IS_PROD) {
  await ensureVite();
}

const server = Bun.serve({
  port: PORT,
  // Long-poll friendly: handlers may take a while when proxying through Vite.
  idleTimeout: 60,
  async fetch(req) {
    try {
      return await handle(req);
    } catch (err) {
      console.error('[racer] handler error:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
});

const localIP = getLocalIP();
console.log(`[racer] running on http://localhost:${server.port}`);
console.log(`[racer] LAN: http://${localIP}:${server.port}`);
console.log(`[racer] display: http://localhost:${server.port}/`);
console.log(`[racer] controller: http://localhost:${server.port}/<ROOM>`);

process.on('SIGINT', () => {
  if (viteProcess) viteProcess.kill('SIGINT');
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (viteProcess) viteProcess.kill('SIGTERM');
  process.exit(0);
});
