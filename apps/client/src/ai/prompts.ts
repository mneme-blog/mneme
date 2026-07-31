// System prompts for the two AI surfaces. The chat prompt embeds journal
// excerpts (selected in context.ts); the editor prompts embed only the open
// entry. Both run client-side — what's assembled here goes browser → provider,
// never near the relay.
//
// Prompt text stays English; the locale-aware bits are the reply-language
// directive, which tells the model to answer (and write synthesized entries)
// in the app's UI language, and the localized finish-button label the interview
// prompt tells the model to point at. currentLocale()/t() are import-safe
// outside Vite (the tsx repro scripts) — they fall back to English there.
import { currentLocale, t } from '../i18n';
import { fenced, fenceRules, newFenceToken } from './fence';

// Journal text is untrusted input to the model: an entry can hold anything the
// user pasted, and a Day One import brings in whatever was in the archive. Every
// prompt below therefore fences that text and states, in terms of the concrete
// per-request markers, that fenced content is data and not instructions
// (ai/fence.ts). Containment, not a cure — the real backstop is that output is
// always user-reviewed before it is inserted or saved.
const ENTRY_FENCE = 'entry';

export type AiEditorAction = 'continue' | 'summarize' | 'title';

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `fenceToken` comes from the JournalContext whose text is being embedded. */
export function chatSystemPrompt(contextText: string, fenceToken: string): string {
  return [
    `You are the assistant inside a private, end-to-end-encrypted journal. Today's date is ${today()}.`,
    'Below are excerpts from the user\'s journal, most relevant first. Answer questions using only these excerpts.',
    'When the excerpts don\'t contain the answer, say so plainly — never invent journal content.',
    'Quote or reference entries by their title and date when it helps. Be warm but concise.',
    `Respond in ${currentLocale().english}.`,
    '',
    fenceRules(fenceToken, 'journal'),
    '',
    '## Journal excerpts',
    '',
    contextText || '(no matching entries)',
  ].join('\n');
}

export function editorSystemPrompt(
  action: AiEditorAction,
  title: string,
  bodyText: string,
  fenceToken: string = newFenceToken(),
): string {
  const entry =
    '## The entry\n\n' +
    fenced(fenceToken, ENTRY_FENCE, `Title: ${title || 'Untitled'}\n\n${bodyText || '(empty so far)'}`);
  const rules = fenceRules(fenceToken, ENTRY_FENCE);
  switch (action) {
    case 'continue':
      return [
        'You are a writing companion inside a private journal. Continue the user\'s entry below in their voice,',
        'tone, and language. Write 1–3 natural paragraphs that pick up exactly where the text ends.',
        'Output only the continuation — no preamble, no quotation marks, no commentary.',
        '',
        rules,
        '',
        entry,
      ].join('\n');
    case 'summarize':
      return [
        'You are a writing companion inside a private journal. Summarize the user\'s entry below in 2–4 sentences,',
        'in the same language the entry is written in, first person preserved.',
        'Output only the summary — no preamble, no commentary.',
        '',
        rules,
        '',
        entry,
      ].join('\n');
    case 'title':
      return [
        'You are a writing companion inside a private journal. Suggest 3 short titles (max 6 words each) for the',
        'entry below, in the same language the entry is written in.',
        'Output exactly 3 lines, one title per line — no numbering, no quotes, no commentary.',
        '',
        rules,
        '',
        entry,
      ].join('\n');
  }
}

export function editorUserMessage(action: AiEditorAction): string {
  switch (action) {
    case 'continue':
      return 'Continue the entry.';
    case 'summarize':
      return 'Summarize the entry.';
    case 'title':
      return 'Suggest 3 titles.';
  }
}

// ── guided interview (ui/GuidedInterview.tsx) ──
// Two phases share one chat: the question phase (interviewSystemPrompt drives the
// Q&A turns) and the synthesis phase (interviewSynthesisPrompt rewrites the whole
// transcript into one entry). Both run browser → provider, never near the relay.

/** Question phase: the per-type strategy + the generic one-question-at-a-time rules,
 *  with optional history of the same interview type so questions feel continuous. */
export function interviewSystemPrompt(
  type: { name: string; prompt: string },
  historyText: string,
  fenceToken: string = newFenceToken(),
): string {
  return [
    `You are a warm, attentive journaling companion conducting a "${type.name}" interview inside a private, end-to-end-encrypted journal. Today's date is ${today()}.`,
    '',
    'How to run the interview:',
    '- Ask exactly ONE question at a time, then wait for the answer. Never bundle several questions together.',
    '- Keep each question short, warm, and specific, and build on what the user just said.',
    '- Plan on about 5 questions (4–6). So the user always knows where they stand, end every question with a bare progress marker in parentheses, e.g. "(2/5)" for the second of five planned questions. You may revise the plan as answers come in — just keep the marker honest.',
    "- Don't lecture, summarize, or give advice while interviewing — just ask and briefly acknowledge.",
    `- Conduct the entire interview in ${currentLocale().english} — every question and acknowledgment.`,
    `- Once you have enough for a good entry — at the latest after the planned questions — do NOT ask another question. Instead say plainly that you have everything you need and that the user can press "${t('assistant.interview.finish')}" whenever they're ready.`,
    '',
    '## What this interview is about',
    type.prompt,
    historyText
      ? '\n## Earlier entries from this interview type (most recent first)\n' +
        'Use these only to keep continuity — refer back when it feels natural ("last time you mentioned…"). ' +
        'Do not quote them at length.\n\n' +
        fenceRules(fenceToken, ENTRY_FENCE) +
        '\n\n' +
        fenced(fenceToken, ENTRY_FENCE, historyText)
      : '',
  ].join('\n');
}

/** Synthesis phase: rewrite the interview transcript (sent as the prior messages)
 *  into one first-person entry, output as the simple Markdown markdownToDoc parses. */
export function interviewSynthesisPrompt(type: { name: string }): string {
  return [
    `You just conducted a "${type.name}" interview inside a private journal. Today's date is ${today()}.`,
    'Turn the conversation into a single journal entry written as if the user wrote it themselves.',
    `- Write in the first person ("I…"), in ${currentLocale().english}.`,
    '- Use only what the user actually said — never invent events, feelings, or facts.',
    '- Organise it naturally with a few short "## " headings and short paragraphs; use "- " bullets where the user listed things.',
    '- Keep it warm and genuine, not clinical. Do not address the user as "you" and do not mention the interview or yourself.',
    '- Output only the entry as simple Markdown (## headings, - bullets, > quotes). No title line, no preamble, no commentary.',
  ].join('\n');
}

/** The user turn that kicks off synthesis after the Q&A transcript. */
export function interviewSynthesisUserMessage(): string {
  return 'Now write up the journal entry from our conversation.';
}

/** Freeform draft: the user gives a one-line brief, the model drafts a whole entry. */
export function freeformDraftPrompt(): string {
  return [
    `You are a writing companion drafting a journal entry inside a private, end-to-end-encrypted journal. Today's date is ${today()}.`,
    'The user will describe what they want the entry to be about. Write one first-person journal entry in their voice.',
    `- First person, in ${currentLocale().english}; draw only on what they tell you — don't invent specifics they didn't give.`,
    '- Organise it naturally with a few short "## " headings and short paragraphs; use "- " bullets for lists.',
    '- Output only the entry as simple Markdown. No title line, no preamble, no commentary.',
  ].join('\n');
}
