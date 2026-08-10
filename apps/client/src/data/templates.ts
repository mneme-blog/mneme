// Predefined entry templates (§10 step 7). These are *seeds*, not fixtures:
// every device lays them down once as ordinary template rows (pristine,
// local-only), and from then on the user owns them — rename, rewrite, delete.
// Ids are random per device (a well-known id in the cleartext entry_id would
// tell the relay which blobs are templates); state/data.tsx retires a pristine
// seed when a synced copy of the same `slug` arrives from another device.
//
// The name + section text of each built-in is localized: every string comes
// from the `templates.builtin.*` catalog keys, resolved with t() at build time.
// A pristine seed therefore re-renders in the active language (state/data.tsx
// projects it through localizeBuiltinTemplate on display); the first edit forks
// it into a real synced content record in whatever language it was showing.
import type { JSONContent } from '@tiptap/core';
import { docToText } from '../editor/doc';
import { newTemplateId } from '../sync/ids';
import type { TemplateRecord } from '../sync/engine';
import { t, type MessageKey } from '../i18n';

interface BuiltinTemplate {
  slug: string;
  nameKey: MessageKey;
  /** Built at call time so t() reflects the current locale. */
  build: () => JSONContent;
}

const h2 = (text: string): JSONContent => ({
  type: 'heading',
  attrs: { level: 2 },
  content: [{ type: 'text', text }],
});
const p = (text?: string): JSONContent =>
  text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' };
const taskItem = (): JSONContent => ({
  type: 'taskItem',
  attrs: { checked: false },
  content: [{ type: 'paragraph' }],
});
const listItem = (): JSONContent => ({ type: 'listItem', content: [{ type: 'paragraph' }] });
const th = (text: string): JSONContent => ({ type: 'tableHeader', content: [p(text)] });
const td = (): JSONContent => ({ type: 'tableCell', content: [p()] });
const row = (cells: JSONContent[]): JSONContent => ({ type: 'tableRow', content: cells });

const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    slug: 'daily',
    nameKey: 'templates.builtin.daily.name',
    build: () => ({
      type: 'doc',
      content: [
        h2(t('templates.builtin.daily.h1')),
        p(),
        h2(t('templates.builtin.daily.h2')),
        p(),
        h2(t('templates.builtin.daily.h3')),
        p(),
      ],
    }),
  },
  {
    slug: 'gratitude',
    nameKey: 'templates.builtin.gratitude.name',
    build: () => ({
      type: 'doc',
      content: [
        p(t('templates.builtin.gratitude.intro')),
        { type: 'orderedList', attrs: { start: 1 }, content: [listItem(), listItem(), listItem()] },
      ],
    }),
  },
  {
    slug: 'dream',
    nameKey: 'templates.builtin.dream.name',
    build: () => ({
      type: 'doc',
      content: [
        h2(t('templates.builtin.dream.h1')),
        p(),
        h2(t('templates.builtin.dream.h2')),
        p(),
        h2(t('templates.builtin.dream.h3')),
        p(),
      ],
    }),
  },
  {
    slug: 'experiment',
    nameKey: 'templates.builtin.experiment.name',
    build: () => ({
      type: 'doc',
      content: [
        h2(t('templates.builtin.experiment.h1')),
        p(),
        h2(t('templates.builtin.experiment.h2')),
        p(),
        h2(t('templates.builtin.experiment.h3')),
        {
          type: 'table',
          content: [
            row([
              th(t('templates.builtin.experiment.col1')),
              th(t('templates.builtin.experiment.col2')),
              th(t('templates.builtin.experiment.col3')),
            ]),
            row([td(), td(), td()]),
            row([td(), td(), td()]),
          ],
        },
        h2(t('templates.builtin.experiment.h4')),
        p(),
      ],
    }),
  },
  {
    slug: 'study',
    nameKey: 'templates.builtin.study.name',
    build: () => ({
      type: 'doc',
      content: [
        h2(t('templates.builtin.study.h1')),
        p(),
        h2(t('templates.builtin.study.h2')),
        { type: 'bulletList', content: [listItem(), listItem(), listItem()] },
        h2(t('templates.builtin.study.h3')),
        p(),
        h2(t('templates.builtin.study.h4')),
        { type: 'taskList', content: [taskItem(), taskItem()] },
      ],
    }),
  },
  {
    slug: 'weekly',
    nameKey: 'templates.builtin.weekly.name',
    build: () => ({
      type: 'doc',
      content: [
        h2(t('templates.builtin.weekly.h1')),
        p(),
        h2(t('templates.builtin.weekly.h2')),
        p(),
        h2(t('templates.builtin.weekly.h3')),
        { type: 'taskList', content: [taskItem(), taskItem(), taskItem()] },
      ],
    }),
  },
];

const BY_SLUG = new Map(BUILTIN_TEMPLATES.map((b) => [b.slug, b]));

/** Slug list, for tests/tooling that need to know the built-in set. */
/** Materialize the built-ins as pristine template records (fresh random ids),
    with their content in the current locale. */
export function seedBuiltinTemplates(now: number): TemplateRecord[] {
  return BUILTIN_TEMPLATES.map((b) => {
    const doc = b.build();
    return {
      id: newTemplateId(),
      name: t(b.nameKey),
      bodyText: docToText(doc),
      bodyJson: JSON.stringify(doc),
      builtin: b.slug,
      pristine: true,
      createdAt: now,
      updatedAt: now,
    };
  });
}

/** Display projection: re-render a pristine built-in seed in the active locale.
    Non-built-in, forked, or unknown-slug rows pass through unchanged — only the
    still-pristine seeds follow the language, never a record the user owns. */
export function localizeBuiltinTemplate(rec: TemplateRecord): TemplateRecord {
  if (!rec.pristine || !rec.builtin) return rec;
  const b = BY_SLUG.get(rec.builtin);
  if (!b) return rec;
  const doc = b.build();
  return { ...rec, name: t(b.nameKey), bodyText: docToText(doc), bodyJson: JSON.stringify(doc) };
}
