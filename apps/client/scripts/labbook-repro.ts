// Regression check for the lab-notebook editor features: the full extension
// set must mount in one editor (the "[[" suggester coexisting with the "/"
// palette), "[[" must open the entry picker and insert a navigable entryLink
// node, code blocks must get lowlight highlight decorations, and the table
// commands must work. Run: pnpm --filter client exec tsx scripts/labbook-repro.ts
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
// jsdom has no layout: Placeholder's viewport tracking probes elementFromPoint.
(dom.window.Document.prototype as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function main(): Promise<void> {
  const { Editor } = await import('@tiptap/core');
  const { buildExtensions } = await import('../src/editor/doc');
  const { slashExtension, buildSlashCommands, createSlashHandle } = await import('../src/editor/slash');
  const { wikiLinkSuggestion, buildEntryLinkItems } = await import('../src/editor/wikilink');
  type JournalEntry = import('../src/sync/engine').JournalEntry;

  const other: JournalEntry = {
    id: 'target-entry',
    journalId: 'j',
    title: 'Experiment 12',
    bodyText: '',
    labels: [],
    createdAt: 1,
    updatedAt: 1,
  };

  const opened: string[] = [];
  const slashHandle = createSlashHandle();
  const wikiHandle = createSlashHandle();
  // A holder object (not two flow-narrowed `let`s): TypeScript pins a
  // `let x = null` to type null across straight-line code because closure
  // assignments aren't tracked — `picker.select?.()` stays callable.
  const picker: {
    items: import('../src/editor/slash').SlashCommand[];
    select: ((item: import('../src/editor/slash').SlashCommand) => void) | null;
  } = { items: [], select: null };
  wikiHandle.listener = {
    show: (s) => {
      picker.items = s.items;
      picker.select = s.select;
    },
    hide: () => {
      picker.items = [];
      picker.select = null;
    },
    keydown: () => false,
  };

  // The full real extension set — placeholder included — plus both suggesters,
  // exactly as useRichEditor assembles them. Creating this throws if the two
  // Suggestion plugins collide.
  const editor = new Editor({
    element: document.getElementById('mount') as HTMLElement,
    extensions: [
      ...buildExtensions('placeholder', undefined, {
        resolveTitle: (id) => (id === other.id ? other.title : null),
        onOpen: (id) => opened.push(id),
      }),
      slashExtension(slashHandle, buildSlashCommands()),
      wikiLinkSuggestion(wikiHandle, (q) => buildEntryLinkItems([other], 'current-entry', q)),
    ],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  console.log('ok: editor mounts with "/" and "[[" suggesters together');

  // ── "[[" opens the picker; picking inserts an entryLink node ──
  editor.chain().focus().insertContent('[[Exp').run();
  await new Promise((r) => setTimeout(r, 0));
  assert(picker.items.length === 1 && picker.items[0]?.title === 'Experiment 12', '"[[" query shows the matching entry');
  picker.select?.(picker.items[0] as import('../src/editor/slash').SlashCommand);
  const json: import('@tiptap/core').JSONContent = editor.getJSON();
  const para = json.content?.[0];
  const link = para?.content?.find((n) => n.type === 'entryLink');
  assert(link, 'picking inserts an entryLink node');
  assert(link.attrs?.entryId === 'target-entry' && link.attrs?.label === 'Experiment 12', 'entryLink carries id + label');
  assert(!JSON.stringify(json).includes('[['), 'the "[[query" trigger text is consumed');
  console.log('ok: "[[" picker inserts an entryLink node');

  // ── clicking the rendered link navigates ──
  const chip = document.querySelector('.mneme-wikilink');
  assert(chip, 'entryLink node view renders');
  assert(chip.textContent === 'Experiment 12', 'node view shows the live title');
  chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert(opened.length === 1 && opened[0] === 'target-entry', 'clicking the link fires onOpen with the entry id');
  console.log('ok: clicking an entry link navigates');

  // ── a dead link renders muted, no navigation ──
  editor.chain().focus().insertContent([{ type: 'entryLink', attrs: { entryId: 'gone', label: 'Deleted one' } }]).run();
  const dead = [...document.querySelectorAll('.mneme-wikilink')].find((el) => el.textContent === 'Deleted one');
  assert(dead && (dead as HTMLElement).dataset.missing !== undefined, 'missing target renders with data-missing');
  dead.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert(opened.length === 1, 'a dead link does not navigate');
  console.log('ok: dead links are inert');

  // ── code block gets lowlight decorations ──
  editor.commands.setContent({
    type: 'doc',
    content: [{ type: 'codeBlock', attrs: { language: 'python' }, content: [{ type: 'text', text: 'def f():\n    return 42' }] }],
  });
  await new Promise((r) => setTimeout(r, 0));
  const hljs = document.querySelectorAll('pre [class*="hljs-"]');
  assert(hljs.length > 0, 'code block renders hljs token spans');
  console.log(`ok: syntax highlighting renders (${hljs.length} token spans)`);

  // ── table insert + structure commands ──
  editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] });
  assert(editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run(), 'insertTable runs');
  assert(editor.isActive('table'), 'cursor lands inside the table');
  assert(editor.chain().focus().addRowAfter().run(), 'addRowAfter runs');
  assert(editor.chain().focus().addColumnAfter().run(), 'addColumnAfter runs');
  const table = (editor.getJSON() as import('@tiptap/core').JSONContent).content?.find((n) => n.type === 'table');
  assert(table?.content?.length === 3, 'table has 3 rows after addRowAfter');
  assert(table?.content?.[0]?.content?.length === 3, 'rows have 3 cells after addColumnAfter');
  assert(table?.content?.[0]?.content?.[0]?.type === 'tableHeader', 'first row is a header row');
  console.log('ok: tables insert and grow');

  editor.destroy();
  console.log('\nall lab-notebook editor checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
