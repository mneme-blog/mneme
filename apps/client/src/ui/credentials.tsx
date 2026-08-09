// Credential-field primitives shared by onboarding, phrase rotation, and the
// device-unlock sheet. They used to live in screens/Onboarding.tsx — a screen
// exporting shared primitives is a layering inversion (ui/ importing from
// screens/), and these two carry password-manager semantics that must stay
// byte-identical wherever they render.
import type { JSX, VNode } from 'preact';
import { Icon } from './Icon';

// Visually hidden but manager-visible (display:none fields are ignored by
// password managers; a 1×1 transparent field is not).
const managerOnly: JSX.CSSProperties = {
  position: 'absolute', left: 0, top: 0, width: 1, height: 1,
  padding: 0, border: 'none', margin: 0, opacity: 0, pointerEvents: 'none',
  fontSize: 16, // prevent iOS zoom-on-focus if it ever receives focus
};

// A username/password pair for password managers only — the *save* side: lets a
// manager capture the phrase when the surrounding form is submitted. The password
// value is the space-separated 12-word phrase. The *fill* side cannot be hidden:
// managers only offer to fill a field the user can actually click, so the restore
// view renders its own visible current-password field instead of this component.
// Also used by the replace-phrase flow (ui/RotatePhrase.tsx) so managers offer to
// update the entry.
export function ManagerCredential({ phrase }: { phrase: string }): VNode {
  return (
    <div aria-hidden="true">
      <input
        type="text"
        name="username"
        autocomplete="username"
        value="mneme journal"
        readOnly
        tabIndex={-1}
        style={managerOnly}
      />
      <input
        type="password"
        name="password"
        autocomplete="new-password"
        value={phrase}
        readOnly
        tabIndex={-1}
        style={managerOnly}
      />
    </div>
  );
}

// A passphrase input in the restore-field style. `noManager` keeps password
// managers away from it (the device passphrase must not overwrite the saved
// recovery-phrase credential). Also used by the Preferences device-unlock sheet.
export function PassField({ value, placeholder, onInput, disabled, noManager, autoFocus }: {
  value: string;
  placeholder: string;
  onInput: (v: string) => void;
  disabled?: boolean;
  noManager: Record<string, unknown>;
  autoFocus?: boolean;
}): VNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', height: 44, borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--line)' }}>
      <Icon name="lock" size={15} color="var(--ink-3)" />
      <input
        type="password"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        {...noManager}
        style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--ink)' }}
      />
    </div>
  );
}
