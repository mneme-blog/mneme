// The vault-search matcher, extracted from ui/Search.tsx so the AI context
// builder can rank entries the same way the search palette does. Everything
// runs client-side over the decrypted in-memory entries — the relay only ever
// holds ciphertext, so there is nothing to query remotely. A query matches on
// title, body content, label names, and the entry date (written out in several
// common formats, so "jun 9", "2026-06-09" or "9.6.2026" all hit).
import type { JournalEntry } from '../sync/engine';
import { monthName } from '../i18n';

// English stays in the haystack unconditionally (ISO-adjacent habits die
// hard); the ACTIVE locale's month names are appended below so a German user
// typing "9. Juni" finds the entry a fully-translated UI told them exists.
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MAX_RESULTS = 50;
const SNIPPET_RADIUS = 60;

export type HitField = 'title' | 'label' | 'date' | 'content';

export interface Hit {
  entry: JournalEntry;
  field: HitField; // the strongest field that matched (for the row's tag)
  snippet?: string; // body context, when the content matched
}

export function normalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Human + machine spellings of the entry date, lowercased, for substring matching. */
function dateHaystack(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const mon = MONTHS[m];
  const spellings = new Set([
    `${mon} ${day} ${y}`, // june 9 2026 (covers "jun 9" via the prefix)
    `${day} ${mon} ${y}`, // 9 june 2026
    `${mon.slice(0, 3)} ${day} ${y}`, // jun 9 2026
    `${day} ${mon.slice(0, 3)} ${y}`, // 9 jun 2026
    `${y}-${pad(m + 1)}-${pad(day)}`, // 2026-06-09
    `${pad(day)}.${pad(m + 1)}.${y}`, // 09.06.2026
    `${day}.${m + 1}.${y}`, // 9.6.2026
    `${pad(m + 1)}/${pad(day)}/${y}`, // 06/09/2026
  ]);
  // The active locale's month names (a Set: under English these duplicate the
  // rows above and collapse away).
  for (const name of [monthName(m), monthName(m, 'short')]) {
    const lower = name.toLowerCase();
    spellings.add(`${lower} ${day} ${y}`);
    spellings.add(`${day} ${lower} ${y}`);
    spellings.add(`${day}. ${lower} ${y}`); // 9. juni 2026 (de-style ordinal)
  }
  return [...spellings].join(' · ');
}

/** Body context around the first occurrence of any token. */
function makeSnippet(bodyText: string, tokens: string[]): string | undefined {
  const lower = bodyText.toLowerCase();
  let at = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return undefined;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(bodyText.length, at + SNIPPET_RADIUS * 2);
  return (start > 0 ? '…' : '') + bodyText.slice(start, end).replace(/\s+/g, ' ').trim() + (end < bodyText.length ? '…' : '');
}

export function search(entries: JournalEntry[], query: string): Hit[] {
  const q = normalize(query);
  const tokens = q.split(' ').filter(Boolean);
  if (tokens.length === 0) return [];

  const hits: Hit[] = [];
  for (const e of entries) {
    if (e.deleted) continue;
    const fields: Record<HitField, string> = {
      title: e.title.toLowerCase(),
      label: e.labels.join(' · ').toLowerCase(),
      date: dateHaystack(e.createdAt),
      content: e.bodyText.toLowerCase(),
    };
    const everything = `${fields.title} · ${fields.label} · ${fields.date} · ${fields.content}`;
    // Every token has to land somewhere on the entry (fields may differ).
    if (!tokens.every((t) => everything.includes(t))) continue;

    // Tag the hit with the strongest field: full-query match first, then any token.
    const order: HitField[] = ['title', 'label', 'date', 'content'];
    const field =
      order.find((f) => fields[f].includes(q)) ??
      order.find((f) => tokens.some((t) => fields[f].includes(t))) ??
      'content';
    hits.push({ entry: e, field, snippet: makeSnippet(e.bodyText, tokens) });
  }

  const rank: Record<HitField, number> = { title: 0, label: 1, date: 2, content: 3 };
  return hits
    .sort((a, b) => rank[a.field] - rank[b.field] || b.entry.updatedAt - a.entry.updatedAt)
    .slice(0, MAX_RESULTS);
}
