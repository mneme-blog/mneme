// Integration smoke for the WYSIWYG ⇄ markdown source toggle, driven through a
// REAL TipTap editor (the full extension set, schema defaults and all) — the part
// the pure markdown-roundtrip.ts can't see. It mirrors what screens/Editor.tsx
// does on toggle: serialize editor.getJSON() → markdown, parse it back, and feed
// the result through editor.commands.setContent — asserting the command is
// accepted by the schema and the custom atoms (media, entry link, math) survive.
// Run: pnpm --filter client exec tsx scripts/markdown-editor-smoke.ts
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
  const { buildExtensions } = await import('../src/editor/doc');
  const { mediaAttachmentNode, mediaGalleryNode } = await import('../src/editor/media');
  const { docToMarkdown, markdownToDoc } = await import('../src/editor/markdown');
  type JSONContent = import('@tiptap/core').JSONContent;

  const noopMedia = {
    resolve: async () => null,
    onRemoved: () => undefined,
    onOpenImage: () => undefined,
  };

  const editor = new Editor({
    element: document.getElementById('mount') as HTMLElement,
    extensions: [
      ...buildExtensions('placeholder', undefined, { resolveTitle: () => 'Linked', onOpen: () => undefined }),
      mediaAttachmentNode(noopMedia),
      mediaGalleryNode(noopMedia),
    ],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });

  // A document exercising standard nodes + every custom atom, set through the
  // real schema so node defaults (table cell colspan, taskItem checked, …) apply.
  const source: JSONContent = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Daily log' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'A ' },
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' idea with math ' },
          { type: 'inlineMath', attrs: { latex: 'e^{i\\pi}' } },
          { type: 'text', text: ' and a ' },
          { type: 'entryLink', attrs: { entryId: 'abc-123', label: 'Linked' } },
          { type: 'text', text: '.' },
        ],
      },
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }] },
        ],
      },
      {
        type: 'mediaAttachment',
        attrs: { id: 'media-xyz', kind: 'image', mime: 'image/png', bytes: 10, name: 'a.png', width: 4, height: 4, createdAt: 1, durationMs: null },
      },
    ],
  };

  editor.commands.setContent(source);
  const original = editor.getJSON();

  // 1) doc → markdown
  const md = docToMarkdown(original);
  assert(md.includes('# Daily log'), 'heading serializes');
  assert(md.includes('$e^{i\\pi}$'), 'inline math serializes to a $…$ token');
  assert(md.includes('[[abc-123|Linked]]'), 'entry link serializes to [[id|label]]');
  assert(md.includes('media-xyz'), 'media attachment id is preserved in the fence');
  assert(md.includes('- [x] done'), 'checked task item serializes');

  // 2) markdown → doc, fed back through the real schema (must not throw)
  const parsed = markdownToDoc(md);
  editor.commands.setContent(parsed, { emitUpdate: false });
  const after = editor.getJSON();
  const flat = JSON.stringify(after);

  assert(flat.includes('"entryId":"abc-123"'), 'entry link survives the round-trip through the editor');
  assert(flat.includes('"latex":"e^{i\\\\pi}"'), 'inline math latex survives');
  assert(flat.includes('"id":"media-xyz"'), 'media attachment survives with its id');

  const media = (after.content ?? []).find((n) => n.type === 'mediaAttachment');
  assert(media?.attrs?.kind === 'image' && media.attrs?.name === 'a.png', 'media attachment keeps its full attrs (lossless fence)');

  const task = (after.content ?? []).find((n) => n.type === 'taskList');
  const item = task?.content?.[0];
  assert(item?.attrs?.checked === true, 'task item stays checked');

  editor.destroy();
  console.log('✓ markdown toggle survives a real-editor round-trip (custom atoms intact, setContent accepted)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
