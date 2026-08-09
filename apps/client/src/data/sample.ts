// Sample content for the Mneme UI — mirrors the design handoff's data.jsx.
// This is placeholder content for UX validation only (§10 step 2); the real
// source of truth is the local wa-sqlite DB wired in a later step.

export interface Label {
  name: string;
  color: string;
}

export interface Journal {
  id: string;
  name: string;
  subtitle: string;
  count: number;
  color: string;
  cover: CoverPattern;
  last: string;
  // ── sync bookkeeping (filled by state/db; UI drafts may omit) ──
  /** Cleartext oplog id (random, never the journal id — §3 leak-guard). */
  recordId?: string;
  /** Local-only: an untouched sample seed — never pushed until first edit. */
  pristine?: boolean;
  createdAt?: number; // ms
  updatedAt?: number; // ms — also the lww_clock once synced
  deleted?: boolean;
}

export type CoverPattern = 'lines' | 'dots' | 'grid' | 'plain' | 'photo';

export interface Entry {
  id: string;
  journal: string;
  day: number;
  time: string;
  title: string;
  place: string;
  weather: string;
  mood: string;
  labels: string[];
  preview: string;
  words: number;
  media: number;
  /** Rich seed body; entries without one fall back to their preview text. */
  blocks?: Block[];
}

export type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'photo'; caption: string }
  | { type: 'check'; done: boolean; text: string }
  | { type: 'audio'; label: string; dur: string }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'math'; latex: string };

// Label palette — muted tones, similar L/C, varied hue.
export const LABELS: Record<string, Label> = {
  reflection: { name: 'reflection', color: '#B0563A' }, // clay
  morning:    { name: 'morning',    color: '#B08A2E' }, // ochre
  travel:     { name: 'travel',     color: '#4E8B85' }, // dusty teal
  health:     { name: 'health',     color: '#6E8B5E' }, // sage
  idea:       { name: 'idea',       color: '#5A7BA6' }, // dusty blue
  family:     { name: 'family',     color: '#8E6A93' }, // mauve
  dream:      { name: 'dream',      color: '#6A6AA0' }, // indigo
  tutorial:   { name: 'tutorial',   color: '#4E8B85' }, // dusty teal
};

const LABEL_COLORS = Object.values(LABELS).map((l) => l.color);

// Labels are free-form user text; ones outside the predefined palette get a
// stable color from the same muted set (hash of the name, so every device
// derives the same color without syncing it).
export function labelInfo(id: string): Label {
  const known = LABELS[id];
  if (known) return known;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return { name: id, color: LABEL_COLORS[h % LABEL_COLORS.length] };
}

// `count` and `last` here are placeholders: the live values are derived from real
// entries in state/data.tsx (journalsWithCounts) and override whatever is set here.
export const JOURNALS: Journal[] = [
  { id: 'j-tutorial', name: 'Tutorial',   subtitle: 'How Mneme works',     count: 0, color: '#4E8B85', cover: 'grid',  last: '' },
  { id: 'j-personal', name: 'My Journal', subtitle: 'Your first notebook', count: 0, color: '#B0563A', cover: 'lines', last: '' },
];

