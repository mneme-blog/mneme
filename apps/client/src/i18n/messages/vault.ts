// Vault sheets (Preferences → Vault): replace recovery phrase (RotatePhrase),
// delete vault (DeleteVault), device unlock (DeviceUnlock) and the Day One
// import (ImportDayOne). The twelve mnemonic words themselves are key material
// and are never translated — only the chrome around them.
// 'vault.delete.word' is the typed confirmation word: the check is client-side
// only (the relay DELETE /v1/account takes no confirm string from the user
// side), so localizing it is safe; the comparison is case-insensitive.
export const vault = {
  // — Replace recovery phrase —
  'vault.rotate.title': 'Replace recovery phrase',
  'vault.rotate.warn.body':
    'If your twelve words may have been seen by someone else, replace them. Mneme will generate a new phrase, re-encrypt your entire journal under it, and permanently retire the current one.',
  'vault.rotate.warn.callout':
    'Afterwards the old phrase unlocks nothing — not even encrypted data. Every other device will need the new phrase to sign in again.',
  'vault.rotate.generate': 'Generate new phrase',
  'vault.rotate.reveal.body':
    'Your new recovery phrase. Write it down in order — it replaces the old one completely.',
  'vault.rotate.tapToReveal': 'Tap to reveal',
  'vault.rotate.reveal': 'Reveal',
  'vault.rotate.hide': 'Hide',
  'vault.rotate.written': 'I’ve written it down',
  'vault.rotate.confirm.body':
    'Confirm three words from the new phrase. After this step the old phrase stops working.',
  'vault.rotate.confirm.word': 'Word #{num}',
  'vault.rotate.now': 'Replace phrase now',
  'vault.rotate.selectAll': 'Select all three words',
  'vault.rotate.phase.pull': 'Collecting your entries…',
  'vault.rotate.phase.entries': 'Re-encrypting entries…',
  'vault.rotate.phase.media': 'Re-encrypting recordings…',
  'vault.rotate.phase.wipe': 'Retiring the old phrase…',
  'vault.rotate.preparing': 'Preparing…',
  'vault.rotate.keepOpen':
    'Keep this window open. Your journal is being re-encrypted under the new phrase.',
  'vault.rotate.done.title': 'Phrase replaced',
  'vault.rotate.done.body':
    'The old phrase now unlocks nothing. Sign your other devices in again with the new twelve words — and if a password manager stored the old phrase, update it there too.',
  'vault.rotate.error.body':
    'The migration stopped before the old phrase was retired, so nothing was lost — your journal still opens with the current phrase. You can retry with the same new phrase.',
  'vault.tryAgain': 'Try again',

  // — Delete vault —
  'vault.delete.title': 'Delete vault',
  'vault.delete.body':
    'This permanently deletes every entry, recording and template — from the server and from this device. There is no undo, no backup, and no one who can restore it for you.',
  'vault.delete.callout':
    'Your recovery phrase will open an empty vault afterwards. Other devices keep what they already hold locally until you delete it there too — but they can no longer sync.',
  'vault.delete.word': 'delete',
  'vault.delete.typeToConfirm': 'Type {word} to confirm',
  'vault.delete.forever': 'Delete vault forever',
  'vault.delete.typeFirst': 'Type “{word}” first',
  'vault.delete.working': 'Deleting your vault…',
  'vault.delete.workingBody': 'Removing everything from the server, then erasing this device.',
  'vault.delete.error':
    'The vault could not be deleted — nothing was removed. Deletion needs a live connection to the server; check it and try again.',

  // — Device unlock —
  'vault.unlock.title': 'Device unlock',
  'vault.unlock.body':
    'How this device stores your key at rest. Whatever you pick only guards the copy here — the twelve-word recovery phrase always signs you in and is the only way to recover the journal.',
  'vault.unlock.method.passphrase': 'Passphrase',
  'vault.unlock.method.securityKey': 'Security key',
  'vault.unlock.method.off': 'Off — ask for my phrase each time',
  'vault.unlock.current': 'current',
  'vault.unlock.note.securityKey':
    'Unlock with a FIDO2 security key or platform passkey (touch/biometric prompt). Enrolls the key now.',
  'vault.unlock.note.passphrase':
    'Unlock by typing a device passphrase. Guessable offline by anyone holding the device — pick something long.',
  'vault.unlock.note.off':
    'Store nothing. Every cold start asks for the full recovery phrase — the strictest setting.',
  'vault.unlock.passPlaceholder': 'Passphrase (at least {min} characters)',
  'vault.unlock.repeatPlaceholder': 'Repeat the passphrase',
  'vault.unlock.mismatch': 'The two passphrases don’t match yet.',
  'vault.unlock.encrypting': 'Encrypting…',
  'vault.unlock.setPass': 'Set passphrase',
  'vault.unlock.done.off':
    'Nothing stays on this device now — cold starts ask for your twelve words.',
  'vault.unlock.done.securityKey': 'Done — this device now unlocks with your security key.',
  'vault.unlock.done.passphrase': 'Done — this device now unlocks with your passphrase.',
  'vault.unlock.err.prf':
    'This key doesn’t support the required PRF extension — use a passphrase instead.',
  'vault.unlock.err.keySetup': 'Security key setup didn’t complete — nothing was changed.',
  'vault.unlock.err.generic': 'That didn’t work — nothing was changed.',

  // — Day One import —
  'vault.import.title': 'Import from Day One',
  'vault.import.pickBody':
    'In Day One, choose Settings → Import/Export → Export → JSON, then pick the .zip it produces. It’s read entirely on this device — nothing is uploaded.',
  'vault.import.dropTitle': 'Choose or drop your Day One .zip',
  'vault.import.dropHint': 'JSON export only',
  'vault.import.readyLead': 'Ready to import from your Day One export:',
  'vault.import.row.notebooks': 'Notebooks',
  'vault.import.row.entries': 'Entries',
  'vault.import.row.media': 'Media files',
  'vault.import.readyBody':
    'Existing notebooks with a matching name are reused; the rest are created. This can take a moment for large journals — everything is encrypted on this device.',
  'vault.import.cta#one': 'Import {count} entry',
  'vault.import.cta#other': 'Import {count} entries',
  'vault.import.working': 'Importing your journal…',
  'vault.import.writing': 'Writing “{title}”',
  'vault.import.encrypting': 'Encrypting entries and media on this device.',
  'vault.import.progress#one': '{n} / {count} entry',
  'vault.import.progress#other': '{n} / {count} entries',
  'vault.import.done': 'Import complete',
  'vault.import.sum.entries': 'Entries imported',
  'vault.import.sum.journals': 'Notebooks created',
  'vault.import.sum.media': 'Media files attached',
  'vault.import.sum.skipped': 'Media missing from export',
  'vault.import.doneBody':
    'Everything is encrypted and syncing now. New notebooks appear on the Journals screen.',
  'vault.import.error': 'The import couldn’t finish — nothing was changed by the failed step.',
  'vault.import.pickAnother': 'Pick another file',

  // — journal export —
  'vault.export.title': 'Export a journal',
  'vault.export.pickBody':
    'Choose a notebook to export. You get one .zip holding every entry and every recording, decrypted, in a documented format anyone can read.',
  'vault.export.empty': 'There’s nothing to export yet — write an entry first.',
  'vault.export.entries#one': '{count} entry',
  'vault.export.entries#other': '{count} entries',
  'vault.export.readyBody':
    'The archive is built on this device and never leaves it. Nothing in your journal is changed or removed.',
  'vault.export.plaintext':
    'The archive is not encrypted. Once it’s in your downloads it’s as readable as the journal itself — keep it somewhere you trust.',
  'vault.export.working': 'Building your archive…',
  'vault.export.writing': 'Adding {name}',
  'vault.export.progress': '{n} / {count}',
  'vault.export.done': 'Export complete',
  'vault.export.sum.entries': 'Entries exported',
  'vault.export.sum.media': 'Media files included',
  'vault.export.sum.missing': 'Media not on this device',
  'vault.export.doneBody':
    'Saved to your downloads. The archive explains its own format, and the full specification is linked from its README.',
  'vault.export.missingBody':
    'Some recordings aren’t on this device and couldn’t be fetched. They’re listed in the archive’s manifest — export again from a device that holds them, or while online, for a complete copy.',
  'vault.export.manual': 'Download didn’t start? Save it here',
  'vault.export.error': 'The export couldn’t finish — nothing in your journal was changed.',
  'vault.export.again': 'Export another',
} as const;
