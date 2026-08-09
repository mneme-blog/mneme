// The "where does this text go" badge, shown on every AI surface.
//
// This is a privacy disclosure, not decoration: the cloud backend sends the
// entries used as context OUT of end-to-end encryption for that request, and
// the user is entitled to see that at the moment they use the feature, not only
// in a settings screen they configured once. SECURITY.md §2 treats the
// disclosure as part of what makes the feature acceptable.
//
// It lives here because it was previously duplicated in three surfaces
// (AskJournal, AiActionDialog, GuidedInterview) with identical markup and an
// identical `provider.local ? … : …` ternary. Three copies of a disclosure is
// how one of them quietly goes stale — and one of them already had: the ternary
// assumed "not local" meant Anthropic, so an Ollama server on the LAN (which is
// not local, but is also not Anthropic) was labelled "sent to Anthropic".
import type { ComponentChildren, JSX, VNode } from 'preact';
import type { AiProvider } from '../ai/types';
import { t } from '../i18n';

function badgeStyle(local: boolean): JSX.CSSProperties {
  return {
    fontFamily: 'var(--mono)',
    fontSize: 10,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: local ? 'var(--accent-ink)' : 'var(--ink-3)',
    background: local ? 'var(--accent-soft)' : 'var(--paper)',
    border: `1px solid ${local ? 'var(--accent-line)' : 'var(--line)'}`,
    borderRadius: 6,
    padding: '2px 7px',
  };
}

/** What actually happens to the text, per backend and per configuration. */
function label(provider: AiProvider): string {
  if (provider.local) return t('assistant.badge.onDevice');
  // A non-loopback Ollama: the text leaves this device, but not to Anthropic.
  if (provider.id === 'ollama') return t('assistant.badge.network');
  return t('assistant.badge.sentToAnthropic');
}

export function ProviderBadge({ provider }: { provider: AiProvider }): VNode {
  return <span style={badgeStyle(provider.local)}>{label(provider)}</span>;
}

/**
 * The same pill, driven by an explicit local/remote flag and free-form label —
 * for settings surfaces that badge a DRAFT configuration (the saved provider
 * doesn't exist yet). AiSettings had re-grown four inline copies of this
 * markup, which is exactly the staleness this module exists to prevent.
 */
export function ScopeBadge({ local, children }: { local: boolean; children: ComponentChildren }): VNode {
  return <span style={badgeStyle(local)}>{children}</span>;
}