// The tutorial walkthrough — five entries covering the app, newest first.
export const ENTRIES: Entry[] = [
  {
    id: 'e1', journal: 'j-tutorial', day: 12, time: '9:00',
    title: 'Basics',
    place: '', weather: '', mood: '',
    labels: ['tutorial'],
    preview: 'Welcome to Mneme — a local-first, end-to-end encrypted journal. Start here.',
    words: 220, media: 0,
    blocks: [
      { type: 'p', text: 'Welcome to Mneme — a local-first, end-to-end encrypted journal. Everything you write is encrypted on this device before it leaves it; the sync server only ever stores opaque blobs it cannot read.' },
      { type: 'h', text: 'How things are organized' },
      { type: 'p', text: 'Journals are notebooks. This Tutorial journal walks you through the features; "My Journal" is yours to fill — and you can create more from the journals screen. Every entry belongs to a journal, carries its own date and time (click the date in the entry header to change it), and takes free-form labels for filtering.' },
      { type: 'h', text: 'First steps' },
      { type: 'check', done: false, text: 'Press ⌘/Ctrl+K and search for "math" — search covers every journal' },
      { type: 'check', done: false, text: 'Open the calendar to browse entries by day' },
      { type: 'check', done: false, text: 'Start a new entry — the "Start from" picker offers templates' },
      { type: 'check', done: false, text: 'Open Preferences for themes, writing stats, and vault settings' },
      { type: 'quote', text: 'Tip: type "/" anywhere in an entry to open the command palette — blocks, media, math, and templates all live there.' },
      { type: 'p', text: 'Done with the walkthrough? This Tutorial journal can be deleted at any time, and only exists on this device.' },
    ],
  },
  {
    id: 'e2', journal: 'j-tutorial', day: 11, time: '9:00',
    title: 'Info on Data Security',
    place: '', weather: '', mood: '',
    labels: ['tutorial'],
    preview: 'Your recovery phrase is your account. What is encrypted, what the server sees, and how to stay safe.',
    words: 240, media: 0,
    blocks: [
      { type: 'p', text: 'Your twelve-word recovery phrase is your account. Every encryption key derives from it — there is no email, no password, and no reset flow.' },
      { type: 'quote', text: 'If you lose the phrase, your data is unrecoverable — by design. Not even the server operator can read or restore it. Write the words down and keep them somewhere safe.' },
      { type: 'h', text: 'What encryption covers' },
      { type: 'p', text: 'Entry bodies — titles, text, formulas, embedded media — are encrypted on your device (XChaCha20-Poly1305) before they sync. The server relays and stores ciphertext only. It does see some metadata: how many records you have, their sizes, and when reminders fire. Content is protected; form is not.' },
      { type: 'h', text: 'On this device' },
      { type: 'p', text: 'By default the phrase is never stored — you re-enter it on a cold start. If you opt into "stay signed in", the key material is sealed under a passphrase you choose (Argon2id), the journal auto-locks after 15 minutes of inactivity, and you can lock it manually any time.' },
      { type: 'p', text: 'Worried the phrase leaked? Preferences → Vault → "Replace recovery phrase" re-encrypts everything under a fresh one. "Delete vault" removes your data from the server and this device.' },
    ],
  },
  {
    id: 'e3', journal: 'j-tutorial', day: 10, time: '9:00',
    title: 'Editing',
    place: '', weather: '', mood: '',
    labels: ['tutorial'],
    preview: 'Rich text, checklists, tables, code blocks, media, and links between entries.',
    words: 230, media: 0,
    blocks: [
      { type: 'p', text: 'Entries are rich text. Select text for formatting, or type "/" to open the slash palette — every block type lives there.' },
      { type: 'h', text: 'Blocks' },
      { type: 'check', done: true, text: 'Headings, lists, and quotes — the basics' },
      { type: 'check', done: true, text: 'Checklists, like this one' },
      { type: 'check', done: false, text: 'Tables — resizable, with row and column controls in the toolbar' },
      { type: 'code', lang: 'python', text: '# Code blocks highlight automatically\ndef hello(name):\n    return f"hello, {name}"' },
      { type: 'h', text: 'Media' },
      { type: 'p', text: 'Drop images or files straight into the text, or record video and audio from the slash menu. Images group into galleries and open in a lightbox. Media is encrypted in chunks, like everything else.' },
      { type: 'h', text: 'Links between entries' },
      { type: 'p', text: 'Type [[ to link to another entry; entries that are linked to list their backlinks under "Linked from". And if you find yourself writing the same structure repeatedly, save it as a template (Templates, in the sidebar).' },
    ],
  },
  {
    id: 'e4', journal: 'j-tutorial', day: 9, time: '9:00',
    title: 'Math Syntax',
    place: '', weather: '', mood: '',
    labels: ['tutorial'],
    preview: 'Typeset LaTeX inline with $$…$$ or as a block with $$$…$$$ — rendered with KaTeX.',
    words: 120, media: 0,
    blocks: [
      { type: 'p', text: 'Mneme typesets math with KaTeX. Wrap LaTeX in double dollar signs for inline math — typing $$E = mc^2$$ renders it in the line — or triple dollar signs ($$$…$$$) for a display block like this one:' },
      { type: 'math', latex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}' },
      { type: 'p', text: 'Click any rendered formula to edit it in a live-preview dialog. The "/" palette has Math commands too, and snippets for fractions, roots, sums, and integrals:' },
      { type: 'math', latex: '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}' },
      { type: 'p', text: 'Formulas live inside the encrypted entry body, and their LaTeX source shows up in previews and search.' },
    ],
  },
  {
    id: 'e5', journal: 'j-tutorial', day: 8, time: '9:00',
    title: 'Configuring AI',
    place: '', weather: '', mood: '',
    labels: ['tutorial'],
    preview: 'The optional assistant is off by default. Choose a cloud or fully local backend in Preferences.',
    words: 200, media: 0,
    blocks: [
      { type: 'p', text: 'Mneme ships with an optional AI assistant. It is off by default and entirely opt-in — nothing is sent anywhere until you configure it.' },
      { type: 'h', text: 'Turning it on' },
      { type: 'p', text: 'Open Preferences → Assistant and pick a backend. Anthropic: bring your own API key; requests go directly from your browser to the API — the entries used as context leave end-to-end encryption for that request. Ollama: runs fully on your machine; nothing leaves it.' },
      { type: 'h', text: 'What you get' },
      { type: 'p', text: '"Ask my journal" answers questions over your decrypted entries, and the "/" palette gains writing help for the current entry: Continue, Summarize, and Suggest title — each shows its result before anything is inserted.' },
      { type: 'quote', text: 'Your API key is encrypted at rest on this device, and journal plaintext is never proxied through the sync server.' },
    ],
  },
];

