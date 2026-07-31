// Builds the journal excerpt block for "Ask my journal": rank entries the same
// way the search palette does, pad with recency, flatten to plaintext, and stay
// under a per-backend character budget (chars/4 ≈ tokens — rough, padded).
// Selection happens over the decrypted in-memory entries; nothing here talks
// to the network.
import type { JournalEntry } from '../sync/engine';
import { search } from '../search/core';
import { parseBody, docToText } from '../editor/doc';
import { fenced, newFenceToken } from './fence';

/** The fence kind used for journal excerpts (see ai/fence.ts). */
export const JOURNAL_FENCE_KIND = 'journal';

// Per-backend budgets: cloud models have a huge window, the budget mainly
// bounds per-question cost; local models commonly run an 8k context, so leave
// room for the question + answer.
export const CLOUD_BUDGET_CHARS = 60_000;
export const LOCAL_BUDGET_CHARS = 16_000;
const ENTRY_CAP_CHARS = 8_000;

export interface JournalContext {
  text: string;
  entryCount: number;
  /** True when entries (or entry tails) were dropped to fit the budget. */
  truncated: boolean;
  /**
   * Per-request token delimiting the excerpts. The system prompt names it when
   * declaring that fenced content is data, so entry text can't impersonate an
   * instruction — see ai/fence.ts.
   */
  fenceToken: string;
}

function isoDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function entryBlock(e: JournalEntry, token: string): string {
  let text: string;
  try {
    text = docToText(parseBody(e.bodyJson, e.bodyText)).trim();
  } catch {
    text = e.bodyText;
  }
  if (text.length > ENTRY_CAP_CHARS) {
    text = `${text.slice(0, ENTRY_CAP_CHARS)}\n[… entry truncated]`;
  }
  const labels = e.labels.length ? `\nLabels: ${e.labels.join(', ')}` : '';
  // Title and labels are user content too, so they go inside the fence with the
  // body rather than sitting outside it as trusted-looking prompt structure.
  return fenced(
    token,
    JOURNAL_FENCE_KIND,
    `### ${e.title || 'Untitled'}\nDate: ${isoDate(e.createdAt)}${labels}\n\n${text}`,
  );
}

/**
 * Select and flatten entries for the question. Ranked search hits first (the
 * date-spelling haystack makes "what did I write in June?" work), then the
 * most recent entries that still fit.
 */
export function buildJournalContext(
  entries: JournalEntry[],
  query: string,
  budgetChars: number,
  // Injectable so tests can pin it; production always gets a fresh random one.
  fenceToken: string = newFenceToken(),
): JournalContext {
  const live = entries.filter((e) => !e.deleted);
  const picked: JournalEntry[] = [];
  const seen = new Set<string>();
  for (const hit of search(live, query)) {
    picked.push(hit.entry);
    seen.add(hit.entry.id);
  }
  for (const e of [...live].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (!seen.has(e.id)) picked.push(e);
  }

  const blocks: string[] = [];
  let used = 0;
  let truncated = false;
  for (const e of picked) {
    const block = entryBlock(e, fenceToken);
    if (used + block.length > budgetChars) {
      truncated = true;
      // Keep trying smaller entries only if there's meaningful room left.
      if (budgetChars - used < 500) break;
      continue;
    }
    blocks.push(block);
    used += block.length;
  }
  return { text: blocks.join('\n\n'), entryCount: blocks.length, truncated, fenceToken };
}
