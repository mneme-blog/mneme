// Editor extras: slash palette commands, toolbar tooltips, the math dialog,
// media/location node cards, wikilinks, and DocPreview placeholders.
// (editor.ts carries the editor screen itself; this fragment is the
// editor-internals pass.)
export const editorx = {
  // "/" slash palette commands (titles + hints). The menu matches on the
  // localized title plus the untranslated English keywords in slash.ts.
  'editorx.slash.h1': 'Heading 1',
  'editorx.slash.h1.hint': 'Large section heading',
  'editorx.slash.h2': 'Heading 2',
  'editorx.slash.h2.hint': 'Medium section heading',
  'editorx.slash.h3': 'Heading 3',
  'editorx.slash.h3.hint': 'Small section heading',
  'editorx.slash.bulletList': 'Bullet list',
  'editorx.slash.bulletList.hint': 'Simple unordered list',
  'editorx.slash.numberedList': 'Numbered list',
  'editorx.slash.numberedList.hint': 'Ordered list with numbers',
  'editorx.slash.checklist': 'Checklist',
  'editorx.slash.checklist.hint': 'List with checkboxes',
  'editorx.slash.quote': 'Quote',
  'editorx.slash.quote.hint': 'Pulled-out quotation',
  'editorx.slash.codeBlock': 'Code block',
  'editorx.slash.codeBlock.hint': 'Monospaced code',
  'editorx.slash.table': 'Table',
  'editorx.slash.table.hint': 'Rows and columns',
  'editorx.slash.divider': 'Divider',
  'editorx.slash.divider.hint': 'Horizontal rule',
  'editorx.slash.math': 'Math',
  'editorx.slash.math.hint': 'Inline LaTeX formula',
  'editorx.slash.mathBlock': 'Math block',
  'editorx.slash.mathBlock.hint': 'Centered display formula',
  'editorx.slash.link': 'Link to entry',
  'editorx.slash.link.hint': 'Reference another entry',
  'editorx.slash.template': 'Template',
  'editorx.slash.template.hint': 'Insert an entry template',
  'editorx.slash.location': 'Location',
  'editorx.slash.location.hint': 'Map a place or trip',
  'editorx.slash.video': 'Video',
  'editorx.slash.video.hint': 'Record a video clip',
  'editorx.slash.audio': 'Audio',
  'editorx.slash.audio.hint': 'Record a voice note',
  'editorx.slash.image': 'Image',
  'editorx.slash.image.hint': 'Upload photos',
  'editorx.slash.file': 'File',
  'editorx.slash.file.hint': 'Attach a file',
  'editorx.slash.aiContinue': 'Continue writing',
  'editorx.slash.aiContinue.hint': 'AI picks up where you stopped',
  'editorx.slash.aiSummarize': 'Summarize entry',
  'editorx.slash.aiSummarize.hint': 'AI summary of this entry',
  'editorx.slash.aiTitle': 'Suggest title',
  'editorx.slash.aiTitle.hint': 'AI title ideas for this entry',

  // Rich-text ⇄ markdown mode switch.
  'editorx.mode.rich': 'Rich text',
  'editorx.mode.markdown': 'Markdown',
  'editorx.mode.editingAs': 'Editing as {mode}',
  'editorx.mode.switchTo': 'Switch to {mode}',

  // Toolbar tooltips (bullet list / checklist / quote reuse the slash keys).
  'editorx.tool.bold': 'Bold',
  'editorx.tool.italic': 'Italic',
  'editorx.tool.heading': 'Heading',
  'editorx.tool.addRowBelow': 'Add row below',
  'editorx.tool.addColumnRight': 'Add column right',
  'editorx.tool.deleteRow': 'Delete row',
  'editorx.tool.deleteColumn': 'Delete column',
  'editorx.tool.toggleHeaderRow': 'Toggle header row',
  'editorx.tool.deleteTable': 'Delete table',

  // Math (LaTeX) dialog.
  'editorx.math.edit': 'Edit math',
  'editorx.math.insertInline': 'Insert math',
  'editorx.math.insertBlock': 'Insert math block',
  'editorx.math.preview': 'LaTeX preview',
  'editorx.math.cheatsheet': 'Cheatsheet',
  'editorx.math.sheet.basics': 'Basics',
  'editorx.math.sheet.calculus': 'Calculus',
  'editorx.math.sheet.symbols': 'Symbols',
  'editorx.math.sheet.greek': 'Greek',
  'editorx.math.sheet.layout': 'Layout',
  'editorx.math.sheet.hint':
    'Click a formula to insert its LaTeX at the cursor — hover to see the source.',

  // Location card (frozen map node).
  'editorx.location.mapAlt': 'Map',
  'editorx.location.travelPhoto': 'Travel photo',
  'editorx.location.loadingMap': 'Loading map…',
  'editorx.location.loadingPhoto': 'Loading photo…',
  'editorx.location.retry': 'Not available yet — retry',
  'editorx.location.pinned': 'Pinned location',
  'editorx.location.destination': 'Destination',
  'editorx.location.delete': 'Delete location',
  'editorx.location.confirmTitle': 'Delete this location?',
  'editorx.location.confirmBody.map':
    'The map will be removed from this entry and deleted from this device and the sync server.',
  'editorx.location.confirmBody.mapPhoto':
    'The map and travel photo will be removed from this entry and deleted from this device and the sync server.',
  'editorx.location.cannotUndo': 'This cannot be undone.',
  'editorx.location.distanceM': '{n} m',
  'editorx.location.distanceKm': '{n} km',

  // Video interview card (the guided on-camera session's node).
  'editorx.videoInterview.title': 'Video interview',
  'editorx.videoInterview.questions#one': '{count} question',
  'editorx.videoInterview.questions#other': '{count} questions',
  'editorx.videoInterview.answered': '{n} of {total} answered',
  'editorx.videoInterview.notRecorded': 'Not recorded',
  'editorx.videoInterview.clipRemoved': 'Answered — source clip deleted',
  'editorx.videoInterview.loadingClip': 'Loading answer…',
  'editorx.videoInterview.retry': 'Not available yet — retry',
  'editorx.videoInterview.film': 'Your film',
  'editorx.videoInterview.delete': 'Delete interview',
  'editorx.videoInterview.confirmTitle': 'Delete this video interview?',
  'editorx.videoInterview.confirmBody':
    'The {count} answer clips and the rendered film will be removed from this entry and deleted from this device and the sync server.',
  'editorx.videoInterview.confirmBodyNoFilm':
    'The {count} answer clips will be removed from this entry and deleted from this device and the sync server.',
  'editorx.videoInterview.cannotUndo': 'This cannot be undone.',

  // Cross-entry links ("[[" picker chips).
  'editorx.wikilink.open': 'Open linked entry',
  'editorx.wikilink.missing': 'Linked entry no longer exists',

  // DocPreview display-only markers.
  'editorx.preview.audio': '🎙 audio',
  'editorx.preview.video': '🎬 video',
  'editorx.preview.location': 'Location',
  'editorx.preview.videoInterview': 'Video interview',
} as const;
