// Media surfaces — attachment cards + delete confirmations (ui/Attachments.tsx),
// the audio/video capture modals (ui/AudioCapture.tsx, ui/VideoCapture.tsx),
// the fullscreen lightbox (ui/Lightbox.tsx), overview thumbnails
// (ui/EntryThumbs.tsx), and the location composer (ui/LocationPicker.tsx).
export const media = {
  // Human nouns for a media kind ("Delete this photo?", captions, loading copy).
  'media.noun.audio': 'audio recording',
  'media.noun.video': 'video recording',
  'media.noun.image': 'photo',
  'media.noun.file': 'file',
  // Short form used on the delete button for audio/video.
  'media.noun.recording': 'recording',

  // Byte sizes (numbers are locale-formatted by the caller).
  'media.bytes.b': '{n} B',
  'media.bytes.kb': '{n} KB',
  'media.bytes.mb': '{n} MB',

  // Attachment cards.
  'media.loading': 'Loading {noun}…',
  'media.retryUnavailable': 'Not available yet — retry',
  'media.attachedFile': 'Attached file',
  'media.attachmentFilename': 'attachment',
  'media.downloadFile': 'Download file',

  // Delete confirmation dialog.
  'media.delete.title': 'Delete this {noun}?',
  'media.delete.body':
    '{name} will be removed from this entry, and the {noun} itself ({info}) will be deleted from this device and the sync server.',
  'media.delete.bodyUnnamed':
    'It will be removed from this entry, and the {noun} itself ({info}) will be deleted from this device and the sync server.',
  'media.delete.irreversible': 'This cannot be undone or recovered.',
  'media.delete.confirm': 'Delete {noun}',

  // Audio/video capture modals.
  'media.record.audioTitle': 'Record audio',
  'media.record.videoTitle': 'Record video',
  'media.record.reviewTitle': 'Review recording',
  'media.record.micUnavailable': 'Microphone unavailable — check browser permissions.',
  'media.record.cameraUnavailable': 'Camera unavailable — check browser permissions.',
  'media.record.unsupported': 'Recording is not supported in this browser.',
  'media.record.ready': 'Ready to record',
  'media.record.start': 'Start recording',
  'media.record.stop': 'Stop',
  'media.record.retake': 'Retake',
  'media.record.useAudio': 'Use audio',
  'media.record.useVideo': 'Use video',

  // Fullscreen image lightbox.
  'media.lightbox.viewer': 'Image viewer',
  'media.lightbox.prev': 'Previous image',
  'media.lightbox.next': 'Next image',
  'media.lightbox.counter': '{n} / {total}',

  // Overview thumbnail row: the "+N more images" hint tile.
  'media.moreCount': '+{count}',

  // Location composer.
  'media.location.title': 'Add a location',
  'media.location.place': 'Place',
  'media.location.from': 'From',
  'media.location.to': 'To',
  'media.location.searchPlace': 'Search address or paste coordinates',
  'media.location.searchDestination': 'Search destination or paste coordinates',
  'media.location.change': 'Change',
  'media.location.locating': 'Locating…',
  'media.location.useCurrent': 'Use my current location',
  'media.location.addDestination': 'Add destination (make it a trip)',
  'media.location.mapPreview': 'map preview',
  'media.location.rendering': 'Rendering map…',
  'media.location.unavailable': 'Map unavailable',
  'media.location.travelPhoto': 'travel photo',
  'media.location.removePhoto': 'Remove photo',
  'media.location.addPhoto': 'Add a travel photo',
  'media.location.privacy':
    'Address search and the one-time map render contact OpenStreetMap. The map is then frozen into your encrypted entry — opening it later makes no further requests, and the sync server never sees the location.',
  'media.location.insert': 'Insert location',

  // Stitching a video interview's answer clips into one film. The render runs
  // on this device (WebCodecs, or a realtime fallback) — nothing is uploaded.
  'media.film.render': 'Render film',
  'media.film.rerender': 'Re-render film',
  'media.film.stale': 'An answer changed since this film was made.',
  'media.film.dialogTitle': 'Render your film',
  'media.film.dialogBody':
    'Your answers are stitched into one video, with the question shown as a title card before each one. This happens on this device — nothing is uploaded to do it.',
  'media.film.estimate': 'About {duration} long',
  'media.film.addedSize': 'The film is saved alongside your answer clips, so it adds to your vault.',
  'media.film.slowWarning':
    'This browser renders in real time, so it takes about as long as the film itself. Keep this tab open and the screen on.',
  'media.film.rendering': 'Rendering… {pct}%',
  'media.film.start': 'Render',
  'media.film.failed': 'Could not render the film.',
  'media.film.missingClips#one': "{count} answer isn't on this device yet — it was left out.",
  'media.film.missingClips#other': "{count} answers aren't on this device yet — they were left out.",
  'media.film.noClips': 'There are no answers to stitch together yet.',
  'media.film.unsupported': 'This browser cannot render video.',
  'media.film.deleteClips': 'Delete the source clips',
  'media.film.deleteClipsTitle': 'Delete the source clips?',
  'media.film.deleteClipsBody':
    'The {count} answer clips will be deleted from this device and the sync server. The film stays, but you will not be able to re-render or retake.',

  // Speech-to-text for recordings (ai/transcribe.ts). The transcript is stored
  // inside the encrypted entry body, so search and the assistant can read what
  // was said; transcripts survive "Delete the source clips".
  'media.transcribe.action': 'Transcribe',
  'media.transcribe.busy': 'Transcribing…',
  // A running whisper job is one opaque request — the ticking seconds are the
  // honest "still working" signal; batch runs count clips instead.
  'media.transcribe.busyFor': 'Transcribing… {seconds}s',
  'media.transcribe.busyCount': 'Transcribing answers… {done}/{total}',
  'media.transcribe.show': 'Show transcript',
  'media.transcribe.hide': 'Hide transcript',
  // Speech-to-text mishears names and numbers, and the transcript is what
  // search, previews, and the assistant read — so it is editable by hand.
  'media.transcribe.edit': 'Edit',
  'media.transcribe.editHint': 'Empty the box to remove the transcript.',
  'media.transcribe.failed': 'Could not transcribe: {message}',
  // The 404 a whisper server gives for a model it has not downloaded. Points at
  // the settings, where "Check server" can install it — a bare status code here
  // sends people looking for a bug that isn't in the app. It names the fresh-
  // install case first because that is when it is overwhelmingly seen: the
  // bundled server downloads its model on the very first start.
  'media.transcribe.modelMissing':
    'The transcription server has no model yet. On a new install it is still downloading one, which takes a few minutes. Otherwise open the AI settings and use "Check server".',
  // The relay gates the bundled transcription server (it authorizes the request
  // without ever seeing the audio — docs/SECURITY.md §6.18). Its two refusals
  // are worth their own words: neither is "the server is broken", and both are
  // things the person can act on.
  'media.transcribe.signedOut':
    'This device is not signed in to the sync server, which has to approve transcriptions. It usually reconnects by itself — try again in a moment.',
  'media.transcribe.limitReached':
    'This vault has reached its transcription limit for today. It resets at midnight UTC; the operator can raise it.',
  'media.transcribe.answers': 'Transcribe answers',
  'media.transcribe.notConfigured': 'Set up transcription in the AI settings first.',
  // Per-use disclosure before any decrypted audio leaves the device (shown only
  // when the configured server is not loopback — loopback runs directly).
  'media.transcribe.confirmTitle': 'Send for transcription?',
  'media.transcribe.confirmBody':
    'This recording leaves this device decrypted and is sent to {host} to be turned into text. The transcript is then stored end-to-end encrypted like the rest of the entry.',
  'media.transcribe.confirmAnswersBody':
    'Your {count} answer clips leave this device decrypted and are sent, one at a time, to {host} to be turned into text. The transcripts are then stored end-to-end encrypted like the rest of the entry.',
} as const;
