// Regression check: clicking a rendered math node must fire the MathHandle
// listener with the node's kind/latex/pos (the click→edit-dialog wire path).
// Run: pnpm --filter client exec tsx scripts/math-click-repro.ts
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

async function main(): Promise<void> {
  const { Editor } = await import('@tiptap/core');
  const { default: StarterKit } = await import('@tiptap/starter-kit');
  const { createMathHandle, mathExtension } = await import('../src/editor/math');

  const handle = createMathHandle();
  let fired: unknown = null;
  handle.listener = (req) => {
    fired = req;
  };

  const editor = new Editor({
    element: document.getElementById('mount') as HTMLElement,
    // Placeholder needs more browser APIs than jsdom has; math doesn't need it.
    extensions: [StarterKit, mathExtension(handle)],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'before ' },
            { type: 'inlineMath', attrs: { latex: 'e^{i\\pi}+1=0' } },
            { type: 'text', text: ' after' },
          ],
        },
        { type: 'blockMath', attrs: { latex: '\\int_0^1 x\\,dx' } },
      ],
    },
  });

  const inline = document.querySelector('[data-type="inline-math"]');
  const block = document.querySelector('[data-type="block-math"]');
  console.log('inline node view present:', !!inline, '| classes:', inline?.className?.toString().slice(0, 80));
  console.log('block  node view present:', !!block);

  inline?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  console.log('after inline click → listener fired:', JSON.stringify(fired));

  fired = null;
  block?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  console.log('after block click  → listener fired:', JSON.stringify(fired));

  editor.destroy();
  process.exit(0);
}

void main();
