// Journals area — library screen (screens/Journals.tsx), the mobile notebook
// drill-in (screens/JournalEntries.tsx), the move-to-notebook picker
// (ui/JournalPicker.tsx) and the typed-"delete" sheet (ui/DeleteJournal.tsx).
export const journals = {
  'journals.title': 'Journals',
  'journals.new': 'New journal',
  'journals.newHint': 'Personal, travel, dreams…',
  'journals.untitled': 'Untitled journal',
  'journals.untitledTemplate': 'Untitled template',
  'journals.justNow': 'Just now',
  'journals.create': 'Create journal',
  'journals.saveChanges': 'Save changes',
  'journals.name.placeholder': 'Name your journal',
  'journals.subtitle.placeholder': 'Add a description',

  'journals.field.subtitle': 'Description',
  'journals.field.colour': 'Colour',
  'journals.field.cover': 'Cover',
  'journals.field.startFrom': 'Start from',
  'journals.blank': 'Blank',

  'journals.cover.lines': 'Lines',
  'journals.cover.dots': 'Dots',
  'journals.cover.grid': 'Grid',
  'journals.cover.plain': 'Plain',
  'journals.cover.photo': 'Photo',

  'journals.edit.title': 'Edit journal',
  'journals.newEntry': 'New entry',
  'journals.vault': 'Your vault',

  'journals.notebooks#one': '{count} notebook',
  'journals.notebooks#other': '{count} notebooks',
  // {notebooks}/{entries} are pre-pluralized via tp().
  'journals.summary.desk': '{notebooks} · {entries} · all encrypted',
  'journals.summary.mobile': '{notebooks} · all encrypted on this device',

  'journals.syncingTag': 'Syncing…',
  'journals.syncingTag.title': 'This notebook is still syncing to the relay',
  'journals.uploading.title': 'Finishing sync…',
  'journals.uploading.body#one':
    '{count} change is being encrypted and uploaded to the relay. Imported entries appear in their notebooks as they sync.',
  'journals.uploading.body#other':
    '{count} changes are being encrypted and uploaded to the relay. Imported entries appear in their notebooks as they sync.',

  'journals.edited': 'Edited {last}',
  'journals.noEntriesYet': 'No entries yet',
  // {entries} is pre-pluralized via tp(); {last} is the relative-time string.
  'journals.entriesEditedLast': '{entries} · edited {last}',
  'journals.searchAll': 'Search all entries',

  'journals.firstEntry': 'Write the first entry',
  'journals.firstEntry.hint': 'Nothing in this journal yet',

  'journals.picker.move': 'Move to another notebook',
  'journals.picker.none': 'No notebook',
  'journals.picker.heading': 'Move to notebook',

  // The typed confirmation word — the check is client-side only, so it is
  // safe (and kinder) to localize it along with the copy that cites it.
  'journals.delete.word': 'delete',
  'journals.delete.title': 'Delete journal',
  // {name} is wrapped in <strong> by the component (split-render).
  'journals.delete.lead': 'This permanently deletes {name}.',
  'journals.delete.empty': 'This notebook is empty — only the notebook itself is removed.',
  'journals.delete.body#one':
    'Its entry — recordings included — is deleted from this device, the server, and (on their next sync) your other devices.',
  'journals.delete.body#other':
    'All {count} entries — recordings included — are deleted from this device, the server, and (on their next sync) your other devices.',
  'journals.delete.noUndo': 'There is no undo.',
  // {word} is wrapped in a mono span by the component (split-render).
  'journals.delete.confirmLabel': 'Type {word} to confirm',
  'journals.delete.confirm': 'Delete journal forever',
  'journals.delete.typeFirst': 'Type “{word}” first',
} as const;
