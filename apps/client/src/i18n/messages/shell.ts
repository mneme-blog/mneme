// App shell — desktop sidebar + mobile nav (app.tsx), the search palette
// (ui/Search.tsx), shared primitives (sync/connection status, placeholders),
// and the relative-day labels derived in state/data.tsx.
export const shell = {
  // ── Sidebar / navigation ──
  'shell.newEntry': 'New entry',
  'shell.nav.journals': 'Journals',
  'shell.nav.calendar': 'Calendar',
  'shell.nav.templates': 'Templates',
  'shell.nav.ask': 'Ask my journal',
  'shell.notebooks': 'Notebooks',
  'shell.preferences': 'Preferences',
  'shell.yourVault': 'Your vault',
  // Sidebar footer status (styled lowercase in English).
  'shell.footer.syncing': 'syncing…',
  'shell.footer.syncingCount': 'syncing {count}…',

  // ── New-entry wizard (ui/NewEntryWizard.tsx) ──
  'shell.compose.blank': 'Blank page',
  'shell.compose.blankHint': 'Start writing on an empty page',
  'shell.compose.interview': 'Chat interview',
  'shell.compose.interviewHint': 'Answer a few questions and get a draft',
  'shell.compose.videoInterview': 'Video interview',
  'shell.compose.videoInterviewHint': 'Answer on camera, one clip per question',
  'shell.compose.template': 'From a template',
  'shell.compose.templateHint': 'Start from one of your templates',
  'shell.compose.aiOff': 'Turn on the assistant to use this',
  'shell.compose.notebook': 'Notebook',
  'shell.compose.pickTemplate': 'Pick a template',
  'shell.compose.manageTemplates': 'Manage templates',
  'shell.compose.noTypes': 'No interview types yet.',

  // ── Connection status (connLabel) ──
  'shell.conn.online': 'Connected',
  'shell.conn.offline': 'Offline',
  'shell.conn.connecting': 'Connecting…',
  'shell.conn.locked': 'Locked',

  // ── Sync badge / notices ──
  'shell.sync.connectingTitle': 'Connecting to the relay',
  'shell.sync.offlineSaved': 'Offline · saved here',
  'shell.sync.offlineSavedTitle': 'Saved on this device — will sync when you reconnect',
  'shell.sync.offlineTitle': 'No connection to the relay',
  'shell.sync.lockedTitle': 'Not signed in',
  'shell.sync.syncingCount': 'Syncing {count}…',
  'shell.sync.saving': 'Saving…',
  'shell.sync.busyTitle': 'Encrypting and syncing your changes',
  'shell.sync.synced': 'Synced',
  'shell.sync.syncedTitle': 'End-to-end encrypted · all changes synced',
  'shell.sync.noticeTitle': 'Syncing your journal…',
  'shell.sync.noticeBody':
    'Entries are downloaded from the relay and decrypted on this device. They appear as they arrive.',
  'shell.sync.progress': 'Syncing — {done} of {total} done',

  // ── Search palette ──
  'shell.search.placeholder': 'Search titles, content, labels, dates…',
  'shell.search.empty':
    'Nothing matches “{query}” — try a word from an entry, a label, or a date like “jun 9”.',
  // Matched-field tag on a result row (CSS uppercases it).
  'shell.search.field.title': 'title',
  'shell.search.field.label': 'label',
  'shell.search.field.date': 'date',
  'shell.search.field.content': 'content',

  // ── Shared primitives ──
  'shell.removeLabel': 'Remove "{name}"',

  // ── iOS PWA caveat notice (ui/IOSNotice.tsx) — iOS only ──
  'shell.iosNotice.body':
    'For your privacy, iPhone and iPad automatically clear a web app’s offline data after about 7 days of inactivity. Your journal stays end-to-end encrypted on the server, so just sign back in to restore it — and a native iOS app is on the way.',
  'shell.iosNotice.dismiss': 'Dismiss',

  // ── Relative day labels (state/data.tsx relativeDay) ──
  'shell.daysAgo#one': '{count} day ago',
  'shell.daysAgo#other': '{count} days ago',
  'shell.lastWeek': 'Last week',
} as const;
