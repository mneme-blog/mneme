// Badges — the gamification awards (state/badges.ts): the celebration overlay
// (ui/BadgeCelebration.tsx) and the gallery in Preferences → Your writing.
export const badges = {
  // ── Celebration overlay ──
  'badges.celebrate.title': 'Badge earned',
  'badges.celebrate.dismiss': 'Nice!',

  // ── Gallery (Preferences → Your writing) ──
  'badges.gallery.title': 'Badges',

  // ── The badges: name + how it's earned ──
  'badges.first-words.name': 'First Words',
  'badges.first-words.desc': 'Write your first entry.',
  'badges.streak-3.name': 'Three in a Row',
  'badges.streak-3.desc': 'Write on three days in a row.',
  'badges.streak-7.name': 'One Week Strong',
  'badges.streak-7.desc': 'Write on seven days in a row.',
  'badges.wordsmith.name': 'Wordsmith',
  'badges.wordsmith.desc': 'Write 1,000 words in total.',
  'badges.deep-dive.name': 'Deep Dive',
  'badges.deep-dive.desc': 'Write a single entry of 1,000 words or more.',
  'badges.first-interview.name': 'First Interview',
  'badges.first-interview.desc': 'Complete your first guided interview.',
  'badges.on-camera.name': 'On Camera',
  'badges.on-camera.desc': 'Record your first video interview.',
  'badges.memory-keeper.name': 'Memory Keeper',
  'badges.memory-keeper.desc': 'Add a photo, audio, or video to an entry.',
} as const;
