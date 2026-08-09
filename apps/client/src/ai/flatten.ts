// Shared flattening for the AI surfaces: one ISO-date helper and one
// entry→text projection. ai/context.ts (Ask my journal) and ai/interview.ts
// (history for guided interviews) both embed entries as
// "### <title>\nDate: <iso>\n\n<text>" — the format the prompts describe —
// and a third copy of the date pad lived in prompts.ts. Keeping the format in
// one place stops the copies from drifting apart.
import type { JournalEntry } from '../sync/engine';
import { docToText, parseBody } from '../editor/doc';

export function isoDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The entry's readable text (rich body flattened; falls back to bodyText), capped. */
export function entryText(e: JournalEntry, cap: number, truncationMark: string): string {
  let text: string;
  try {
    text = docToText(parseBody(e.bodyJson, e.bodyText)).trim();
  } catch {
    text = e.bodyText;
  }
  if (text.length > cap) text = `${text.slice(0, cap)}\n${truncationMark}`;
  return text;
}

/** The "### Title\nDate: …" heading both embed formats share. */
export function entryHeading(e: JournalEntry): string {
  return `### ${e.title || 'Untitled'}\nDate: ${isoDate(e.createdAt)}`;
}
