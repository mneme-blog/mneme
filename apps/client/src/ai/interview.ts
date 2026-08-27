// History for the guided interview: the entries this vault has already produced
// from one interview type, so the question phase can refer back and the run feels
// continuous week to week. Selection is purely over the decrypted in-memory
// entries (matched by the type-name label that GuidedInterview applies on save);
// nothing here touches the network.
import type { JournalEntry } from '../sync/engine';
import { entryHeading, entryText } from './flatten';

// Past entries are only context for question-asking, so cap each one tightly and
// keep the whole block small — the model needs gist, not full re-reading.
const HISTORY_ENTRY_CAP = 1_500;
export const HISTORY_BUDGET_CHARS = 6_000;

export interface InterviewHistory {
  text: string;
  count: number;
  /** Ids of the entries in the block — the retrospect builder excludes them so
   *  the same entry isn't shown twice in one prompt (ai/reflection.ts). */
  ids: string[];
}

/**
 * Flatten the most recent same-type entries (newest first) into a budgeted block.
 * `label` is the interview type's name, which GuidedInterview stores as an entry
 * label on save — that label is how past runs of the same type are found.
 */
export function buildInterviewHistory(entries: JournalEntry[], label: string, budgetChars = HISTORY_BUDGET_CHARS): InterviewHistory {
  const past = entries
    .filter((e) => !e.deleted && e.labels.includes(label))
    .sort((a, b) => b.createdAt - a.createdAt);

  const blocks: string[] = [];
  const ids: string[] = [];
  let used = 0;
  for (const e of past) {
    const text = entryText(e, HISTORY_ENTRY_CAP, '[…]');
    const block = `${entryHeading(e)}\n\n${text}`;
    if (used + block.length > budgetChars) break;
    blocks.push(block);
    ids.push(e.id);
    used += block.length;
  }
  return { text: blocks.join('\n---\n\n'), count: blocks.length, ids };
}
