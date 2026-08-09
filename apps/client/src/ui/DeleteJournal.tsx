// Delete-journal sheet — removes one notebook and everything written in it.
// Same heavy friction as deleting the vault: the user must type the word
// "delete". The entries tombstone through the LWW oplog (so the deletion
// reaches other devices) and their recordings are purged locally and on the
// relay; the journal row itself is a local grouping and disappears immediately.
import type { VNode } from 'preact';
import { t, tp } from '../i18n';
import { Sheet } from './Sheet';
import { TypedConfirmForm } from './ConfirmDialog';
import type { Journal } from '../data/sample';

// Renders a catalog message around one styled placeholder: the raw template
// (t() without params keeps `{token}` literal) is split on the token and the
// given node is interleaved — no concatenation of translated fragments.
function around(key: Parameters<typeof t>[0], token: string, node: VNode | string): (VNode | string)[] {
  const [before, ...rest] = t(key).split(`{${token}}`);
  return rest.length > 0 ? [before, node, rest.join(`{${token}}`)] : [before];
}

export function DeleteJournalSheet({ desk, journal, onClose, onDelete }: {
  desk: boolean;
  /** The notebook to delete — `count` carries its live entry count for the warning copy. */
  journal: Journal;
  onClose: () => void;
  /** Performs the deletion (local + queued relay deletes); the caller closes the sheet. */
  onDelete: () => void;
}): VNode {
  // The typed word comes from the catalog too — the check is purely
  // client-side, so localizing it is safe. Case-insensitive on purpose.
  const word = t('journals.delete.word');

  const what =
    journal.count === 0
      ? t('journals.delete.empty')
      : tp('journals.delete.body', journal.count);

  return (
    <Sheet desk={desk} onClose={onClose} scroll width={440} title={t('journals.delete.title')} icon="trash">
      <TypedConfirmForm
        word={word}
        label={around('journals.delete.confirmLabel', 'word', <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent-ink)' }}>{word}</span>)}
        confirmLabel={t('journals.delete.confirm')}
        idleLabel={t('journals.delete.typeFirst', { word })}
        onConfirm={onDelete}
        onCancel={onClose}
        autoFocus
      >
        <p style={{ fontFamily: 'var(--ui)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 }}>
          {around('journals.delete.lead', 'name', <strong style={{ color: 'var(--ink)' }}>{journal.name}</strong>)} {what} {t('journals.delete.noUndo')}
        </p>
      </TypedConfirmForm>
    </Sheet>
  );
}
