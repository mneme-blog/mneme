import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import pkg from './package.json';
import { policy as cspPolicy } from './csp.js'; // plain JS; typed via csp.d.ts

// Git-derived build identifier appended to the semver, e.g. "0.0.0+5c2fdd8"
// ("-dirty" suffix on uncommitted trees). Falls back to the bare semver when
// git isn't available (tarball builds, containers without .git).
function appVersion(): string {
  try {
    const git = execSync('git describe --always --dirty', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return git ? `${pkg.version}+${git}` : pkg.version;
  } catch {
    return pkg.version;
  }
}

// --- Dev HTTPS (for installing the PWA on a phone) ---------------------------
// A service worker + PWA install are gated behind a *secure context*: only HTTPS
// or `localhost` qualify, so a LAN URL like http://192.168.x.x:5173 is never
// installable on a phone. Two opt-in ways to serve dev over HTTPS:
//   • DEV_TLS_CERT + DEV_TLS_KEY point at a cert (e.g. from `mkcert`) — a
//     locally-*trusted* cert is the only thing a phone's Chrome will register a
//     service worker under (a self-signed cert error blocks the SW → no install).
//   • DEV_HTTPS=1 alone falls back to @vitejs/plugin-basic-ssl (self-signed) —
//     fine for localhost verification on the dev machine, not for a phone.
// See docs/PWA.md for the full phone-testing recipe.
const tlsCert = process.env.DEV_TLS_CERT;
const tlsKey = process.env.DEV_TLS_KEY;
const hasCustomCert = Boolean(tlsCert && tlsKey);
const httpsRequested = process.env.DEV_HTTPS === '1' || hasCustomCert;
const useBasicSsl = httpsRequested && !hasCustomCert;

// The service worker is disabled in ordinary `pnpm dev` (http://localhost) so
// day-to-day development stays free of SW asset caching; it turns on only in the
// HTTPS "test the install" mode, where the whole point is to exercise the PWA.
const pwaDevEnabled = httpsRequested;

// --- Content-Security-Policy -------------------------------------------------
// Injected as a <meta http-equiv> into the PRODUCTION build only. The dev server
// serves inline scripts for HMR, which a `script-src 'self'` policy would kill,
// and the point of the policy is to protect the shipped artifact. The hosting
// layer should send the same policy as a response header (see deploy/web/
// Caddyfile) — the meta tag is the fallback for hosts that don't.
//
// CSP_CONNECT_EXTRA (build-time, space- or comma-separated) adds connect-src
// origins: needed when the relay is not same-origin, or for a non-loopback
// Ollama. The default Caddy deploy proxies the relay under the app's own origin,
// where 'self' already covers it.
const connectExtra = (process.env.CSP_CONNECT_EXTRA ?? '')
  .split(/[\s,]+/)
  .filter(Boolean);

// The relay the build points at, when it isn't same-origin. Without this a
// split-host deploy (client on one origin, relay on another) would build a
// policy that blocks its own sync with nothing but a console error to show for
// it. A relay the *user* later re-points at a third origin still needs
// CSP_CONNECT_EXTRA — that is the intended friction.
const relayOrigin = (() => {
  const url = process.env.VITE_RELAY_URL;
  if (!url) return [];
  try {
    return [new URL(url).origin];
  } catch {
    return [];
  }
})();

function cspMetaPlugin() {
  const content = cspPolicy({ connectExtra: [...relayOrigin, ...connectExtra] }) as string;
  return {
    name: 'mneme-csp-meta',
    apply: 'build' as const,
    transformIndexHtml: {
      order: 'post' as const,
      handler: (html: string) =>
        html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${content}" />`,
        ),
    },
  };
}

// The single web codebase for the PWA and (later) the Tauri shells.
export default defineConfig({
  plugins: [
    preact(),
    // Generates a Workbox service worker that precaches the app shell (JS/CSS/
    // HTML/wasm/fonts/icons) and injects its registration. This — together with
    // the hand-written public/manifest.webmanifest — is what makes the app
    // installable as a PWA and available offline. `manifest: false` keeps our
    // existing manifest as the source of truth (the plugin only owns the SW).
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,wasm}'],
        // wa-sqlite's wasm + the bundled variable fonts exceed the 2 MiB default.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // SPA: serve the cached shell for client-routed navigations offline.
        // RELATIVE on purpose: precache keys resolve against the service
        // worker's own URL, so under a sub-path deploy (the Caddy image builds
        // with --base=/mneme/) the shell is cached as /mneme/index.html. A
        // leading-slash fallback then points at a URL that was never precached
        // and every navigation throws `non-precached-url` instead of being
        // served offline.
        navigateFallback: 'index.html',
      },
      devOptions: {
        enabled: pwaDevEnabled,
        type: 'module',
        navigateFallback: 'index.html',
      },
    }),
    ...(useBasicSsl ? [basicSsl()] : []),
    cspMetaPlugin(),
  ],
  // Build provenance, surfaced in src/buildinfo.ts (onboarding footer +
  // Preferences → Info). In dev the timestamp is the dev-server start.
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 5173,
    https: hasCustomCert
      ? { cert: readFileSync(tlsCert!), key: readFileSync(tlsKey!) }
      : undefined,
    // Mirror the production Caddy route: the client's default transcription
    // URL is the same-origin path /whisper (see ai/transcribe.ts), which Caddy
    // proxies to the bundled whisper container. Proxy it in dev too so the
    // default works against `docker compose up whisper` with zero config.
    proxy: {
      '/whisper': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/whisper/, ''),
      },
    },
  },
  // esbuild ≥0.28 refuses to *lower* destructuring when it's entangled with
  // private-field lowering (the wa-sqlite OPFS worker does both), erroring out
  // for the default broad target. Destructuring is natively supported by every
  // target we ship to (ES2015+; chrome87/es2020/firefox78/safari14 all have it),
  // so mark it supported — esbuild then leaves it as-is instead of lowering, and
  // the build stops trying an unsupported transform. No browser-support change.
  esbuild: {
    supported: { destructuring: true },
  },
  build: {
    // Vite inlines assets under 4 kB as data: URIs. For fonts that collides
    // with the CSP: `font-src 'self'` blocks a data: font outright, so the
    // small subsets (some Hanken Grotesk unicode ranges, most KaTeX faces)
    // silently fell back to system fonts in the production build. Keep them as
    // files — they are also the assets the service worker precaches and Caddy
    // serves immutable, which inlining defeats.
    assetsInlineLimit: (filePath: string) =>
      /\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
  },
});
