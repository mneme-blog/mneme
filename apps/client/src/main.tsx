import { render } from 'preact';
import type { VNode } from 'preact';
// Self-hosted UI fonts, bundled by Vite — no external CDN, so the app renders
// offline and under the Tauri custom-scheme origin (where a CDN <link> in the
// PWA index.html would be blocked). Variable fonts cover every weight the design
// uses. Newsreader must come from the `standard` files: they carry the opsz axis
// alongside wght (matching the old Google Fonts opsz@6..72 request), so the serif
// editor keeps optical sizing — `index.css` is the wght-only cut and would lose it.
import '@fontsource-variable/hanken-grotesk/index.css';
import '@fontsource-variable/newsreader/standard.css';
import '@fontsource-variable/newsreader/standard-italic.css';
import '@fontsource-variable/spline-sans-mono/index.css';
import './styles/tokens.css';
import { App } from './app';
import { AppDataProvider } from './state/data';
import { IOSNotice } from './ui/IOSNotice';
import { I18nProvider, initI18n, useI18n } from './i18n';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

// Subscribes to locale changes above the whole tree: switching language
// re-renders every screen, so plain t() calls in components stay fresh.
function Root(): VNode {
  useI18n();
  return (
    <>
      {/* iOS-only, dismissible storage-eviction notice — a fixed overlay above
          both the onboarding and the unlocked app; no-ops elsewhere. */}
      <IOSNotice />
      <AppDataProvider>
        <App />
      </AppDataProvider>
    </>
  );
}

// Restore the persisted language (and RTL direction) before first paint. A
// failed locale-chunk load must not leave a blank page — render anyway and
// fall back to the built-in English catalog.
void initI18n()
  .catch((e) => console.error('[i18n] init failed — rendering with the English fallback:', e))
  .then(() => {
    render(
      <I18nProvider>
        <Root />
      </I18nProvider>,
      root,
    );
  });
