// AI assistant surfaces: settings sheet (ui/AiSettings.tsx), Ask-my-journal
// (ui/AskJournal.tsx), the editor action dialog (ui/AiActionDialog.tsx), the
// guided interview (ui/GuidedInterview.tsx) and the interview-types manager
// (ui/InterviewTypes.tsx). Prompt text sent to the model stays English in
// ai/prompts.ts — only UI chrome lives here.
export const assistant = {
  // ── shared chrome ──
  'assistant.badge.local': 'stays on this device',
  // Shown instead of badge.local when the Ollama URL points somewhere other
  // than loopback — the "stays on this device" claim would be false.
  'assistant.badge.network': 'leaves this device',
  'assistant.badge.cloud': 'cloud',
  'assistant.badge.onDevice': 'on this device',
  'assistant.badge.sentToAnthropic': 'sent to Anthropic',
  'assistant.stop': 'Stop',
  'assistant.discard': 'Discard',
  'assistant.saving': 'Saving…',

  // ── shared error states ──
  'assistant.error.keyRejected': 'The API key was rejected — check it in AI settings.',
  'assistant.error.keyRejectedShort': 'The API key was rejected.',
  'assistant.error.ollamaUnreachable': 'Could not reach Ollama — is it running? (ollama serve)',
  'assistant.error.apiUnreachable': 'Could not reach the API: {message}',
  'assistant.error.requestFailed': 'Request failed: {message}',
  'assistant.error.refused': 'The model declined.',
  'assistant.error.refusedAnswer': 'The model declined to answer.',
  'assistant.error.refusedRespond': 'The model declined to respond.',

  // ── settings sheet ──
  'assistant.settings.title': 'AI assistant',
  'assistant.settings.enable': 'Enable AI features',
  'assistant.settings.enableHint': 'Ask questions about your journal, get writing help.',
  'assistant.settings.serverUrl': 'Server URL',
  'assistant.settings.model': 'Model',
  'assistant.settings.apiKey': 'API key',
  'assistant.settings.ollamaHint':
    'Your entries are processed by a model running on your own machine. Nothing leaves this device.',
  'assistant.settings.ollamaModelPlaceholder': 'llama3.2 — or Test connection to list',
  // Always shown, so the destination is never implicit — this setting syncs
  // between your devices, and a value typed on one governs all of them.
  'assistant.settings.ollamaEffective': 'Requests go to {host}',
  'assistant.settings.ollamaNotLocal':
    'That address is not this device. Entries used as context will leave this device to reach it — on a plain HTTP address they travel your network unencrypted.',
  'assistant.settings.ollamaInvalidUrl':
    'Not a usable http:// or https:// address — {host} will be used instead.',
  'assistant.settings.ollamaOriginsNote':
    'Accessing Ollama from a non-localhost origin needs OLLAMA_ORIGINS set on the Ollama side; Safari may block localhost from an https page.',
  // {decrypted} is replaced by the bold 'assistant.settings.cloudPrivacyDecrypted'.
  'assistant.settings.cloudPrivacy':
    "When you use AI features, the entries used as context are sent, {decrypted}, to Anthropic over HTTPS — leaving Mneme's end-to-end encryption for that request. Your relay never sees them. Anthropic's API terms apply.",
  'assistant.settings.cloudPrivacyDecrypted': 'decrypted',
  'assistant.settings.test': 'Test connection',
  'assistant.settings.testing': 'Testing…',
  'assistant.settings.connected': 'Connected',
  'assistant.settings.saveFailed': 'Could not save: {message}',
  'assistant.settings.keyNote':
    'The API key is encrypted with a key derived from your recovery phrase and is only readable while your journal is unlocked.',

  // ── transcription (speech-to-text for video/audio recordings) ──
  'assistant.transcribe.title': 'Transcription',
  'assistant.transcribe.hint':
    "Turn video and audio recordings into text you can search and the assistant can read. Your deployment's bundled whisper server is preconfigured; any server speaking the OpenAI audio-transcriptions API works — one on this device, or a cloud endpoint with an API key. Clear the URL to turn transcription off.",
  // Always shown when configured — this setting syncs between your devices, so
  // the destination is never implicit (same rule as the Ollama URL).
  'assistant.transcribe.effective': 'Recordings go to {host}',
  'assistant.transcribe.notLocal':
    'That address is not this device. Transcribing sends the decrypted recording there for that request — on a plain HTTP address it travels your network unencrypted.',
  'assistant.transcribe.keyOptional': 'optional',
  'assistant.transcribe.cspNote':
    'Self-hosted web deployments must also allow a non-loopback server in the Content-Security-Policy (CSP_CONNECT_EXTRA).',

  // ── Ask my journal ──
  'assistant.ask.title': 'Ask my journal',
  'assistant.ask.emptyHint':
    'Ask anything about what you\'ve written — "what did I do last weekend?", "when did I first mention the garden?", "summarize my June".',
  'assistant.ask.notSaved': 'Each question searches your journal afresh; the conversation is not saved.',
  'assistant.ask.context#one': 'Using {count} entry as context',
  'assistant.ask.context#other': 'Using {count} entries as context',
  'assistant.ask.contextTruncated#one': 'Using {count} entry as context (truncated to fit)',
  'assistant.ask.contextTruncated#other': 'Using {count} entries as context (truncated to fit)',
  'assistant.ask.placeholder': 'Ask your journal…',
  'assistant.ask.send': 'Ask',

  // ── editor action dialog ──
  'assistant.action.continue': 'Continue writing',
  'assistant.action.summarize': 'Summarize entry',
  'assistant.action.title': 'Suggest a title',
  'assistant.action.pickTitle': 'Pick a title:',
  'assistant.action.thinking': 'Thinking…',
  'assistant.action.nothing': '(nothing generated)',
  'assistant.action.insert': 'Insert at cursor',

  // ── guided interview ──
  'assistant.interview.title': 'Guided interview',
  'assistant.interview.fallbackTitle': 'Interview',
  'assistant.interview.yourDraft': 'Your draft',
  'assistant.interview.pickIntro':
    "Pick an interview. I'll ask a few questions, then write your answers up as a journal entry you can review before saving.",
  'assistant.interview.freeform': 'Freeform draft',
  'assistant.interview.freeformHint': "Describe an entry in a sentence and I'll draft it — no questions.",
  'assistant.interview.manageTypes': 'Manage interview types',
  'assistant.interview.answerPlaceholder': 'Your answer…',
  'assistant.interview.send': 'Send',
  'assistant.interview.finish': 'Finish & write entry',
  'assistant.interview.briefHint':
    "What should this entry be about? One or two sentences is plenty — I'll draft the rest in your voice.",
  'assistant.interview.briefPlaceholder': 'e.g. My hike up the coast trail this morning…',
  'assistant.interview.draft': 'Draft',
  'assistant.interview.writing': 'Writing your entry…',
  'assistant.interview.nothingWritten': '(nothing written)',
  'assistant.interview.save': 'Save entry',

  // ── guided VIDEO interview (same types, answered on camera) ──
  // The model plans every question up front: it cannot hear a recorded answer,
  // so there is nothing to adapt to mid-session (see ai/prompts.ts).
  'assistant.video.title': 'Video interview',
  'assistant.video.pickIntro':
    "Pick an interview. I'll plan the questions, then you answer them on camera — one clip per question.",
  'assistant.video.recordInstead': 'Record on camera',
  'assistant.video.planning': 'Planning your questions…',
  'assistant.video.planTitle': 'Your questions',
  'assistant.video.planHint': 'Edit, reorder, or remove any question before you start recording.',
  'assistant.video.planFailed': "I couldn't plan questions just now — here is a general set instead.",
  'assistant.video.questionPlaceholder': 'Your question…',
  'assistant.video.addQuestion': 'Add a question',
  'assistant.video.moveUp': 'Move up',
  'assistant.video.moveDown': 'Move down',
  'assistant.video.removeQuestion': 'Remove this question',
  'assistant.video.start': 'Start recording',
  'assistant.video.progress': 'Question {n} of {total}',
  'assistant.video.record': 'Record answer',
  'assistant.video.stop': 'Stop',
  'assistant.video.retake': 'Retake',
  'assistant.video.skip': 'Skip this one',
  'assistant.video.back': 'Previous question',
  'assistant.video.useAndNext': 'Use & next',
  'assistant.video.finish': 'Finish & save',
  'assistant.video.cameraUnavailable': 'Camera unavailable — check permissions and try again.',
  'assistant.video.unsupported': 'This browser cannot record video.',
  'assistant.video.savingClip': 'Saving answer {n} of {total}…',
  'assistant.video.noClips': 'Record at least one answer to save.',
  'assistant.video.maxLength': 'Up to {seconds}s per answer',
  // Opt-in auto-transcription after saving; the sub-line is the per-use
  // disclosure — it names the destination when it isn't this device.
  'assistant.video.transcribe': 'Transcribe my answers afterwards',
  'assistant.video.transcribeLocal': 'Speech-to-text runs on this device after saving.',
  'assistant.video.transcribeRemote': 'After saving, your answers are sent decrypted to {host} to be turned into text.',
  'assistant.video.discardTitle': 'Discard this interview?',
  'assistant.video.discardBody': 'Your recorded answers have not been saved yet and will be lost.',
  'assistant.video.discard': 'Discard',
  // Used when the model is unreachable or returns nothing usable — the session
  // must still work without it.
  'assistant.video.fallback.q1': 'What happened today that you want to remember?',
  'assistant.video.fallback.q2': 'What was the best part, and why did it land that way?',
  'assistant.video.fallback.q3': 'What was hard, or did not go the way you hoped?',
  'assistant.video.fallback.q4': 'Who did you spend time with, and how was it?',
  'assistant.video.fallback.q5': 'What are you carrying into tomorrow?',

  // ── built-in interview types (data/interviews.ts seeds; pristine seeds follow
  //     the app language via localizeBuiltinInterview, like template built-ins) ──
  'assistant.interview.builtin.daily-checkin.name': 'Daily check-in',
  'assistant.interview.builtin.daily-checkin.intro': 'A short, friendly look back at your day.',
  'assistant.interview.builtin.morning-intention.name': 'Morning intention',
  'assistant.interview.builtin.morning-intention.intro': 'Set the tone and focus for the day ahead.',
  'assistant.interview.builtin.evening-reflection.name': 'Evening reflection',
  'assistant.interview.builtin.evening-reflection.intro': 'Wind down and make sense of the day.',
  'assistant.interview.builtin.gratitude.name': 'Gratitude',
  'assistant.interview.builtin.gratitude.intro': 'Notice a few good things, big or small.',
  'assistant.interview.builtin.weekly-review.name': 'Weekly review',
  'assistant.interview.builtin.weekly-review.intro': 'Step back and review the past week.',
  'assistant.interview.builtin.mood-energy.name': 'Mood & energy',
  'assistant.interview.builtin.mood-energy.intro': 'Track how you feel and what shaped it.',
  'assistant.interview.builtin.work-standup.name': 'Work standup',
  'assistant.interview.builtin.work-standup.intro': "Log what moved, what's blocked, and what's next.",
  'assistant.interview.builtin.one-on-one-prep.name': '1:1 prep',
  'assistant.interview.builtin.one-on-one-prep.intro': 'Gather what to raise in your next 1:1.',
  'assistant.interview.builtin.project-retro.name': 'Project retro',
  'assistant.interview.builtin.project-retro.intro': 'Look back on a project — wins, misses, lessons.',
  'assistant.interview.builtin.study-recap.name': 'Study recap',
  'assistant.interview.builtin.study-recap.intro': 'Capture what you studied and what stuck.',
  'assistant.interview.builtin.lecture-reflection.name': 'Lecture reflection',
  'assistant.interview.builtin.lecture-reflection.intro': 'Make sense of a class or lecture.',
  'assistant.interview.builtin.exam-prep.name': 'Exam prep',
  'assistant.interview.builtin.exam-prep.intro': 'Check where you stand before an exam.',
  'assistant.interview.builtin.experiment-debrief.name': 'Experiment debrief',
  'assistant.interview.builtin.experiment-debrief.intro': 'Record a run — hypothesis, method, results.',
  'assistant.interview.builtin.research-progress.name': 'Research progress',
  'assistant.interview.builtin.research-progress.intro': 'Track where your research stands this week.',
  'assistant.interview.builtin.lab-troubleshooting.name': 'Troubleshooting log',
  'assistant.interview.builtin.lab-troubleshooting.intro': 'Work through what went wrong and why.',

  // ── interview-types manager ──
  'assistant.types.title': 'Interview types',
  'assistant.types.builtin': 'built-in',
  'assistant.types.new': 'New interview',
  'assistant.types.edit': 'Edit interview',
  'assistant.types.name': 'Name',
  'assistant.types.namePlaceholder': 'e.g. Evening reflection',
  'assistant.types.intro': 'Intro',
  'assistant.types.introPlaceholder': 'One line shown in the picker',
  'assistant.types.prompt': 'Prompt — what the interview covers',
  'assistant.types.promptPlaceholder':
    'Describe the themes to cover and the tone. The AI already asks one question at a time and writes the entry up afterward — this just steers what it asks about.',
  'assistant.types.untitled': 'Untitled interview',
  'assistant.types.save': 'Save interview',
  'assistant.types.create': 'Create interview',
  'assistant.types.deleteConfirm': 'Delete?',
  'assistant.types.empty': 'No interview types yet — create one below.',
  'assistant.types.backToList': 'Back to list',
  'assistant.types.allTypes': 'All types',
} as const;
