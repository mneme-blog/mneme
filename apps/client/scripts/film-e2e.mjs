// End-to-end check of the film encoder in a real browser.
//
// jsdom has no WebCodecs, no OffscreenCanvas and no workers, so the parts of
// this feature that actually matter — decoding mismatched clips and keeping
// picture and sound together across the seams — cannot be checked by the tsx
// repro script. This builds filmtest/ with Vite, serves it, and drives
// headless Chrome at it. The test synthesizes its inputs with mediabunny, so it
// needs no camera and is not realtime.
//
// Run: node scripts/film-e2e.mjs        (needs google-chrome or chromium)
import { build } from 'vite';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'filmtest-dist');

const BROWSERS = ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };

await build({
  root: join(root, 'filmtest'),
  plugins: [preact()],
  logLevel: 'warn',
  build: { outDir, emptyOutDir: true, target: 'esnext' },
});

// URL path → absolute file, for everything Vite just emitted. Built once, from
// the directory listing rather than from any request.
const assets = new Map(
  (await readdir(outDir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => {
      const abs = join(e.parentPath, e.name);
      return [`/${abs.slice(outDir.length + 1).split(sep).join('/')}`, abs];
    }),
);

const result = await new Promise((resolve, reject) => {
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/result') {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.writeHead(204).end();
      server.close();
      resolve(JSON.parse(body));
      return;
    }
    // Serve only from an allowlist built by walking the output directory, so a
    // request path is never used to construct a filesystem path — it can only
    // select an already-known build artifact, or nothing. Only this machine can
    // reach the server, but "it's local" is not a reason to hand a request
    // string to the filesystem.
    const requested = decodeURIComponent(req.url.split('?')[0]);
    const file = assets.get(requested === '/' ? '/index.html' : requested);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    try {
      const data = await readFile(file);
      // Same headers the app ships; notably NO COOP/COEP, so this also proves
      // the encoder needs no cross-origin isolation.
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const bin = BROWSERS.find((b) => {
      try {
        return spawn(b, ['--version']).pid;
      } catch {
        return false;
      }
    });
    if (!bin) {
      server.close();
      reject(new Error(`no browser found (tried ${BROWSERS.join(', ')})`));
      return;
    }
    console.log(`serving ${url} → ${bin} (headless)`);
    const child = spawn(
      bin,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--autoplay-policy=no-user-gesture-required',
        `--user-data-dir=${join(outDir, 'profile')}`,
        url,
      ],
      { stdio: 'ignore' },
    );
    const timer = setTimeout(() => {
      child.kill();
      server.close();
      reject(new Error('timed out after 180s'));
    }, 180_000);
    server.on('close', () => {
      clearTimeout(timer);
      child.kill();
    });
  });
});

console.log(result.log.join('\n'));
process.exit(result.failures === 0 ? 0 : 1);
