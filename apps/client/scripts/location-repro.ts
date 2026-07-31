// Regression check for the location/map node: the projection math frames a
// journey sensibly, the locationMap node mounts and renders its from→to card,
// and the doc helpers surface its place names (previews/search) and its two
// media ids (deletion/cleanup). The static-map compositor itself fetches OSM
// tiles onto a canvas and is verified manually — jsdom has neither.
// Run: pnpm --filter client exec tsx scripts/location-repro.ts
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// Node 22 defines `navigator` as a getter-only global, so a plain assignment
// throws. defineProperty replaces it outright — jsdom's navigator is what the
// editor stack probes for platform detection.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
g.MutationObserver = dom.window.MutationObserver;
g.Element = dom.window.Element;
g.HTMLElement = dom.window.HTMLElement;
g.Node = dom.window.Node;
g.Document = dom.window.Document;
g.DOMParser = dom.window.DOMParser;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.CustomEvent = dom.window.CustomEvent;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.ShadowRoot = dom.window.ShadowRoot;
g.ResizeObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} };
g.IntersectionObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} };
(dom.window.Document.prototype as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function main(): Promise<void> {
  const { Editor } = await import('@tiptap/core');
  const { buildExtensions, docToText, docMediaIds } = await import('../src/editor/doc');
  const { locationNode } = await import('../src/editor/location');
  const { haversineKm, fitView } = await import('../src/location/mercator');
  type MediaAttachment = import('../src/sync/engine').MediaAttachment;

  const berlin = { lat: 52.52, lng: 13.405, label: 'Berlin' };
  const munich = { lat: 48.137, lng: 11.575, label: 'Munich' };

  // ── projection math ──
  const km = haversineKm(berlin, munich);
  assert(km > 480 && km < 520, `Berlin→Munich distance ≈ 504 km (got ${km.toFixed(0)})`);
  const { zoom } = fitView([berlin, munich], { w: 600, h: 340 });
  assert(zoom >= 5 && zoom <= 8, `journey zooms out to frame both cities (got z${zoom})`);
  const single = fitView([berlin], { w: 600, h: 340 });
  assert(single.zoom === 13, 'a single point uses the default zoom');
  console.log(`ok: projection — ${km.toFixed(0)} km, journey z${zoom}, single z${single.zoom}`);

  // ── node mounts + renders the from→to card ──
  const removed: string[] = [];
  const mapAtt: MediaAttachment = { id: 'map-media-id', kind: 'image', mime: 'image/jpeg', bytes: 1234, width: 600, height: 340, createdAt: 1 };
  const photoAtt: MediaAttachment = { id: 'photo-media-id', kind: 'image', mime: 'image/jpeg', bytes: 5678, width: 800, height: 600, createdAt: 2 };

  const editor = new Editor({
    element: document.getElementById('mount') as HTMLElement,
    extensions: [
      ...buildExtensions('placeholder'),
      locationNode({ resolve: async () => null, onRemoved: (a) => removed.push(a.id) }),
    ],
    content: {
      type: 'doc',
      content: [
        { type: 'locationMap', attrs: { from: berlin, to: munich, zoom, map: mapAtt, photo: photoAtt } },
        { type: 'paragraph' },
      ],
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  const card = document.querySelector('.mneme-location-node');
  assert(card, 'locationMap node view renders');
  assert(card.textContent?.includes('Berlin') && card.textContent?.includes('Munich'), 'card shows the from→to labels');
  console.log('ok: locationMap node mounts and renders the journey card');

  // ── doc helpers ──
  const json = editor.getJSON();
  const text = docToText(json);
  assert(text.includes('📍 Berlin → Munich'), `docToText surfaces the place names (got "${text}")`);
  const ids = docMediaIds(json);
  assert(ids.includes('map-media-id') && ids.includes('photo-media-id'), 'docMediaIds returns the snapshot + photo ids');
  console.log(`ok: docToText + docMediaIds (${ids.length} media ids)`);

  // ── single-pin variant (no destination, no photo) ──
  editor.commands.setContent({
    type: 'doc',
    content: [{ type: 'locationMap', attrs: { from: berlin, to: null, zoom: 13, map: mapAtt, photo: null } }],
  });
  await new Promise((r) => setTimeout(r, 0));
  const solo = docToText(editor.getJSON());
  assert(solo.includes('📍 Berlin') && !solo.includes('→'), 'a single pin surfaces just its label');
  assert(docMediaIds(editor.getJSON()).length === 1, 'a photo-less location counts only the map snapshot');
  console.log('ok: single-pin location (no destination, no photo)');

  editor.destroy();
  console.log('\nall location checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
