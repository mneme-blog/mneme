// The English message catalog — the i18n source of truth. Its keys type every
// t() call in the app. Flat, area-prefixed keys ('journals.…'); plural
// variants end in '#one'/'#other' (picked by tp() via Intl.PluralRules).
// Split per UI area so a feature's strings live in one fragment; keys must
// keep their area prefix so fragments can never collide in this spread.
import { common } from './messages/common';
import { onboarding } from './messages/onboarding';
import { journals } from './messages/journals';
import { calendar } from './messages/calendar';
import { editor } from './messages/editor';
import { editorx } from './messages/editorx';
import { media } from './messages/media';
import { assistant } from './messages/assistant';
import { vault } from './messages/vault';
import { templates } from './messages/templates';
import { shell } from './messages/shell';
import { prefs } from './messages/prefs';
import { badges } from './messages/badges';

export const en = {
  ...common,
  ...onboarding,
  ...journals,
  ...calendar,
  ...editor,
  ...editorx,
  ...media,
  ...assistant,
  ...vault,
  ...templates,
  ...shell,
  ...prefs,
  ...badges,
} as const;

export type MessageKey = keyof typeof en;
